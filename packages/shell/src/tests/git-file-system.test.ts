import { describe, expect, it } from "vitest";
import * as git from "isomorphic-git";
import { InMemoryFs } from "../fs/in-memory-fs";
import { GitFileSystem } from "../git-fs/git-file-system";
import { createGitFs } from "../git/fs-adapter";
import { defineFileSystemBehaviorSuite } from "./file-system-behavior-suite";

const identity = {
  name: "Test User",
  email: "test@example.com"
};

function createFs(storage = new InMemoryFs()) {
  return new GitFileSystem({ storage, identity });
}

function repoFs(storage: InMemoryFs) {
  return createGitFs(storage);
}

async function repoLog(storage: InMemoryFs, depth = 20) {
  return git.log({ fs: repoFs(storage), dir: "/repo", depth });
}

async function readHeadTree(storage: InMemoryFs) {
  const fs = repoFs(storage);
  const oid = await git.resolveRef({ fs, dir: "/repo", ref: "HEAD" });
  const { commit } = await git.readCommit({ fs, dir: "/repo", oid });
  return git.readTree({ fs, dir: "/repo", oid: commit.tree });
}

async function seedExecutableRepo(storage: InMemoryFs) {
  const fs = repoFs(storage);
  const dir = "/repo";
  const gitdir = "/repo/.git";
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  await git.init({ fs, dir, gitdir, defaultBranch: "main" });

  const blob = await git.writeBlob({
    fs,
    dir,
    gitdir,
    blob: encoder.encode("echo hi\n")
  });
  const tree = await git.writeTree({
    fs,
    dir,
    gitdir,
    tree: [{ path: "script.sh", mode: "100755", oid: blob, type: "blob" }]
  });
  const commit = await git.writeCommit({
    fs,
    dir,
    gitdir,
    commit: {
      message: "seed",
      tree,
      parent: [],
      author: {
        name: identity.name,
        email: identity.email,
        timestamp: now,
        timezoneOffset: 0
      },
      committer: {
        name: identity.name,
        email: identity.email,
        timestamp: now,
        timezoneOffset: 0
      }
    }
  });

  await git.writeRef({
    fs,
    dir,
    gitdir,
    ref: "refs/heads/main",
    value: commit,
    force: true
  });
  await git.writeRef({
    fs,
    dir,
    gitdir,
    ref: "HEAD",
    value: "refs/heads/main",
    force: true,
    symbolic: true
  });
}

defineFileSystemBehaviorSuite(
  "GitFileSystem — FileSystem behavior",
  async () => {
    const storage = new InMemoryFs();
    return {
      fs: createFs(storage),
      reload: () => createFs(storage)
    };
  }
);

describe("GitFileSystem — git-specific semantics", () => {
  it("auto-initializes a repo with a symbolic HEAD and empty initial commit", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await expect(fs.readdir("/")).resolves.toEqual([]);
    await expect(storage.readFile("/repo/.git/HEAD")).resolves.toContain(
      "ref: refs/heads/main"
    );

    const log = await repoLog(storage);
    expect(log).toHaveLength(1);
    expect(log[0].commit.parent).toEqual([]);
  });

  it("does not create a commit for a no-op write", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.writeFile("/same.txt", "unchanged");
    const before = await repoLog(storage);

    await fs.writeFile("/same.txt", "unchanged");
    const after = await repoLog(storage);

    expect(after).toHaveLength(before.length);
  });

  it("appends content in a single additional commit", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.writeFile("/log.txt", "a");
    const before = await repoLog(storage);

    await fs.appendFile("/log.txt", "b");

    await expect(fs.readFile("/log.txt")).resolves.toBe("ab");
    const after = await repoLog(storage);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0].commit.message.trim()).toBe("append /log.txt");
  });

  it("cp creates a single commit for recursive copies", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.writeFile("/src/file.txt", "data");
    await fs.symlink("file.txt", "/src/link.txt");
    await fs.mkdir("/src/empty", { recursive: true });
    const before = await repoLog(storage);

    await fs.cp("/src", "/copy", { recursive: true });

    const after = await repoLog(storage);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0].commit.message.trim()).toBe("cp /src -> /copy");
  });

  it("rm creates a single commit for recursive deletes", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.writeFile("/tmp/a.txt", "a");
    await fs.writeFile("/tmp/b.txt", "b");
    const before = await repoLog(storage);

    await fs.rm("/tmp", { recursive: true });

    const after = await repoLog(storage);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0].commit.message.trim()).toBe("rm /tmp");
  });

  it("rm with force on a missing path is a no-op without a commit", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.readdir("/");
    const before = await repoLog(storage);

    await fs.rm("/nope", { force: true, recursive: true });

    const after = await repoLog(storage);
    expect(after).toHaveLength(before.length);
  });

  it("mkdir -p on an existing directory is a no-op without a commit", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.mkdir("/a/b", { recursive: true });
    const before = await repoLog(storage);

    await fs.mkdir("/a/b", { recursive: true });

    const after = await repoLog(storage);
    expect(after).toHaveLength(before.length);
  });

  it("mv to the same path is a no-op without a commit", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.writeFile("/same.txt", "x");
    const before = await repoLog(storage);

    await fs.mv("/same.txt", "/same.txt");

    const after = await repoLog(storage);
    expect(after).toHaveLength(before.length);
    await expect(fs.readFile("/same.txt")).resolves.toBe("x");
  });

  it("preserves executable mode when rewriting an existing executable file", async () => {
    const storage = new InMemoryFs();
    await seedExecutableRepo(storage);
    const fs = createFs(storage);

    await fs.writeFile("/script.sh", "echo bye\n");

    const tree = await readHeadTree(storage);
    const entry = tree.tree.find((item) => item.path === "script.sh");
    expect(entry?.mode).toBe("100755");
  });

  it("keeps backing repo metadata separate from a visible /.git subtree", async () => {
    const storage = new InMemoryFs();
    const fs = createFs(storage);

    await fs.writeFile("/.git/config", "user data");
    await fs.mkdir("/.git/objects", { recursive: true });
    const before = await repoLog(storage);

    await fs.rm("/.git", { recursive: true });

    await expect(fs.exists("/.git")).resolves.toBe(false);
    await expect(storage.readFile("/repo/.git/HEAD")).resolves.toContain(
      "ref: refs/heads/main"
    );

    const after = await repoLog(storage);
    expect(after).toHaveLength(before.length + 1);
  });
});
