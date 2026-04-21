import { channel } from "node:diagnostics_channel";
import type {
  FileSystem,
  FileSystemDirent,
  FsStat,
  BufferEncoding,
  CpOptions,
  MkdirOptions,
  RmOptions
} from "./fs/interface";
import type { SqlBackend, SqlParam, SqlSource } from "./filesystem";

export type VersionedFileSystemChangeType = "create" | "update" | "delete";

export type VersionedFileSystemChangeEvent = {
  type: VersionedFileSystemChangeType;
  version: string;
  path: string;
  entryType: EntryType;
};

export interface FileSystemStorageOptions {
  sql: SqlSource;
  r2?: R2Bucket;
  r2Prefix?: string;
  inlineThreshold?: number;
  name?: string | (() => string | undefined);
  onChange?: (event: VersionedFileSystemChangeEvent) => void;
}

type EntryType = "file" | "directory" | "symlink";
type BlobStorageBackend = "inline" | "r2";

type FileRow = {
  version: string;
  path: string;
  parent_path: string;
  name: string;
  type: EntryType;
  mime_type: string;
  size: number;
  target: string | null;
  content_encoding: BufferEncoding;
  content_hash: string | null;
  created_at: number;
  modified_at: number;
};

type ContentRow = {
  hash: string;
  size: number;
  storage_backend: BlobStorageBackend;
  r2_key: string | null;
  content: string | null;
  created_at: number;
};

const DEFAULT_INLINE_THRESHOLD = 1_500_000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MAX_SYMLINK_DEPTH = 40;
const LIKE_ESCAPE = "\\";
const MAX_PATH_LENGTH = 4096;
const MAX_SYMLINK_TARGET_LENGTH = 4096;

const VERSIONS_TABLE = "cf_filesystem_versions";
const FILES_TABLE = "cf_filesystem_files";
const CONTENTS_TABLE = "cf_filesystem_contents";
const FILES_PARENT_INDEX = "cf_filesystem_files_parent";
const FILES_TYPE_INDEX = "cf_filesystem_files_type";

const versionedFileSystemChannel = channel("agents:versioned-filesystem");

function isSqlStorage(src: SqlSource): src is SqlStorage {
  return typeof src === "object" && src !== null && "databaseSize" in src;
}

function isD1Database(src: SqlSource): src is D1Database {
  return (
    typeof src === "object" &&
    src !== null &&
    "prepare" in src &&
    "batch" in src
  );
}

function toBackend(src: SqlSource): SqlBackend {
  if (isSqlStorage(src)) {
    const storage = src;
    return {
      query(sql: string, ...params: SqlParam[]) {
        return [...storage.exec(sql, ...params)] as never;
      },
      run(sql: string, ...params: SqlParam[]) {
        storage.exec(sql, ...params);
      }
    };
  }
  if (isD1Database(src)) {
    const db = src;
    return {
      async query(sql: string, ...params: SqlParam[]) {
        const result = await db
          .prepare(sql)
          .bind(...params)
          .all();
        return result.results as never;
      },
      async run(sql: string, ...params: SqlParam[]) {
        await db
          .prepare(sql)
          .bind(...params)
          .run();
      }
    };
  }
  return src;
}

export class FileSystemStorage {
  readonly sql: SqlBackend;
  private readonly r2: R2Bucket | null;
  private readonly r2Prefix: string | undefined;
  private readonly threshold: number;
  private readonly onChange:
    | ((event: VersionedFileSystemChangeEvent) => void)
    | undefined;
  private readonly _nameOrFn: string | (() => string | undefined) | undefined;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: FileSystemStorageOptions) {
    this.sql = toBackend(options.sql);
    this.r2 = options.r2 ?? null;
    this.r2Prefix = options.r2Prefix;
    this.threshold = options.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
    this.onChange = options.onChange;
    this._nameOrFn = options.name;
  }

  private get name(): string | undefined {
    const value = this._nameOrFn;
    return typeof value === "function" ? value() : value;
  }

  async getVersion(name: string): Promise<VersionedFileSystem> {
    await this.ensureInit();
    await this.assertVersionExists(name);
    return new VersionedFileSystem(this, name);
  }

  async createVersion(name: string): Promise<void> {
    await this.ensureInit();
    validateVersionName(name);

    if (await this.versionExists(name)) {
      throw eexist(`version already exists: ${name}`);
    }

    const now = nowSeconds();
    await this.sql.run(
      `INSERT INTO ${VERSIONS_TABLE} (name, created_at) VALUES (?, ?)`,
      name,
      now
    );
    await this.sql.run(
      `INSERT INTO ${FILES_TABLE}
        (version, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at)
      VALUES (?, '/', '', '', 'directory', 'text/plain', 0, NULL, 'utf8', NULL, ?, ?)`,
      name,
      now,
      now
    );

    this.emit("create", name, "/", "directory");
    this.observe("versioned-filesystem:create-version", {
      version: name
    });
  }

  async copyVersion(sourceName: string, destName: string): Promise<void> {
    await this.ensureInit();
    validateVersionName(sourceName);
    validateVersionName(destName);

    await this.assertVersionExists(sourceName);
    if (await this.versionExists(destName)) {
      throw eexist(`version already exists: ${destName}`);
    }

    const now = nowSeconds();
    await this.sql.run(
      `INSERT INTO ${VERSIONS_TABLE} (name, created_at) VALUES (?, ?)`,
      destName,
      now
    );
    await this.sql.run(
      `INSERT INTO ${FILES_TABLE}
        (version, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at)
      SELECT ?, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at
      FROM ${FILES_TABLE}
      WHERE version = ?`,
      destName,
      sourceName
    );

    this.observe("versioned-filesystem:copy-version", {
      sourceVersion: sourceName,
      destVersion: destName
    });
  }

  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      await this.sql.run(`
        CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (
          name       TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        )
      `);
      await this.sql.run(`
        CREATE TABLE IF NOT EXISTS ${FILES_TABLE} (
          version          TEXT NOT NULL,
          path             TEXT NOT NULL,
          parent_path      TEXT NOT NULL,
          name             TEXT NOT NULL,
          type             TEXT NOT NULL CHECK(type IN ('file','directory','symlink')),
          mime_type        TEXT NOT NULL DEFAULT 'text/plain',
          size             INTEGER NOT NULL DEFAULT 0,
          target           TEXT,
          content_encoding TEXT NOT NULL DEFAULT 'utf8',
          content_hash     TEXT,
          created_at       INTEGER NOT NULL,
          modified_at      INTEGER NOT NULL,
          PRIMARY KEY (version, path)
        )
      `);
      await this.sql.run(
        `CREATE INDEX IF NOT EXISTS ${FILES_PARENT_INDEX} ON ${FILES_TABLE}(version, parent_path)`
      );
      await this.sql.run(
        `CREATE INDEX IF NOT EXISTS ${FILES_TYPE_INDEX} ON ${FILES_TABLE}(version, type)`
      );
      await this.sql.run(`
        CREATE TABLE IF NOT EXISTS ${CONTENTS_TABLE} (
          hash            TEXT PRIMARY KEY,
          size            INTEGER NOT NULL,
          storage_backend TEXT NOT NULL CHECK(storage_backend IN ('inline','r2')),
          r2_key          TEXT,
          content         TEXT,
          created_at      INTEGER NOT NULL
        )
      `);
      this.initialized = true;
      this.initPromise = null;
    })();

    await this.initPromise;
  }

  async versionExists(name: string): Promise<boolean> {
    const rows = await this.sql.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${VERSIONS_TABLE} WHERE name = ?`,
      name
    );
    return (rows[0]?.count ?? 0) > 0;
  }

  async assertVersionExists(name: string): Promise<void> {
    if (!(await this.versionExists(name))) {
      throw enoent(`version does not exist: ${name}`);
    }
  }

  emit(
    type: VersionedFileSystemChangeType,
    version: string,
    path: string,
    entryType: EntryType
  ): void {
    this.onChange?.({ type, version, path, entryType });
  }

  observe(type: string, payload: Record<string, unknown>): void {
    versionedFileSystemChannel.publish({
      type,
      name: this.name,
      payload,
      timestamp: Date.now()
    });
  }

  resolveR2Prefix(): string {
    if (this.r2Prefix !== undefined) return this.r2Prefix;
    const name = this.name;
    if (!name) {
      throw new Error(
        "[FileSystemStorage] R2 is configured but no r2Prefix was provided and no name is available. " +
          "Either pass r2Prefix in FileSystemStorageOptions or provide a name."
      );
    }
    return name;
  }

  r2BlobKey(hash: string): string {
    return `${this.resolveR2Prefix()}/blobs/${hash}`;
  }

  async getFileRow(version: string, path: string): Promise<FileRow | null> {
    const rows = await this.sql.query<FileRow>(
      `SELECT
        version,
        path,
        parent_path,
        name,
        type,
        mime_type,
        size,
        target,
        content_encoding,
        content_hash,
        created_at,
        modified_at
      FROM ${FILES_TABLE}
      WHERE version = ? AND path = ?`,
      version,
      path
    );
    return rows[0] ?? null;
  }

  async getContentRow(hash: string): Promise<ContentRow | null> {
    const rows = await this.sql.query<ContentRow>(
      `SELECT hash, size, storage_backend, r2_key, content, created_at
      FROM ${CONTENTS_TABLE}
      WHERE hash = ?`,
      hash
    );
    return rows[0] ?? null;
  }

  async readContentBytes(hash: string): Promise<Uint8Array> {
    const row = await this.getContentRow(hash);
    if (!row) {
      throw corruption(`missing content row for hash ${hash}`);
    }

    if (row.storage_backend === "r2") {
      if (!row.r2_key) {
        throw corruption(`missing R2 key for hash ${hash}`);
      }
      if (!this.r2) {
        throw new Error(
          `Blob ${hash} is stored in R2 but no R2 bucket was provided`
        );
      }
      const object = await this.r2.get(row.r2_key);
      if (!object) {
        throw corruption(`missing R2 blob for hash ${hash}`);
      }
      return new Uint8Array(await object.arrayBuffer());
    }

    if (row.content === null) {
      throw corruption(`missing inline content for hash ${hash}`);
    }
    return base64ToBytes(row.content);
  }

  async ensureContent(bytes: Uint8Array): Promise<{
    hash: string;
    size: number;
    storage: BlobStorageBackend;
  }> {
    const hash = await sha256Hex(bytes);
    const size = bytes.byteLength;
    const existing = await this.getContentRow(hash);
    if (existing) {
      return {
        hash,
        size,
        storage: existing.storage_backend
      };
    }

    const now = nowSeconds();
    if (size >= this.threshold && this.r2) {
      const key = this.r2BlobKey(hash);
      await this.r2.put(key, bytes);
      await this.sql.run(
        `INSERT INTO ${CONTENTS_TABLE}
          (hash, size, storage_backend, r2_key, content, created_at)
        VALUES (?, ?, 'r2', ?, NULL, ?)`,
        hash,
        size,
        key,
        now
      );
      return {
        hash,
        size,
        storage: "r2"
      };
    }

    if (size >= this.threshold && !this.r2) {
      console.warn(
        `[FileSystemStorage] Blob ${hash} is ${size} bytes but no R2 bucket was provided. Storing inline.`
      );
    }

    await this.sql.run(
      `INSERT INTO ${CONTENTS_TABLE}
        (hash, size, storage_backend, r2_key, content, created_at)
      VALUES (?, ?, 'inline', NULL, ?, ?)`,
      hash,
      size,
      bytesToBase64(bytes),
      now
    );
    return {
      hash,
      size,
      storage: "inline"
    };
  }
}

export class VersionedFileSystem implements FileSystem {
  constructor(
    private readonly storage: FileSystemStorage,
    readonly version: string
  ) {}

  async readFile(path: string): Promise<string> {
    const row = await this.requireReadableFile(path);
    const bytes = row.content_hash
      ? await this.storage.readContentBytes(row.content_hash)
      : new Uint8Array(0);
    this.storage.observe("versioned-filesystem:read", {
      version: this.version,
      path: row.path,
      storage: await this.getStorageKind(row.content_hash)
    });
    return TEXT_DECODER.decode(bytes);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const row = await this.requireReadableFile(path);
    const bytes = row.content_hash
      ? await this.storage.readContentBytes(row.content_hash)
      : new Uint8Array(0);
    this.storage.observe("versioned-filesystem:read", {
      version: this.version,
      path: row.path,
      storage: await this.getStorageKind(row.content_hash)
    });
    return bytes;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeEntry(
      path,
      TEXT_ENCODER.encode(content),
      "text/plain",
      "utf8"
    );
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.writeEntry(path, content, "application/octet-stream", "base64");
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const row = await this.storage.getFileRow(this.version, resolved);

    if (!row) {
      if (typeof content === "string") {
        await this.writeFile(path, content);
      } else {
        await this.writeFileBytes(path, content);
      }
      return;
    }

    if (row.type !== "file") {
      throw eisdir(`${path} is a directory`);
    }

    if (typeof content === "string") {
      const existing = await this.readFile(resolved);
      await this.writeFile(resolved, existing + content);
      return;
    }

    const existing = await this.readFileBytes(resolved);
    const combined = new Uint8Array(existing.byteLength + content.byteLength);
    combined.set(existing);
    combined.set(content, existing.byteLength);
    await this.writeFileBytes(resolved, combined);
  }

  async exists(path: string): Promise<boolean> {
    await this.storage.ensureInit();
    const normalized = normalizePath(path);
    return (await this.storage.getFileRow(this.version, normalized)) !== null;
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const row = await this.storage.getFileRow(this.version, resolved);
    if (!row) {
      throw enoent(`no such file or directory: ${path}`);
    }
    return toFsStat(row);
  }

  async lstat(path: string): Promise<FsStat> {
    const row = await this.storage.getFileRow(
      this.version,
      normalizePath(path)
    );
    if (!row) {
      throw enoent(`no such file or directory: ${path}`);
    }
    return toFsStat(row);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.storage.ensureInit();
    const normalized = normalizePath(path);
    if (normalized === "/") return;

    const existing = await this.storage.getFileRow(this.version, normalized);
    if (existing) {
      if (existing.type === "directory" && options?.recursive) return;
      throw eexist(
        existing.type === "directory"
          ? `directory already exists: ${path}`
          : `path exists as a file: ${path}`
      );
    }

    const parentPath = getParent(normalized);
    const parent = await this.storage.getFileRow(this.version, parentPath);
    if (!parent) {
      if (options?.recursive) {
        await this.mkdir(parentPath, { recursive: true });
      } else {
        throw enoent(`parent directory not found: ${parentPath}`);
      }
    } else if (parent.type !== "directory") {
      throw enotdir(`parent is not a directory: ${parentPath}`);
    }

    const now = nowSeconds();
    await this.storage.sql.run(
      `INSERT INTO ${FILES_TABLE}
        (version, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at)
      VALUES (?, ?, ?, ?, 'directory', 'text/plain', 0, NULL, 'utf8', NULL, ?, ?)`,
      this.version,
      normalized,
      parentPath,
      getBasename(normalized),
      now,
      now
    );
    this.storage.emit("create", this.version, normalized, "directory");
    this.storage.observe("versioned-filesystem:mkdir", {
      version: this.version,
      path: normalized,
      recursive: !!options?.recursive
    });
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readDirectory(path);
    return entries.map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    return this.readDirectory(path);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.storage.ensureInit();
    const normalized = normalizePath(path);
    if (normalized === "/") {
      throw eperm("cannot remove root directory");
    }

    const row = await this.storage.getFileRow(this.version, normalized);
    if (!row) {
      if (options?.force) return;
      throw enoent(`no such file or directory: ${path}`);
    }

    if (row.type === "directory") {
      const childCount = await this.childCount(normalized);
      if (childCount > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty: ${path}`);
        }
        await this.deleteDescendants(normalized);
      }
    }

    await this.storage.sql.run(
      `DELETE FROM ${FILES_TABLE} WHERE version = ? AND path = ?`,
      this.version,
      normalized
    );
    this.storage.emit("delete", this.version, normalized, row.type);
    this.storage.observe("versioned-filesystem:rm", {
      version: this.version,
      path: normalized,
      recursive: !!options?.recursive
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.storage.ensureInit();
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcRow = await this.storage.getFileRow(this.version, srcNorm);
    if (!srcRow) {
      throw enoent(`no such file or directory: ${src}`);
    }

    if (srcRow.type === "symlink") {
      await this.symlink(srcRow.target ?? "", destNorm);
      this.storage.observe("versioned-filesystem:cp", {
        version: this.version,
        src: srcNorm,
        dest: destNorm,
        recursive: !!options?.recursive
      });
      return;
    }

    if (srcRow.type === "directory") {
      if (!options?.recursive) {
        throw eisdir(`cannot copy directory without recursive: ${src}`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.storage.sql.query<FileRow>(
        `SELECT
          version,
          path,
          parent_path,
          name,
          type,
          mime_type,
          size,
          target,
          content_encoding,
          content_hash,
          created_at,
          modified_at
        FROM ${FILES_TABLE}
        WHERE version = ? AND parent_path = ?
        ORDER BY type ASC, name ASC`,
        this.version,
        srcNorm
      );
      for (const child of children) {
        await this.cp(child.path, `${destNorm}/${child.name}`, options);
      }
      this.storage.observe("versioned-filesystem:cp", {
        version: this.version,
        src: srcNorm,
        dest: destNorm,
        recursive: true
      });
      return;
    }

    await this.ensureParentDir(getParent(destNorm));
    await this.deleteFileLikeDestinationIfNeeded(destNorm);
    const now = nowSeconds();
    await this.storage.sql.run(
      `INSERT INTO ${FILES_TABLE}
        (version, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at)
      VALUES (?, ?, ?, ?, 'file', ?, ?, NULL, ?, ?, ?, ?)`,
      this.version,
      destNorm,
      getParent(destNorm),
      getBasename(destNorm),
      srcRow.mime_type,
      srcRow.size,
      srcRow.content_encoding,
      srcRow.content_hash,
      now,
      now
    );
    this.storage.emit("create", this.version, destNorm, "file");
    this.storage.observe("versioned-filesystem:cp", {
      version: this.version,
      src: srcNorm,
      dest: destNorm,
      recursive: !!options?.recursive
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.storage.ensureInit();
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    if (srcNorm === destNorm) {
      return;
    }
    const srcRow = await this.storage.getFileRow(this.version, srcNorm);
    if (!srcRow) {
      throw enoent(`no such file or directory: ${src}`);
    }

    if (srcRow.type === "directory") {
      await this.cp(srcNorm, destNorm, { recursive: true });
      await this.rm(srcNorm, { recursive: true, force: true });
      return;
    }

    await this.ensureParentDir(getParent(destNorm));
    const existingDest = await this.storage.getFileRow(this.version, destNorm);
    if (existingDest) {
      if (existingDest.type === "directory") {
        throw eisdir(`cannot overwrite directory: ${dest}`);
      }
      await this.storage.sql.run(
        `DELETE FROM ${FILES_TABLE} WHERE version = ? AND path = ?`,
        this.version,
        destNorm
      );
      this.storage.emit("delete", this.version, destNorm, existingDest.type);
    }

    await this.storage.sql.run(
      `UPDATE ${FILES_TABLE} SET
        path = ?,
        parent_path = ?,
        name = ?,
        modified_at = ?
      WHERE version = ? AND path = ?`,
      destNorm,
      getParent(destNorm),
      getBasename(destNorm),
      nowSeconds(),
      this.version,
      srcNorm
    );
    this.storage.emit("delete", this.version, srcNorm, srcRow.type);
    this.storage.emit("create", this.version, destNorm, srcRow.type);
    this.storage.observe("versioned-filesystem:mv", {
      version: this.version,
      src: srcNorm,
      dest: destNorm
    });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.storage.ensureInit();
    if (!target || target.trim().length === 0) {
      throw einval("symlink target must not be empty");
    }
    if (target.length > MAX_SYMLINK_TARGET_LENGTH) {
      throw new Error(
        `ENAMETOOLONG: symlink target exceeds ${MAX_SYMLINK_TARGET_LENGTH} characters`
      );
    }

    const normalized = normalizePath(linkPath);
    if (normalized === "/") {
      throw eperm("cannot create symlink at root");
    }

    await this.ensureParentDir(getParent(normalized));
    const existing = await this.storage.getFileRow(this.version, normalized);
    if (existing) {
      throw eexist(`path already exists: ${linkPath}`);
    }

    const now = nowSeconds();
    await this.storage.sql.run(
      `INSERT INTO ${FILES_TABLE}
        (version, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at)
      VALUES (?, ?, ?, ?, 'symlink', 'text/plain', 0, ?, 'utf8', NULL, ?, ?)`,
      this.version,
      normalized,
      getParent(normalized),
      getBasename(normalized),
      target,
      now,
      now
    );
    this.storage.emit("create", this.version, normalized, "symlink");
  }

  async readlink(path: string): Promise<string> {
    const row = await this.storage.getFileRow(
      this.version,
      normalizePath(path)
    );
    if (!row) {
      throw enoent(`no such file or directory: ${path}`);
    }
    if (row.type !== "symlink" || !row.target) {
      throw einval(`not a symlink: ${path}`);
    }
    return row.target;
  }

  async realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const row = await this.storage.getFileRow(this.version, normalized);
    if (!row) {
      throw enoent(`no such file or directory: ${path}`);
    }
    if (row.type !== "symlink") {
      return normalized;
    }
    return this.resolveSymlink(normalized);
  }

  resolvePath(base: string, path: string): string {
    return normalizePath(path.startsWith("/") ? path : `${base}/${path}`);
  }

  async glob(pattern: string): Promise<string[]> {
    await this.storage.ensureInit();
    const normalized = normalizePath(pattern);
    const prefix = getGlobPrefix(normalized);
    const likePattern = escapeLike(prefix) + "%";
    const regex = globToRegex(normalized);
    const rows = await this.storage.sql.query<{ path: string }>(
      `SELECT path
      FROM ${FILES_TABLE}
      WHERE version = ? AND path LIKE ? ESCAPE ?
      ORDER BY path`,
      this.version,
      likePattern,
      LIKE_ESCAPE
    );
    return rows.map((row) => row.path).filter((path) => regex.test(path));
  }

  private async writeEntry(
    path: string,
    bytes: Uint8Array,
    mimeType: string,
    contentEncoding: BufferEncoding
  ): Promise<void> {
    await this.storage.ensureInit();
    const normalized = await this.resolveSymlink(normalizePath(path));
    if (normalized === "/") {
      throw eisdir("cannot write to root directory");
    }

    await this.ensureParentDir(getParent(normalized));
    const existing = await this.storage.getFileRow(this.version, normalized);
    if (existing && existing.type !== "file") {
      throw eisdir(`cannot write non-file path: ${path}`);
    }

    const blob = await this.storage.ensureContent(bytes);
    const now = nowSeconds();
    await this.storage.sql.run(
      `INSERT INTO ${FILES_TABLE}
        (version, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at)
      VALUES (?, ?, ?, ?, 'file', ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(version, path) DO UPDATE SET
        mime_type = excluded.mime_type,
        size = excluded.size,
        target = NULL,
        content_encoding = excluded.content_encoding,
        content_hash = excluded.content_hash,
        modified_at = excluded.modified_at`,
      this.version,
      normalized,
      getParent(normalized),
      getBasename(normalized),
      mimeType,
      bytes.byteLength,
      contentEncoding,
      blob.hash,
      now,
      now
    );
    this.storage.emit(
      existing ? "update" : "create",
      this.version,
      normalized,
      "file"
    );
    this.storage.observe("versioned-filesystem:write", {
      version: this.version,
      path: normalized,
      size: bytes.byteLength,
      storage: blob.storage,
      update: !!existing
    });
  }

  private async requireReadableFile(path: string): Promise<FileRow> {
    await this.storage.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const row = await this.storage.getFileRow(this.version, resolved);
    if (!row) {
      throw enoent(`no such file or directory: ${path}`);
    }
    if (row.type !== "file") {
      throw eisdir(`${path} is a directory`);
    }
    return row;
  }

  private async getStorageKind(
    hash: string | null
  ): Promise<BlobStorageBackend | undefined> {
    if (!hash) return undefined;
    const row = await this.storage.getContentRow(hash);
    return row?.storage_backend;
  }

  private async resolveSymlink(path: string, depth = 0): Promise<string> {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new Error(`ELOOP: too many levels of symbolic links: ${path}`);
    }
    const row = await this.storage.getFileRow(this.version, path);
    if (!row || row.type !== "symlink" || !row.target) {
      return path;
    }
    const resolved = row.target.startsWith("/")
      ? normalizePath(row.target)
      : normalizePath(`${getParent(path)}/${row.target}`);
    return this.resolveSymlink(resolved, depth + 1);
  }

  private async ensureParentDir(dirPath: string): Promise<void> {
    if (!dirPath || dirPath === "/") return;

    const row = await this.storage.getFileRow(this.version, dirPath);
    if (row) {
      if (row.type !== "directory") {
        throw enotdir(`${dirPath} is not a directory`);
      }
      return;
    }

    const missing: string[] = [dirPath];
    let current = getParent(dirPath);
    while (current && current !== "/") {
      const currentRow = await this.storage.getFileRow(this.version, current);
      if (currentRow) {
        if (currentRow.type !== "directory") {
          throw enotdir(`${current} is not a directory`);
        }
        break;
      }
      missing.push(current);
      current = getParent(current);
    }

    const now = nowSeconds();
    for (let index = missing.length - 1; index >= 0; index--) {
      const path = missing[index];
      await this.storage.sql.run(
        `INSERT INTO ${FILES_TABLE}
          (version, path, parent_path, name, type, mime_type, size, target, content_encoding, content_hash, created_at, modified_at)
        VALUES (?, ?, ?, ?, 'directory', 'text/plain', 0, NULL, 'utf8', NULL, ?, ?)`,
        this.version,
        path,
        getParent(path),
        getBasename(path),
        now,
        now
      );
      this.storage.emit("create", this.version, path, "directory");
    }
  }

  private async readDirectory(path: string): Promise<FileSystemDirent[]> {
    await this.storage.ensureInit();
    const normalized = normalizePath(path);
    const resolved = await this.resolveSymlink(normalized);
    const row = await this.storage.getFileRow(this.version, resolved);
    if (!row) {
      throw enoent(`no such file or directory: ${path}`);
    }
    if (row.type !== "directory") {
      throw enotdir(`not a directory: ${path}`);
    }

    const rows = await this.storage.sql.query<Pick<FileRow, "name" | "type">>(
      `SELECT name, type
      FROM ${FILES_TABLE}
      WHERE version = ? AND parent_path = ?
      ORDER BY type ASC, name ASC`,
      this.version,
      resolved
    );
    return rows.map((entry) => ({
      name: entry.name,
      type: entry.type
    }));
  }

  private async childCount(path: string): Promise<number> {
    const rows = await this.storage.sql.query<{ count: number }>(
      `SELECT COUNT(*) AS count
      FROM ${FILES_TABLE}
      WHERE version = ? AND parent_path = ?`,
      this.version,
      path
    );
    return rows[0]?.count ?? 0;
  }

  private async deleteDescendants(dirPath: string): Promise<void> {
    const pattern = escapeLike(dirPath) + "/%";
    await this.storage.sql.run(
      `DELETE FROM ${FILES_TABLE}
      WHERE version = ? AND path LIKE ? ESCAPE ?`,
      this.version,
      pattern,
      LIKE_ESCAPE
    );
  }

  private async deleteFileLikeDestinationIfNeeded(path: string): Promise<void> {
    const existing = await this.storage.getFileRow(this.version, path);
    if (!existing) return;
    if (existing.type === "directory") {
      throw eisdir(`cannot overwrite directory: ${path}`);
    }
    await this.storage.sql.run(
      `DELETE FROM ${FILES_TABLE} WHERE version = ? AND path = ?`,
      this.version,
      path
    );
    this.storage.emit("delete", this.version, path, existing.type);
  }
}

function toFsStat(row: Pick<FileRow, "type" | "size" | "modified_at">): FsStat {
  return {
    type: row.type,
    size: row.size,
    mtime: new Date(row.modified_at * 1000)
  };
}

function validateVersionName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw einval("version name must not be empty");
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.byteLength))
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  const hash = new Uint8Array(digest);
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const result = `/${resolved.join("/")}`;
  if (result.length > MAX_PATH_LENGTH) {
    throw new Error(`ENAMETOOLONG: path exceeds ${MAX_PATH_LENGTH} characters`);
  }
  return result;
}

function getParent(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

function getBasename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function getGlobPrefix(pattern: string): string {
  const first = pattern.search(/[*?[{]/);
  if (first === -1) return pattern;
  const before = pattern.slice(0, first);
  const lastSlash = before.lastIndexOf("/");
  return lastSlash >= 0 ? before.slice(0, lastSlash + 1) : "/";
}

function globToRegex(pattern: string): RegExp {
  let index = 0;
  let expression = "^";
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 2;
        if (pattern[index] === "/") {
          expression += "(?:.+/)?";
          index++;
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
        index++;
      }
    } else if (character === "?") {
      expression += "[^/]";
      index++;
    } else if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        expression += "\\[";
        index++;
      } else {
        expression += pattern.slice(index, close + 1);
        index = close + 1;
      }
    } else if (character === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close === -1) {
        expression += "\\{";
        index++;
      } else {
        expression += `(?:${pattern
          .slice(index + 1, close)
          .split(",")
          .join("|")})`;
        index = close + 1;
      }
    } else {
      expression += character.replace(/[.+^$|\\()]/g, "\\$&");
      index++;
    }
  }
  expression += "$";
  return new RegExp(expression);
}

function errorWithCode(
  code: string,
  message: string
): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function enoent(message: string): Error & { code: string } {
  return errorWithCode("ENOENT", message);
}

function eexist(message: string): Error & { code: string } {
  return errorWithCode("EEXIST", message);
}

function eisdir(message: string): Error & { code: string } {
  return errorWithCode("EISDIR", message);
}

function enotdir(message: string): Error & { code: string } {
  return errorWithCode("ENOTDIR", message);
}

function eperm(message: string): Error & { code: string } {
  return errorWithCode("EPERM", message);
}

function einval(message: string): Error & { code: string } {
  return errorWithCode("EINVAL", message);
}

function corruption(message: string): Error {
  return new Error(`ECORRUPT: ${message}`);
}
