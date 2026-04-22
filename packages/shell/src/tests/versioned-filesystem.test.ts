import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { FileSystemDirent, FsStat } from "../fs/interface";
import type { VersionedFileSystemChangeEvent } from "../versioned-filesystem";

async function freshAgent(name: string) {
  return getAgentByName(env.TestVersionedFileSystemAgent, name);
}

async function expectAgentError(
  agent: Awaited<ReturnType<typeof freshAgent>>,
  method: string,
  args: unknown[],
  pattern: RegExp
) {
  await expect(agent.callAndCaptureError(method, args)).resolves.toEqual({
    error: expect.stringMatching(pattern)
  });
}

describe("VersionedFileSystem — version lifecycle", () => {
  it("creates empty versions, gets existing versions, and throws for missing versions", async () => {
    const agent = await freshAgent("version-lifecycle-basic");

    await agent.createVersion("main");
    await expect(agent.getVersion("main")).resolves.toBe("ok");

    const versionRows = await agent.queryVersionRows();
    expect(versionRows.map((row) => row.name)).toEqual(["main"]);

    const fileRows = await agent.queryFileRows("main");
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]).toMatchObject({
      version: "main",
      path: "/",
      type: "directory",
      parent_path: "",
      name: ""
    });

    await expectAgentError(
      agent,
      "getVersion",
      ["missing"],
      /ENOENT: .*missing/
    );
  });

  it("throws when creating or copying to an existing version", async () => {
    const agent = await freshAgent("version-lifecycle-errors");

    await agent.createVersion("main");
    await expectAgentError(agent, "createVersion", ["main"], /EEXIST: .*main/);

    await agent.write("main", "/hello.txt", "hello");
    await agent.copyVersion("main", "copy");
    await expectAgentError(
      agent,
      "copyVersion",
      ["main", "copy"],
      /EEXIST: .*copy/
    );
    await expectAgentError(
      agent,
      "copyVersion",
      ["missing", "other"],
      /ENOENT: .*missing/
    );
  });

  it("copies versions by duplicating file rows, preserving timestamps, and isolating later changes", async () => {
    const agent = await freshAgent("version-copy");

    await agent.createVersion("src");
    await agent.mkdir("src", "/dir", true);
    await agent.write("src", "/dir/file.txt", "alpha");
    await agent.symlink("src", "/dir/file.txt", "/dir/link.txt");

    const beforeRows = await agent.queryFileRows("src");
    const sourceFileBefore = await agent.queryFileRow("src", "/dir/file.txt");

    await agent.copyVersion("src", "dest");

    const afterRows = await agent.queryFileRows("dest");
    expect(afterRows).toHaveLength(beforeRows.length);
    expect(afterRows.map((row) => row.path)).toEqual(
      beforeRows.map((row) => row.path)
    );

    const destFile = await agent.queryFileRow("dest", "/dir/file.txt");
    expect(destFile?.created_at).toBe(sourceFileBefore?.created_at);
    expect(destFile?.modified_at).toBe(sourceFileBefore?.modified_at);
    expect(destFile?.content_hash).toBe(sourceFileBefore?.content_hash);

    await agent.write("dest", "/dir/file.txt", "beta");
    expect(await agent.read("src", "/dir/file.txt")).toBe("alpha");
    expect(await agent.read("dest", "/dir/file.txt")).toBe("beta");
  });
});

describe("VersionedFileSystem — content-addressed storage", () => {
  it("deduplicates content across files, versions, and text/bytes writes", async () => {
    const agent = await freshAgent("content-dedup");

    await agent.createVersion("a");
    await agent.createVersion("b");
    await agent.write("a", "/one.txt", "same");
    await agent.write("a", "/two.txt", "same");
    await agent.writeBytes("b", "/three.bin", [115, 97, 109, 101]);

    expect(await agent.queryBlobCount()).toBe(1);

    const aOne = await agent.queryFileRow("a", "/one.txt");
    const aTwo = await agent.queryFileRow("a", "/two.txt");
    const bThree = await agent.queryFileRow("b", "/three.bin");
    expect(aOne?.content_hash).toBeTruthy();
    expect(aOne?.content_hash).toBe(aTwo?.content_hash);
    expect(aOne?.content_hash).toBe(bThree?.content_hash);
  });

  it("leaves old blobs intact when overwriting a file with a new hash", async () => {
    const agent = await freshAgent("content-overwrite");

    await agent.createVersion("main");
    await agent.write("main", "/file.txt", "one");
    const firstRow = await agent.queryFileRow("main", "/file.txt");

    await agent.write("main", "/file.txt", "two");
    const secondRow = await agent.queryFileRow("main", "/file.txt");

    expect(firstRow?.content_hash).not.toBe(secondRow?.content_hash);
    expect(await agent.queryBlobCount()).toBe(2);
  });

  it("stores large blobs in R2 with hash-based keys and reuses them across files and versions", async () => {
    const agent = await freshAgent("r2-overflow");

    await agent.createVersionWithR2("v1");
    await agent.createVersionWithR2("v2");
    await agent.writeWithR2("v1", "/big.txt", "0123456789abcdef");
    await agent.writeWithR2("v1", "/copy.txt", "0123456789abcdef");
    await agent.writeWithR2("v2", "/other.txt", "0123456789abcdef");

    const blobs = await agent.queryContentRows();
    expect(blobs).toHaveLength(1);
    expect(blobs[0].storage_backend).toBe("r2");
    expect(blobs[0].r2_key).toMatch(
      /^agent\/r2-overflow\/blobs\/[a-f0-9]{64}$/
    );
    expect(await agent.getMockR2Keys()).toEqual([blobs[0].r2_key]);
  });

  it("falls back to inline blob storage when R2 is not configured", async () => {
    const agent = await freshAgent("inline-fallback");

    await agent.writeBytesNoR2("main", "/big.bin", [1, 2, 3, 4, 5, 6]);

    const blobs = await agent.queryContentRows();
    expect(blobs).toHaveLength(1);
    expect(blobs[0].storage_backend).toBe("inline");
    expect(blobs[0].r2_key).toBeNull();
    expect(await agent.readBytes("main", "/big.bin")).toEqual([
      1, 2, 3, 4, 5, 6
    ]);
  });
});

describe("VersionedFileSystem — file I/O and normalization", () => {
  it("auto-creates parent directories, overwrites files, and rejects writing to root", async () => {
    const agent = await freshAgent("io-basic");

    await agent.createVersion("main");
    await agent.write("main", "/a/b/file.txt", "first");
    expect(await agent.read("main", "/a/b/file.txt")).toBe("first");

    await agent.write("main", "/a/b/file.txt", "second");
    expect(await agent.read("main", "/a/b/file.txt")).toBe("second");

    await expectAgentError(agent, "write", ["main", "/", "nope"], /EISDIR/);
  });

  it("normalizes relative, dotted, dotdot, and repeated-slash paths", async () => {
    const agent = await freshAgent("io-normalization");

    await agent.createVersion("main");
    await agent.write("main", "nested//dir/./file.txt", "hello");
    expect(await agent.read("main", "/nested/dir/file.txt")).toBe("hello");

    await agent.write("main", "/nested/dir/../other.txt", "world");
    expect(await agent.read("main", "/nested/other.txt")).toBe("world");

    await agent.write("main", "/../../../etc/passwd", "rooted");
    expect(await agent.read("main", "/etc/passwd")).toBe("rooted");
  });

  it("rejects paths exceeding the maximum length", async () => {
    const agent = await freshAgent("io-long-path");

    await agent.createVersion("main");
    const longPath = `/${"a".repeat(5000)}`;
    await expectAgentError(
      agent,
      "write",
      ["main", longPath, "nope"],
      /ENAMETOOLONG/
    );
  });

  it("supports text and binary round-trips, append, and text/bytes interop", async () => {
    const agent = await freshAgent("io-bytes");

    await agent.createVersion("main");
    await agent.write("main", "/src/a.txt", "hello");
    await agent.append("main", "/src/a.txt", " world");
    expect(await agent.read("main", "/src/a.txt")).toBe("hello world");
    expect(await agent.readBytes("main", "/src/a.txt")).toEqual([
      104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100
    ]);

    await agent.writeBytes("main", "/src/b.bin", [0, 1, 2, 0, 255]);
    await agent.appendBytes("main", "/src/b.bin", [3, 4]);
    expect(await agent.readBytes("main", "/src/b.bin")).toEqual([
      0, 1, 2, 0, 255, 3, 4
    ]);
    expect(await agent.read("main", "/src/b.bin")).toContain("\u0000");
  });

  it("preserves FileSystem missing-path contract", async () => {
    const agent = await freshAgent("io-missing");

    await agent.createVersion("main");
    expect(await agent.exists("main", "/missing.txt")).toBe(false);
    await expectAgentError(
      agent,
      "read",
      ["main", "/missing.txt"],
      /ENOENT: .*missing.txt/
    );
    await expectAgentError(
      agent,
      "readBytes",
      ["main", "/missing.txt"],
      /ENOENT: .*missing.txt/
    );
    await expectAgentError(
      agent,
      "stat",
      ["main", "/missing.txt"],
      /ENOENT: .*missing.txt/
    );
    await expectAgentError(
      agent,
      "lstat",
      ["main", "/missing.txt"],
      /ENOENT: .*missing.txt/
    );
  });
});

describe("VersionedFileSystem — metadata and directories", () => {
  it("returns stat/lstat metadata and supports directory reads", async () => {
    const agent = await freshAgent("meta-basic");

    await agent.createVersion("main");
    await agent.mkdir("main", "/src/nested", true);
    await agent.write("main", "/src/nested/a.txt", "hello");
    await agent.writeBytes("main", "/src/nested/b.bin", [1, 2, 3]);

    const stat = (await agent.stat("main", "/src/nested/a.txt")) as FsStat;
    expect(stat.type).toBe("file");
    expect(stat.size).toBe(5);

    const dirStat = (await agent.stat("main", "/src/nested")) as FsStat;
    expect(dirStat.type).toBe("directory");

    expect(await agent.readdir("main", "/src/nested")).toEqual([
      "a.txt",
      "b.bin"
    ]);
    expect(await agent.readdirWithFileTypes("main", "/src/nested")).toEqual([
      { name: "a.txt", type: "file" },
      { name: "b.bin", type: "file" }
    ] satisfies FileSystemDirent[]);
  });

  it("mkdir recursive is idempotent and errors on duplicates or missing parents appropriately", async () => {
    const agent = await freshAgent("dirs-mkdir");

    await agent.createVersion("main");
    await agent.mkdir("main", "/a/b/c", true);
    await agent.mkdir("main", "/a/b/c", true);
    expect(await agent.readdir("main", "/a/b")).toEqual(["c"]);

    await expectAgentError(agent, "mkdir", ["main", "/a/b/c", false], /EEXIST/);
    await expectAgentError(agent, "mkdir", ["main", "/x/y", false], /ENOENT/);
  });

  it("readdir returns empty for empty directories", async () => {
    const agent = await freshAgent("dirs-empty");

    await agent.createVersion("main");
    await agent.mkdir("main", "/empty", false);
    expect(await agent.readdir("main", "/empty")).toEqual([]);
  });

  it("rm removes files and directories and enforces recursive, force, and root rules", async () => {
    const agent = await freshAgent("dirs-rm");

    await agent.createVersion("main");
    await agent.write("main", "/file.txt", "gone");
    await agent.rm("main", "/file.txt");
    expect(await agent.exists("main", "/file.txt")).toBe(false);

    await agent.mkdir("main", "/empty", false);
    await agent.rm("main", "/empty");
    expect(await agent.exists("main", "/empty")).toBe(false);

    await agent.write("main", "/dir/child.txt", "x");
    await expectAgentError(
      agent,
      "rm",
      ["main", "/dir", { recursive: false }],
      /ENOTEMPTY/
    );
    await agent.rm("main", "/dir", { recursive: true });
    expect(await agent.exists("main", "/dir")).toBe(false);

    await agent.rm("main", "/missing", { force: true });
    await expectAgentError(
      agent,
      "rm",
      ["main", "/", { recursive: true }],
      /EPERM/
    );
  });

  it("escapes LIKE patterns when deleting recursive directories", async () => {
    const agent = await freshAgent("dirs-like-escape");

    await agent.createVersion("main");
    await agent.write("main", "/a%b/child.txt", "in-dir");
    await agent.write("main", "/axb/other.txt", "safe");
    await agent.rm("main", "/a%b", { recursive: true });
    expect(await agent.read("main", "/axb/other.txt")).toBe("safe");

    await agent.write("main", "/a_b/child.txt", "in-dir");
    await agent.write("main", "/acb/other.txt", "safe-again");
    await agent.rm("main", "/a_b", { recursive: true });
    expect(await agent.read("main", "/acb/other.txt")).toBe("safe-again");
  });
});

describe("VersionedFileSystem — SQL backend compatibility", () => {
  it("works with a custom sync SqlBackend", async () => {
    const agent = await freshAgent("custom-sql-backend");
    await expect(agent.customBackendRoundtrip()).resolves.toBe(
      "via-custom-backend"
    );
  });

  it("works with a custom async SqlBackend", async () => {
    const agent = await freshAgent("async-sql-backend");
    await expect(agent.asyncBackendRoundtrip()).resolves.toBe(
      "via-async-backend"
    );
  });
});

describe("VersionedFileSystem — symlinks", () => {
  it("supports readlink, stat, lstat, realpath, and relative/chained symlinks", async () => {
    const agent = await freshAgent("symlinks-basic");

    await agent.createVersion("main");
    await agent.write("main", "/dir/file.txt", "content");
    await agent.symlink("main", "/dir/file.txt", "/dir/link.txt");
    await agent.symlink("main", "link.txt", "/dir/relative.txt");
    await agent.symlink("main", "/dir/link.txt", "/dir/chain.txt");

    expect(await agent.readlink("main", "/dir/link.txt")).toBe("/dir/file.txt");
    expect((await agent.lstat("main", "/dir/link.txt")).type).toBe("symlink");
    expect((await agent.stat("main", "/dir/link.txt")).type).toBe("file");
    expect(await agent.realpath("main", "/dir/chain.txt")).toBe(
      "/dir/file.txt"
    );
    expect(await agent.read("main", "/dir/relative.txt")).toBe("content");
    expect(await agent.read("main", "/dir/chain.txt")).toBe("content");
  });

  it("supports dangling symlinks for exists and lstat while read/stat fail", async () => {
    const agent = await freshAgent("symlinks-dangling");

    await agent.createVersion("main");
    await agent.symlink("main", "/missing.txt", "/dangling.txt");
    expect(await agent.exists("main", "/dangling.txt")).toBe(true);
    expect((await agent.lstat("main", "/dangling.txt")).type).toBe("symlink");
    await expectAgentError(agent, "read", ["main", "/dangling.txt"], /ENOENT/);
    await expectAgentError(agent, "stat", ["main", "/dangling.txt"], /ENOENT/);
  });

  it("reports ELOOP for symlink cycles", async () => {
    const agent = await freshAgent("symlinks-loop");

    await expect(agent.loopErrorProbe()).resolves.toEqual({
      read: expect.stringMatching(/ELOOP/),
      stat: expect.stringMatching(/ELOOP/),
      realpath: expect.stringMatching(/ELOOP/)
    });
  });

  it("writes through symlinks for text and bytes", async () => {
    const agent = await freshAgent("symlinks-write-through");

    await agent.createVersion("main");
    await agent.write("main", "/real.txt", "original");
    await agent.symlink("main", "/real.txt", "/link.txt");
    await agent.write("main", "/link.txt", "updated");
    expect(await agent.read("main", "/real.txt")).toBe("updated");

    await agent.writeBytes("main", "/real.bin", [1, 2, 3]);
    await agent.symlink("main", "/real.bin", "/link.bin");
    await agent.writeBytes("main", "/link.bin", [4, 5, 6]);
    expect(await agent.readBytes("main", "/real.bin")).toEqual([4, 5, 6]);
  });

  it("removes symlinks without following them, even when pointing to directories", async () => {
    const agent = await freshAgent("symlinks-delete");

    await agent.createVersion("main");
    await agent.write("main", "/target.txt", "keep");
    await agent.symlink("main", "/target.txt", "/link.txt");
    await agent.rm("main", "/link.txt");
    expect(await agent.read("main", "/target.txt")).toBe("keep");

    await agent.mkdir("main", "/dir", false);
    await agent.symlink("main", "/dir", "/dirlink");
    await agent.rm("main", "/dirlink");
    expect((await agent.stat("main", "/dir")).type).toBe("directory");
  });

  it("rejects invalid symlink operations", async () => {
    const agent = await freshAgent("symlinks-errors");

    await agent.createVersion("main");
    await agent.write("main", "/file.txt", "x");

    await expectAgentError(agent, "readlink", ["main", "/file.txt"], /EINVAL/);
    await expectAgentError(agent, "symlink", ["main", "", "/bad1"], /EINVAL/);
    await expectAgentError(
      agent,
      "symlink",
      ["main", "   ", "/bad2"],
      /EINVAL/
    );
    await expectAgentError(
      agent,
      "symlink",
      ["main", `/${"a".repeat(5000)}`, "/bad3"],
      /ENAMETOOLONG/
    );
    await expectAgentError(
      agent,
      "symlink",
      ["main", "/file.txt", "/file.txt"],
      /EEXIST/
    );
  });
});

describe("VersionedFileSystem — corruption handling", () => {
  it("fails with a corruption error when a file row points to a missing content row", async () => {
    const agent = await freshAgent("corruption-missing-content");

    await agent.createVersion("main");
    await agent.write("main", "/file.txt", "hello");
    const row = await agent.queryFileRow("main", "/file.txt");
    expect(row?.content_hash).toBeTruthy();
    await agent.deleteContentRow(row!.content_hash!);

    await expect(agent.readError("main", "/file.txt")).resolves.toEqual({
      error: expect.stringMatching(/ECORRUPT: .*missing content row/)
    });
    await expect(agent.readBytesError("main", "/file.txt")).resolves.toEqual({
      error: expect.stringMatching(/ECORRUPT: .*missing content row/)
    });
  });

  it("reads back R2-backed content and fails with a corruption error when the R2 object is missing", async () => {
    const agent = await freshAgent("corruption-missing-r2-object");

    await agent.createVersionWithR2("main");
    await agent.writeWithR2("main", "/big.txt", "0123456789abcdef");
    expect(await agent.readWithR2("main", "/big.txt")).toBe("0123456789abcdef");
    expect(await agent.readBytesWithR2("main", "/big.txt")).toEqual([
      48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102
    ]);

    const blobs = await agent.queryContentRows();
    await agent.deleteMockR2Key(blobs[0].r2_key!);

    await expect(
      agent.readError("main", "/big.txt", { useR2: true, inlineThreshold: 8 })
    ).resolves.toEqual({
      error: expect.stringMatching(/ECORRUPT: .*missing R2 blob/)
    });
  });
});

describe("VersionedFileSystem — copy, move, and glob", () => {
  it("copies files, directories, and symlinks and errors for invalid copy operations", async () => {
    const agent = await freshAgent("copy-basic");

    await agent.createVersion("main");
    await agent.write("main", "/src.txt", "copy me");
    await agent.cp("main", "/src.txt", "/dst.txt");
    expect(await agent.read("main", "/dst.txt")).toBe("copy me");
    expect(await agent.read("main", "/src.txt")).toBe("copy me");

    await agent.write("main", "/dir/sub/a.txt", "aaa");
    await agent.write("main", "/dir/sub/b.txt", "bbb");
    await agent.cp("main", "/dir", "/copy", { recursive: true });
    expect(await agent.read("main", "/copy/sub/a.txt")).toBe("aaa");
    expect(await agent.read("main", "/copy/sub/b.txt")).toBe("bbb");

    await agent.symlink("main", "/src.txt", "/link.txt");
    await agent.cp("main", "/link.txt", "/link2.txt");
    expect(await agent.readlink("main", "/link2.txt")).toBe("/src.txt");

    await expectAgentError(agent, "cp", ["main", "/dir", "/dir2"], /EISDIR/);
    await expectAgentError(agent, "cp", ["main", "/ghost", "/dest"], /ENOENT/);
  });

  it("handles overwrite and conflict cases for copy", async () => {
    const agent = await freshAgent("copy-conflicts");

    await agent.createVersion("main");
    await agent.write("main", "/src.txt", "source");
    await agent.write("main", "/dest.txt", "old");
    await agent.cp("main", "/src.txt", "/dest.txt");
    expect(await agent.read("main", "/dest.txt")).toBe("source");

    await agent.mkdir("main", "/dir-target", false);
    await expect(
      agent.cpError("main", "/src.txt", "/dir-target")
    ).resolves.toEqual({
      error: expect.stringMatching(/EISDIR/)
    });

    await agent.write("main", "/src-dir/file.txt", "x");
    await agent.write("main", "/existing-file.txt", "y");
    await expect(
      agent.cpError("main", "/src-dir", "/existing-file.txt", {
        recursive: true
      })
    ).resolves.toEqual({
      error: expect.stringMatching(/EEXIST/)
    });
  });

  it("moves files and directories and handles overwrite/dir conflicts", async () => {
    const agent = await freshAgent("move-basic");

    await agent.createVersion("main");
    await agent.write("main", "/old.txt", "move me");
    await agent.mv("main", "/old.txt", "/new.txt");
    expect(await agent.read("main", "/new.txt")).toBe("move me");
    expect(await agent.exists("main", "/old.txt")).toBe(false);

    await agent.write("main", "/src/a.txt", "aaa");
    await agent.write("main", "/src/b.txt", "bbb");
    await agent.mv("main", "/src", "/dst");
    expect(await agent.read("main", "/dst/a.txt")).toBe("aaa");
    expect(await agent.exists("main", "/src")).toBe(false);

    await agent.write("main", "/replace-a.txt", "first");
    await agent.write("main", "/replace-b.txt", "second");
    await agent.mv("main", "/replace-a.txt", "/replace-b.txt");
    expect(await agent.read("main", "/replace-b.txt")).toBe("first");
    expect(await agent.exists("main", "/replace-a.txt")).toBe(false);

    await agent.write("main", "/a.txt", "same");
    await agent.mv("main", "/a.txt", "/a.txt");
    expect(await agent.read("main", "/a.txt")).toBe("same");

    await agent.write("main", "/real.txt", "replace-link");
    await agent.symlink("main", "/real.txt", "/link.txt");
    await agent.write("main", "/new-source.txt", "new-content");
    await agent.mv("main", "/new-source.txt", "/link.txt");
    expect(await agent.read("main", "/link.txt")).toBe("new-content");
    expect(await agent.read("main", "/real.txt")).toBe("replace-link");

    await agent.mkdir("main", "/existing-dir", false);
    await agent.write("main", "/cant-move.txt", "x");
    await expectAgentError(
      agent,
      "mv",
      ["main", "/cant-move.txt", "/existing-dir"],
      /EISDIR/
    );
  });

  it("supports glob patterns and returns sorted absolute paths", async () => {
    const agent = await freshAgent("glob-basic");

    await agent.createVersion("main");
    await agent.write("main", "/src/a.ts", "a");
    await agent.write("main", "/src/b.ts", "b");
    await agent.write("main", "/src/c.js", "c");
    await agent.write("main", "/src/sub/deep.ts", "d");
    await agent.mkdir("main", "/src/utils", true);
    await agent.write("main", "/f1.txt", "1");
    await agent.write("main", "/f2.txt", "2");
    await agent.write("main", "/f10.txt", "10");
    await agent.write("main", "/app.ts", "ts");
    await agent.write("main", "/app.js", "js");
    await agent.write("main", "/a.txt", "a");
    await agent.write("main", "/b.txt", "b");
    await agent.write("main", "/d.txt", "d");

    expect(await agent.glob("main", "/src/*.ts")).toEqual([
      "/src/a.ts",
      "/src/b.ts"
    ]);
    expect(await agent.glob("main", "/src/**/*.ts")).toEqual([
      "/src/a.ts",
      "/src/b.ts",
      "/src/sub/deep.ts"
    ]);
    expect(await agent.glob("main", "/f?.txt")).toEqual(["/f1.txt", "/f2.txt"]);
    expect(await agent.glob("main", "/app.{ts,js}")).toEqual([
      "/app.js",
      "/app.ts"
    ]);
    expect(await agent.glob("main", "/[ab].txt")).toEqual(["/a.txt", "/b.txt"]);
    expect(await agent.glob("main", "/src/*")).toEqual([
      "/src/a.ts",
      "/src/b.ts",
      "/src/c.js",
      "/src/sub",
      "/src/utils"
    ]);
    expect(await agent.glob("main", "/missing/*")).toEqual([]);
    expect(await agent.glob("main", "/app.ts")).toEqual(["/app.ts"]);
  });
});

describe("VersionedFileSystem — more directory and observability edge cases", () => {
  it("errors when reading directories incorrectly or creating under a file parent", async () => {
    const agent = await freshAgent("dir-edge-errors");

    await agent.createVersion("main");
    await agent.write("main", "/file.txt", "x");
    await expect(agent.readdirError("main", "/missing")).resolves.toEqual({
      error: expect.stringMatching(/ENOENT/)
    });
    await expect(agent.readdirError("main", "/file.txt")).resolves.toEqual({
      error: expect.stringMatching(/ENOTDIR/)
    });
    await expect(
      agent.mkdirError("main", "/file.txt/child", false)
    ).resolves.toEqual({
      error: expect.stringMatching(/ENOTDIR/)
    });
  });

  it("emits update=true on overwrite and storage=r2 on R2 reads", async () => {
    const agent = await freshAgent("observability-details");

    await agent.startObservability();
    await agent.createVersionWithR2("main");
    await agent.write("main", "/file.txt", "v1");
    await agent.write("main", "/file.txt", "v2");
    await agent.writeWithR2("main", "/big.txt", "0123456789abcdef");
    await agent.readWithR2("main", "/big.txt");
    const log = await agent.getObservabilityLog();
    await agent.stopObservability();

    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "versioned-filesystem:write",
          payload: expect.objectContaining({
            version: "main",
            path: "/file.txt",
            update: true,
            storage: "inline"
          })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:read",
          payload: expect.objectContaining({
            version: "main",
            path: "/big.txt",
            storage: "r2"
          })
        })
      ])
    );
  });
});

describe("VersionedFileSystem — change events and observability", () => {
  it("emits create, update, and delete change events with version information", async () => {
    const agent = await freshAgent("events-basic");

    await agent.clearChangeLog();
    await agent.createVersion("main");
    await agent.clearChangeLog();

    await agent.write("main", "/file.txt", "hello");
    await agent.write("main", "/file.txt", "world");
    await agent.symlink("main", "/file.txt", "/link.txt");
    await agent.rm("main", "/file.txt");

    const changes =
      (await agent.getChangeLog()) as VersionedFileSystemChangeEvent[];
    expect(changes).toEqual([
      {
        type: "create",
        version: "main",
        path: "/file.txt",
        entryType: "file"
      },
      {
        type: "update",
        version: "main",
        path: "/file.txt",
        entryType: "file"
      },
      {
        type: "create",
        version: "main",
        path: "/link.txt",
        entryType: "symlink"
      },
      {
        type: "delete",
        version: "main",
        path: "/file.txt",
        entryType: "file"
      }
    ]);
  });

  it("emits diagnostics for version lifecycle and filesystem operations, including timestamp and name", async () => {
    const agent = await freshAgent("observability-all");

    await agent.startObservability();
    await agent.createVersion("main");
    await agent.write("main", "/file.txt", "hello");
    await agent.read("main", "/file.txt");
    await agent.mkdir("main", "/dir", false);
    await agent.cp("main", "/file.txt", "/copy.txt");
    await agent.mv("main", "/copy.txt", "/moved.txt");
    await agent.rm("main", "/moved.txt");
    await agent.copyVersion("main", "snapshot");
    const log = await agent.getObservabilityLog();
    await agent.stopObservability();

    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "versioned-filesystem:create-version",
          name: "observability-all",
          timestamp: expect.any(Number),
          payload: expect.objectContaining({ version: "main" })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:write",
          payload: expect.objectContaining({
            version: "main",
            path: "/file.txt",
            storage: "inline",
            update: false
          })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:read",
          payload: expect.objectContaining({
            version: "main",
            path: "/file.txt"
          })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:mkdir",
          payload: expect.objectContaining({ version: "main", path: "/dir" })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:cp",
          payload: expect.objectContaining({
            version: "main",
            src: "/file.txt",
            dest: "/copy.txt"
          })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:mv",
          payload: expect.objectContaining({
            version: "main",
            src: "/copy.txt",
            dest: "/moved.txt"
          })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:rm",
          payload: expect.objectContaining({
            version: "main",
            path: "/moved.txt"
          })
        }),
        expect.objectContaining({
          type: "versioned-filesystem:copy-version",
          payload: expect.objectContaining({
            sourceVersion: "main",
            destVersion: "snapshot"
          })
        })
      ])
    );
  });

  it("stops collecting diagnostics after unsubscribe", async () => {
    const agent = await freshAgent("observability-unsub");

    await agent.startObservability();
    await agent.stopObservability();
    await agent.createVersion("main");
    await agent.write("main", "/file.txt", "silent");
    expect(await agent.getObservabilityLog()).toEqual([]);
  });
});
