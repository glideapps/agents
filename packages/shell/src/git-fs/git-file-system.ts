import * as git from "isomorphic-git";
import { createGlobMatcher, sortPaths } from "../helpers";
import type {
  CpOptions,
  FileContent,
  FileSystem,
  FileSystemDirent,
  FsStat,
  MkdirOptions,
  RmOptions
} from "../fs/interface";
import {
  MAX_SYMLINK_DEPTH,
  dirname,
  normalizePath,
  resolvePath,
  validatePath
} from "../fs/path-utils";
import { createGitFs } from "../git/fs-adapter";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

type GitFileMode = "100644" | "100755";

type GitNode = GitFileNode | GitDirNode | GitSymlinkNode;

interface GitFileNode {
  kind: "file";
  oid?: string;
  mode: GitFileMode;
  size?: number;
  content?: Uint8Array;
}

interface GitDirNode {
  kind: "dir";
  oid?: string;
  loaded: boolean;
  children: Map<string, GitNode>;
}

interface GitSymlinkNode {
  kind: "symlink";
  oid?: string;
  size?: number;
  target?: string;
}

interface Snapshot {
  headOid: string;
  mtime: Date;
  root: GitDirNode;
}

interface LocatedNode {
  node: GitNode;
  parent: GitDirNode;
  key: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitFileSystemOptions {
  storage: FileSystem;
  dir?: string;
  gitdir?: string;
  branchRef?: string;
  identity: GitIdentity;
}

export class GitFileSystem implements FileSystem {
  private readonly storage: FileSystem;
  private readonly dir: string;
  private readonly gitdir: string;
  private readonly branchRef: string;
  private readonly identity: GitIdentity;
  private readonly gitFs: ReturnType<typeof createGitFs>;
  private initPromise: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: GitFileSystemOptions) {
    this.storage = options.storage;
    this.dir = normalizePath(options.dir ?? "/repo");
    this.gitdir = normalizePath(options.gitdir ?? `${this.dir}/.git`);
    this.branchRef = options.branchRef ?? "refs/heads/main";
    this.identity = options.identity;
    this.gitFs = createGitFs(this.storage);
  }

  private normalizePublicPath(path: string, op: string): string {
    validatePath(path, op);
    return normalizePath(path);
  }

  async readFile(path: string): Promise<string> {
    return utf8Decoder.decode(await this.readFileBytes(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "read");
      const snapshot = await this.loadSnapshot();
      if (normalized === "/") {
        throw this.eisdir("read", path);
      }
      const located = await this.locate(
        snapshot.root,
        normalized,
        true,
        "read"
      );
      if (!located) {
        throw this.missing("read", path);
      }
      if (located.node.kind === "dir" || located.node.kind === "symlink") {
        throw this.eisdir("read", path);
      }
      return this.readFileNodeBytes(located.node);
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBytes(path, utf8Encoder.encode(content));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "write");
      const rawPath = path;
      await this.mutate(`write ${normalized}`, async (snapshot) => {
        const targetPath = await this.resolveFinalWritePath(
          snapshot.root,
          rawPath,
          "write"
        );
        if (targetPath === "/") {
          throw this.eisdir("write", rawPath);
        }
        const {
          parent,
          name,
          changed: parentChanged
        } = await this.parentAndName(snapshot.root, targetPath, "write", true);
        await this.loadDir(parent);
        const existing = parent.children.get(name);
        if (existing?.kind === "dir") {
          throw this.eisdir("write", rawPath);
        }

        const mode =
          existing?.kind === "file" && existing.mode === "100755"
            ? "100755"
            : "100644";

        if (existing?.kind === "file") {
          const previous = await this.readFileNodeBytes(existing);
          if (sameBytes(previous, content) && mode === existing.mode) {
            return parentChanged;
          }
        }

        parent.children.set(name, {
          kind: "file",
          mode,
          size: content.length,
          content: new Uint8Array(content)
        });
        return true;
      });
    });
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "append");
      const extra =
        typeof content === "string" ? utf8Encoder.encode(content) : content;
      const rawPath = path;
      await this.mutate(`append ${normalized}`, async (snapshot) => {
        const targetPath = await this.resolveFinalWritePath(
          snapshot.root,
          rawPath,
          "append"
        );
        if (targetPath === "/") {
          throw this.eisdir("write", rawPath);
        }
        const {
          parent,
          name,
          changed: parentChanged
        } = await this.parentAndName(snapshot.root, targetPath, "append", true);
        await this.loadDir(parent);
        const existing = parent.children.get(name);
        if (existing?.kind === "dir") {
          throw this.eisdir("write", rawPath);
        }

        if (!existing) {
          parent.children.set(name, {
            kind: "file",
            mode: "100644",
            size: extra.length,
            content: new Uint8Array(extra)
          });
          return true;
        }

        if (existing.kind !== "file") {
          throw this.eisdir("write", rawPath);
        }

        if (extra.length === 0) {
          return parentChanged;
        }

        const previous = await this.readFileNodeBytes(existing);
        const merged = new Uint8Array(previous.length + extra.length);
        merged.set(previous);
        merged.set(extra, previous.length);
        parent.children.set(name, {
          kind: "file",
          mode: existing.mode,
          size: merged.length,
          content: merged
        });
        return true;
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) {
      return false;
    }
    return this.enqueueMutation(async () => {
      try {
        const normalized = normalizePath(path);
        const snapshot = await this.loadSnapshot();
        if (normalized === "/") {
          return true;
        }
        return (
          (await this.locate(snapshot.root, normalized, true, "access")) !==
          null
        );
      } catch {
        return false;
      }
    });
  }

  async stat(path: string): Promise<FsStat> {
    return this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "stat");
      const snapshot = await this.loadSnapshot();
      if (normalized === "/") {
        return this.toStat(snapshot.mtime, snapshot.root);
      }
      const located = await this.locate(
        snapshot.root,
        normalized,
        true,
        "stat"
      );
      if (!located) {
        throw this.missing("stat", path);
      }
      return this.toStat(snapshot.mtime, located.node);
    });
  }

  async lstat(path: string): Promise<FsStat> {
    return this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "lstat");
      const snapshot = await this.loadSnapshot();
      if (normalized === "/") {
        return this.toStat(snapshot.mtime, snapshot.root);
      }
      const located = await this.locate(
        snapshot.root,
        normalized,
        false,
        "lstat"
      );
      if (!located) {
        throw this.missing("lstat", path);
      }
      return this.toStat(snapshot.mtime, located.node);
    });
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "mkdir");
      if (normalized === "/") {
        if (!options?.recursive) {
          throw this.eexistDir(path);
        }
        await this.ensureInit();
        return;
      }

      if (options?.recursive) {
        await this.mutate(`mkdir -p ${normalized}`, async (snapshot) => {
          const { changed } = await this.navigateToDir(
            snapshot.root,
            normalized,
            "mkdir",
            true
          );
          return changed;
        });
        return;
      }

      await this.mutate(`mkdir ${normalized}`, async (snapshot) => {
        const existing = await this.locate(
          snapshot.root,
          normalized,
          false,
          "mkdir"
        );
        if (existing?.node.kind === "dir") {
          throw this.eexistDir(path);
        }
        if (existing) {
          throw this.eexistFile(path);
        }
        const { parent } = await this.parentAndName(
          snapshot.root,
          normalized,
          "mkdir",
          false
        );
        await this.loadDir(parent);
        const name = baseName(normalized);
        parent.children.set(name, freshDir());
        return true;
      });
    });
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    return this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "scandir");
      const snapshot = await this.loadSnapshot();
      const dir = await this.resolveNode(
        snapshot.root,
        normalized,
        true,
        "scandir"
      );
      if (!dir) {
        throw this.missing("scandir", path);
      }
      if (dir.kind !== "dir") {
        throw this.enotdir(path);
      }
      await this.loadDir(dir);
      const entries = Array.from(dir.children.entries()).map(
        ([name, node]) => ({
          name,
          type: this.nodeType(node)
        })
      );
      return entries.sort((a, b) => compareStrings(a.name, b.name));
    });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.enqueueMutation(async () => {
      validatePath(path, "rm");
      const normalized = normalizePath(path);
      if (normalized === "/") {
        if (options?.force) {
          await this.ensureInit();
          return;
        }
        throw this.epermRoot(path);
      }

      await this.mutate(`rm ${normalized}`, async (snapshot) => {
        let locatedParent: { parent: GitDirNode; name: string };
        try {
          const parent = await this.parentAndName(
            snapshot.root,
            normalized,
            "rm",
            false
          );
          locatedParent = { parent: parent.parent, name: parent.name };
        } catch (error) {
          if (options?.force && isEnoent(error)) {
            return false;
          }
          throw error;
        }

        await this.loadDir(locatedParent.parent);
        const target = locatedParent.parent.children.get(locatedParent.name);
        if (!target) {
          if (options?.force) {
            return false;
          }
          throw this.missing("rm", path);
        }
        if (target.kind === "dir" && !options?.recursive) {
          await this.loadDir(target);
          if (target.children.size > 0) {
            throw this.enotempty(path);
          }
        }
        locatedParent.parent.children.delete(locatedParent.name);
        return true;
      });
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.enqueueMutation(async () => {
      const srcNormalized = this.normalizePublicPath(src, "cp");
      const destNormalized = this.normalizePublicPath(dest, "cp");
      if (destNormalized === "/") {
        throw this.eisdir("write", dest);
      }

      await this.mutate(
        `cp ${srcNormalized} -> ${destNormalized}`,
        async (snapshot) => {
          const source = await this.locate(
            snapshot.root,
            srcNormalized,
            false,
            "cp"
          );
          if (!source) {
            throw this.missing("cp", src);
          }
          if (source.node.kind === "dir" && !options?.recursive) {
            throw this.eisdirDirectory(src);
          }

          const {
            parent,
            name,
            changed: parentChanged
          } = await this.parentAndName(
            snapshot.root,
            destNormalized,
            "cp",
            true
          );
          await this.loadDir(parent);
          const cloned = cloneNode(source.node);
          const existing = parent.children.get(name);
          if (existing && this.sameNode(existing, cloned)) {
            return parentChanged;
          }
          parent.children.set(name, cloned);
          return true;
        }
      );
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcNormalized = this.normalizePublicPath(src, "mv");
    const destNormalized = this.normalizePublicPath(dest, "mv");
    if (destNormalized === "/") {
      throw this.eisdir("write", dest);
    }
    if (srcNormalized === destNormalized) {
      await this.ensureInit();
      return;
    }
    if (destNormalized.startsWith(`${srcNormalized}/`)) {
      throw new Error(`EINVAL: invalid argument, mv '${src}'`);
    }

    return this.enqueueMutation(async () => {
      await this.mutate(
        `mv ${srcNormalized} -> ${destNormalized}`,
        async (snapshot) => {
          const source = await this.locate(
            snapshot.root,
            srcNormalized,
            false,
            "mv"
          );
          if (!source) {
            throw this.missing("mv", src);
          }
          const { parent: destParent, name: destName } =
            await this.parentAndName(snapshot.root, destNormalized, "mv", true);
          await this.loadDir(destParent);
          destParent.children.set(destName, cloneNode(source.node));
          await this.loadDir(source.parent);
          source.parent.children.delete(source.key);
          return true;
        }
      );
    });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(linkPath, "symlink");
      if (normalized === "/") {
        throw this.eexistFile(linkPath);
      }

      await this.mutate(`symlink ${normalized}`, async (snapshot) => {
        const { parent, name } = await this.parentAndName(
          snapshot.root,
          normalized,
          "symlink",
          true
        );
        await this.loadDir(parent);
        if (parent.children.has(name)) {
          throw this.eexistFile(linkPath);
        }
        parent.children.set(name, {
          kind: "symlink",
          size: utf8Encoder.encode(target).length,
          target
        });
        return true;
      });
    });
  }

  async readlink(path: string): Promise<string> {
    return this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "readlink");
      const snapshot = await this.loadSnapshot();
      const located = await this.locate(
        snapshot.root,
        normalized,
        false,
        "readlink"
      );
      if (!located) {
        throw this.missing("readlink", path);
      }
      if (located.node.kind !== "symlink") {
        throw this.einvalReadlink(path);
      }
      return this.readSymlinkTarget(located.node);
    });
  }

  async realpath(path: string): Promise<string> {
    return this.enqueueMutation(async () => {
      const normalized = this.normalizePublicPath(path, "realpath");
      const snapshot = await this.loadSnapshot();
      const canon = await this.canonicalize(
        snapshot.root,
        normalized,
        "realpath"
      );
      if (canon === null) {
        throw this.missing("realpath", path);
      }
      return canon;
    });
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    return this.enqueueMutation(async () => {
      const snapshot = await this.loadSnapshot();
      const matcher = createGlobMatcher(pattern);
      const hits: string[] = [];
      await this.gather(snapshot.root, "", matcher, hits);
      return sortPaths(hits);
    });
  }

  private async ensureInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      if (await this.storage.exists(`${this.gitdir}/HEAD`)) {
        return;
      }

      await git.init({
        fs: this.gitFs,
        dir: this.dir,
        gitdir: this.gitdir,
        defaultBranch: this.defaultBranchName()
      });

      const tree = await git.writeTree({
        fs: this.gitFs,
        dir: this.dir,
        gitdir: this.gitdir,
        tree: []
      });
      const signature = this.gitSignature();
      const commit = await git.writeCommit({
        fs: this.gitFs,
        dir: this.dir,
        gitdir: this.gitdir,
        commit: {
          message: "init",
          tree,
          parent: [],
          author: signature,
          committer: signature
        }
      });

      await git.writeRef({
        fs: this.gitFs,
        dir: this.dir,
        gitdir: this.gitdir,
        ref: this.branchRef,
        value: commit,
        force: true
      });
      await git.writeRef({
        fs: this.gitFs,
        dir: this.dir,
        gitdir: this.gitdir,
        ref: "HEAD",
        value: this.branchRef,
        force: true,
        symbolic: true
      });
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async loadSnapshot(): Promise<Snapshot> {
    await this.ensureInit();
    const headOid = await git.resolveRef({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      ref: this.branchRef
    });
    const { commit } = await git.readCommit({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      oid: headOid
    });
    return {
      headOid,
      mtime: new Date(commit.committer.timestamp * 1000),
      root: {
        kind: "dir",
        oid: commit.tree,
        loaded: false,
        children: new Map()
      }
    };
  }

  private async mutate(
    message: string,
    apply: (snapshot: Snapshot) => Promise<boolean> | boolean
  ): Promise<void> {
    const snapshot = await this.loadSnapshot();
    const previousTreeOid = snapshot.root.oid;
    const changed = await apply(snapshot);
    if (!changed) {
      return;
    }
    const tree = await this.writeDir(snapshot.root);
    if (tree === previousTreeOid) {
      return;
    }
    const signature = this.gitSignature();
    const commit = await git.writeCommit({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      commit: {
        message,
        tree,
        parent: [snapshot.headOid],
        author: signature,
        committer: signature
      }
    });
    await git.writeRef({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      ref: this.branchRef,
      value: commit,
      force: true
    });
  }

  private async loadDir(dir: GitDirNode): Promise<void> {
    if (dir.loaded) {
      return;
    }
    dir.children.clear();
    if (!dir.oid) {
      dir.loaded = true;
      return;
    }
    const result = await git.readTree({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      oid: dir.oid
    });
    for (const entry of result.tree) {
      dir.children.set(entry.path, this.entryToNode(entry));
    }
    dir.loaded = true;
  }

  private entryToNode(entry: git.TreeEntry): GitNode {
    if (entry.type === "tree" && entry.mode === "040000") {
      return {
        kind: "dir",
        oid: entry.oid,
        loaded: false,
        children: new Map()
      };
    }
    if (entry.type !== "blob") {
      throw new Error(`Unsupported git entry type: ${entry.type}`);
    }
    if (entry.mode === "120000") {
      return { kind: "symlink", oid: entry.oid };
    }
    if (entry.mode === "100755" || entry.mode === "100644") {
      return {
        kind: "file",
        oid: entry.oid,
        mode: entry.mode
      };
    }
    throw new Error(`Unsupported git mode: ${entry.mode}`);
  }

  private async locate(
    root: GitDirNode,
    rawPath: string,
    followLast: boolean,
    op: string
  ): Promise<LocatedNode | null> {
    const normalized = normalizePath(rawPath);
    if (normalized === "/") {
      return null;
    }

    const pending = split(normalized);
    const trail: string[] = [];
    let dir = root;
    let budget = MAX_SYMLINK_DEPTH;

    while (pending.length > 0) {
      const segment = pending.shift();
      if (!segment) {
        continue;
      }
      await this.loadDir(dir);
      const child = dir.children.get(segment);
      if (!child) {
        return null;
      }
      const last = pending.length === 0;

      if (child.kind === "symlink" && (!last || followLast)) {
        budget -= 1;
        if (budget < 0) {
          throw this.eloop(op, rawPath);
        }
        const base = trail.length > 0 ? `/${trail.join("/")}` : "/";
        const target = await this.readSymlinkTarget(child);
        const absolute = target.startsWith("/")
          ? normalizePath(target)
          : normalizePath(`${base}/${target}`);
        pending.unshift(...split(absolute));
        trail.length = 0;
        dir = root;
        continue;
      }

      if (last) {
        return { node: child, parent: dir, key: segment };
      }
      if (child.kind !== "dir") {
        return null;
      }
      trail.push(segment);
      dir = child;
    }

    return null;
  }

  private async resolveNode(
    root: GitDirNode,
    rawPath: string,
    followLast: boolean,
    op: string
  ): Promise<GitNode | null> {
    const normalized = normalizePath(rawPath);
    if (normalized === "/") {
      return root;
    }
    const located = await this.locate(root, normalized, followLast, op);
    return located?.node ?? null;
  }

  private async canonicalize(
    root: GitDirNode,
    rawPath: string,
    op: string
  ): Promise<string | null> {
    const normalized = normalizePath(rawPath);
    if (normalized === "/") {
      return "/";
    }

    const pending = split(normalized);
    const resolved: string[] = [];
    let dir = root;
    let budget = MAX_SYMLINK_DEPTH;

    while (pending.length > 0) {
      const segment = pending.shift();
      if (!segment) {
        continue;
      }
      await this.loadDir(dir);
      const child = dir.children.get(segment);
      if (!child) {
        return null;
      }

      if (child.kind === "symlink") {
        budget -= 1;
        if (budget < 0) {
          throw this.eloop(op, rawPath);
        }
        const base = resolved.length > 0 ? `/${resolved.join("/")}` : "/";
        const target = await this.readSymlinkTarget(child);
        const absolute = target.startsWith("/")
          ? normalizePath(target)
          : normalizePath(`${base}/${target}`);
        pending.unshift(...split(absolute));
        resolved.length = 0;
        dir = root;
        continue;
      }

      resolved.push(segment);
      if (pending.length > 0) {
        if (child.kind !== "dir") {
          return null;
        }
        dir = child;
      }
    }

    return `/${resolved.join("/")}`;
  }

  private async navigateToDir(
    root: GitDirNode,
    rawPath: string,
    op: string,
    createMissing: boolean
  ): Promise<{ dir: GitDirNode; changed: boolean }> {
    const normalized = normalizePath(rawPath);
    if (normalized === "/") {
      return { dir: root, changed: false };
    }

    const pending = split(normalized);
    const trail: string[] = [];
    let dir = root;
    let changed = false;
    let budget = MAX_SYMLINK_DEPTH;

    while (pending.length > 0) {
      const segment = pending.shift();
      if (!segment) {
        continue;
      }
      await this.loadDir(dir);
      let child = dir.children.get(segment);
      if (!child) {
        if (!createMissing) {
          throw this.missing(op, rawPath);
        }
        child = freshDir();
        dir.children.set(segment, child);
        changed = true;
      }

      if (child.kind === "symlink") {
        budget -= 1;
        if (budget < 0) {
          throw this.eloop(op, rawPath);
        }
        const base = trail.length > 0 ? `/${trail.join("/")}` : "/";
        const target = await this.readSymlinkTarget(child);
        const absolute = target.startsWith("/")
          ? normalizePath(target)
          : normalizePath(`${base}/${target}`);
        pending.unshift(...split(absolute));
        trail.length = 0;
        dir = root;
        continue;
      }

      if (child.kind !== "dir") {
        throw this.enotdir(rawPath);
      }

      trail.push(segment);
      dir = child;
    }

    return { dir, changed };
  }

  private async parentAndName(
    root: GitDirNode,
    rawPath: string,
    op: string,
    createParents: boolean
  ): Promise<{ parent: GitDirNode; name: string; changed: boolean }> {
    const normalized = normalizePath(rawPath);
    const name = baseName(normalized);
    if (!name) {
      throw this.eisdir(op, rawPath);
    }
    const parentPath = dirname(normalized);
    const { dir, changed } = await this.navigateToDir(
      root,
      parentPath,
      op,
      createParents
    );
    return { parent: dir, name, changed };
  }

  private async resolveFinalWritePath(
    root: GitDirNode,
    rawPath: string,
    op: string
  ): Promise<string> {
    const normalized = normalizePath(rawPath);
    if (normalized === "/") {
      return "/";
    }
    const located = await this.locate(root, normalized, false, op);
    if (located?.node.kind === "symlink") {
      const target = await this.canonicalize(root, normalized, op);
      if (target === null) {
        throw this.missing(op, rawPath);
      }
      return target;
    }
    return normalized;
  }

  private async readFileNodeBytes(node: GitFileNode): Promise<Uint8Array> {
    if (node.content !== undefined) {
      return node.content;
    }
    if (!node.oid) {
      return new Uint8Array();
    }
    const { blob } = await git.readBlob({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      oid: node.oid
    });
    node.size = blob.length;
    return blob;
  }

  private async readSymlinkTarget(node: GitSymlinkNode): Promise<string> {
    if (node.target !== undefined) {
      return node.target;
    }
    if (!node.oid) {
      return "";
    }
    const { blob } = await git.readBlob({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      oid: node.oid
    });
    node.size = blob.length;
    return utf8Decoder.decode(blob);
  }

  private async toStat(mtime: Date, node: GitNode): Promise<FsStat> {
    switch (node.kind) {
      case "dir":
        return {
          type: "directory",
          size: 0,
          mtime,
          mode: 0o040000
        };
      case "symlink": {
        const target = await this.readSymlinkTarget(node);
        return {
          type: "symlink",
          size: utf8Encoder.encode(target).length,
          mtime,
          mode: 0o120000
        };
      }
      case "file": {
        const bytes = await this.readFileNodeBytes(node);
        return {
          type: "file",
          size: bytes.length,
          mtime,
          mode: node.mode === "100755" ? 0o100755 : 0o100644
        };
      }
    }
  }

  private async gather(
    dir: GitDirNode,
    prefix: string,
    matcher: RegExp,
    hits: string[]
  ): Promise<void> {
    await this.loadDir(dir);
    const names = Array.from(dir.children.keys()).sort(compareStrings);
    for (const name of names) {
      const child = dir.children.get(name);
      if (!child) {
        continue;
      }
      const full = prefix ? `${prefix}/${name}` : `/${name}`;
      if (matcher.test(full)) {
        hits.push(full);
      }
      if (child.kind === "dir") {
        await this.gather(child, full, matcher, hits);
      }
    }
  }

  private async writeDir(dir: GitDirNode): Promise<string> {
    if (dir.oid && !dir.loaded) {
      return dir.oid;
    }
    await this.loadDir(dir);
    const entries: git.TreeObject = [];
    const names = Array.from(dir.children.keys()).sort(compareStrings);
    for (const name of names) {
      const child = dir.children.get(name);
      if (!child) {
        continue;
      }
      if (child.kind === "dir") {
        const oid = await this.writeDir(child);
        entries.push({ path: name, oid, type: "tree", mode: "040000" });
        continue;
      }
      if (child.kind === "symlink") {
        let oid = child.oid;
        if (!oid || child.target !== undefined) {
          const blob = utf8Encoder.encode(child.target ?? "");
          oid = await git.writeBlob({
            fs: this.gitFs,
            dir: this.dir,
            gitdir: this.gitdir,
            blob
          });
          child.oid = oid;
          child.size = blob.length;
        }
        entries.push({ path: name, oid, type: "blob", mode: "120000" });
        continue;
      }
      let oid = child.oid;
      if (child.content !== undefined) {
        oid = await git.writeBlob({
          fs: this.gitFs,
          dir: this.dir,
          gitdir: this.gitdir,
          blob: child.content
        });
        child.oid = oid;
        child.size = child.content.length;
        delete child.content;
      }
      if (!oid) {
        throw new Error(`Missing blob oid for file '${name}'`);
      }
      entries.push({ path: name, oid, type: "blob", mode: child.mode });
    }
    const oid = await git.writeTree({
      fs: this.gitFs,
      dir: this.dir,
      gitdir: this.gitdir,
      tree: entries
    });
    dir.oid = oid;
    dir.loaded = false;
    dir.children.clear();
    return oid;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release = () => {};
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .catch(() => undefined)
      .then(() => Promise.resolve().then(operation))
      .finally(() => {
        release();
      });
  }

  private gitSignature() {
    return {
      name: this.identity.name,
      email: this.identity.email,
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: new Date().getTimezoneOffset()
    };
  }

  private defaultBranchName(): string {
    if (this.branchRef.startsWith("refs/heads/")) {
      return this.branchRef.slice("refs/heads/".length);
    }
    return "main";
  }

  private nodeType(node: GitNode): "file" | "directory" | "symlink" {
    if (node.kind === "dir") {
      return "directory";
    }
    if (node.kind === "symlink") {
      return "symlink";
    }
    return "file";
  }

  private sameNode(a: GitNode, b: GitNode): boolean {
    if (a.kind !== b.kind) {
      return false;
    }
    if (a.kind === "dir" && b.kind === "dir") {
      return a.oid !== undefined && a.oid === b.oid;
    }
    if (a.kind === "symlink" && b.kind === "symlink") {
      if (a.target !== undefined || b.target !== undefined) {
        return a.target === b.target;
      }
      return a.oid !== undefined && a.oid === b.oid;
    }
    if (a.kind === "file" && b.kind === "file") {
      if (a.content !== undefined || b.content !== undefined) {
        return (
          a.mode === b.mode &&
          a.content !== undefined &&
          b.content !== undefined &&
          sameBytes(a.content, b.content)
        );
      }
      return a.mode === b.mode && a.oid !== undefined && a.oid === b.oid;
    }
    return false;
  }

  private missing(op: string, path: string): Error {
    return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
  }

  private eisdir(op: string, path: string): Error {
    return new Error(
      `EISDIR: illegal operation on a directory, ${op} '${path}'`
    );
  }

  private eisdirDirectory(path: string): Error {
    return new Error(`EISDIR: is a directory, cp '${path}'`);
  }

  private enotdir(path: string): Error {
    return new Error(`ENOTDIR: not a directory, scandir '${path}'`);
  }

  private enotempty(path: string): Error {
    return new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
  }

  private eexistDir(path: string): Error {
    return new Error(`EEXIST: directory already exists, mkdir '${path}'`);
  }

  private eexistFile(path: string): Error {
    return new Error(`EEXIST: file already exists, symlink '${path}'`);
  }

  private epermRoot(path: string): Error {
    return new Error(`EPERM: cannot remove root, rm '${path}'`);
  }

  private einvalReadlink(path: string): Error {
    return new Error(`EINVAL: invalid argument, readlink '${path}'`);
  }

  private eloop(op: string, path: string): Error {
    return new Error(
      `ELOOP: too many levels of symbolic links, ${op} '${path}'`
    );
  }
}

function freshDir(): GitDirNode {
  return {
    kind: "dir",
    loaded: true,
    children: new Map()
  };
}

function cloneNode(node: GitNode): GitNode {
  switch (node.kind) {
    case "dir":
      return {
        kind: "dir",
        oid: node.oid,
        loaded: false,
        children: new Map()
      };
    case "symlink":
      return {
        kind: "symlink",
        oid: node.oid,
        size: node.size,
        target: node.target
      };
    case "file":
      return {
        kind: "file",
        oid: node.oid,
        mode: node.mode,
        size: node.size,
        content:
          node.content !== undefined ? new Uint8Array(node.content) : undefined
      };
  }
}

function split(normalized: string): string[] {
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}

function baseName(normalized: string): string {
  if (normalized === "/") {
    return "";
  }
  const index = normalized.lastIndexOf("/");
  return normalized.slice(index + 1);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ENOENT");
}

export type { FileContent };
