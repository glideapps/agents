import { describe, expect, it } from "vitest";
import type { FileSystem } from "../fs/interface";

export interface FileSystemHarness {
  fs: FileSystem;
  reload?: () => Promise<FileSystem> | FileSystem;
}

export type CreateFileSystemHarness =
  | (() => Promise<FileSystemHarness>)
  | (() => FileSystemHarness);

export function defineFileSystemBehaviorSuite(
  name: string,
  createHarness: CreateFileSystemHarness
): void {
  describe(name, () => {
    async function harness() {
      const current = await createHarness();
      return {
        fs: current.fs,
        reload: current.reload ?? (() => current.fs)
      };
    }

    it("writes and reads files", async () => {
      const { fs } = await harness();

      await fs.writeFile("/notes/today.txt", "hello");

      await expect(fs.readFile("/notes/today.txt")).resolves.toBe("hello");
      await expect(fs.readdir("/notes")).resolves.toEqual(["today.txt"]);
    });

    it("reads and writes binary file contents", async () => {
      const { fs } = await harness();
      const bytes = new Uint8Array([0, 255, 1, 128, 42]);

      await fs.writeFileBytes("/bin/data.bin", bytes);

      await expect(fs.readFileBytes("/bin/data.bin")).resolves.toEqual(bytes);
    });

    it("preserves empty directories across reloads", async () => {
      const { fs, reload } = await harness();

      await fs.mkdir("/a/b/empty", { recursive: true });

      await expect(fs.readdir("/a/b/empty")).resolves.toEqual([]);

      const reloaded = await reload();
      await expect(reloaded.readdir("/a/b")).resolves.toEqual(["empty"]);
      await expect(reloaded.readdir("/a/b/empty")).resolves.toEqual([]);
    });

    it("supports symlinks", async () => {
      const { fs, reload } = await harness();

      await fs.writeFile("/dir/target.txt", "payload");
      await fs.symlink("target.txt", "/dir/link.txt");

      await expect(fs.readlink("/dir/link.txt")).resolves.toBe("target.txt");
      await expect(fs.readFile("/dir/link.txt")).resolves.toBe("payload");
      await expect(fs.realpath("/dir/link.txt")).resolves.toBe(
        "/dir/target.txt"
      );

      const stat = await fs.stat("/dir/link.txt");
      const lstat = await fs.lstat("/dir/link.txt");
      expect(stat.type).toBe("file");
      expect(lstat.type).toBe("symlink");

      const reloaded = await reload();
      await expect(reloaded.readlink("/dir/link.txt")).resolves.toBe(
        "target.txt"
      );
    });

    it("resolves intermediate, relative, and chained symlinks", async () => {
      const { fs } = await harness();

      await fs.writeFile("/actual/target.txt", "payload");
      await fs.symlink("/actual", "/shortcut");
      await fs.symlink("target.txt", "/actual/relative.txt");
      await fs.symlink("/shortcut/relative.txt", "/hop1");
      await fs.symlink("/hop1", "/hop2");

      await expect(fs.readFile("/shortcut/target.txt")).resolves.toBe(
        "payload"
      );
      await expect(fs.readFile("/hop2")).resolves.toBe("payload");
      await expect(fs.realpath("/hop2")).resolves.toBe("/actual/target.txt");
    });

    it("throws ELOOP on circular symlinks", async () => {
      const { fs } = await harness();

      await fs.symlink("/b", "/a");
      await fs.symlink("/a", "/b");

      await expect(fs.readFile("/a")).rejects.toThrow("ELOOP");
      await expect(fs.realpath("/a")).rejects.toThrow("ELOOP");
    });

    it("readdirWithFileTypes reports symlinks and keeps names sorted", async () => {
      const { fs } = await harness();

      await fs.writeFile("/dir/zeta.txt", "z");
      await fs.writeFile("/dir/alpha.txt", "a");
      await fs.symlink("alpha.txt", "/dir/link.txt");

      await expect(fs.readdirWithFileTypes("/dir")).resolves.toEqual([
        { name: "alpha.txt", type: "file" },
        { name: "link.txt", type: "symlink" },
        { name: "zeta.txt", type: "file" }
      ]);
    });

    it("writes through a final symlink to the target file", async () => {
      const { fs } = await harness();

      await fs.writeFile("/target.txt", "before");
      await fs.symlink("/target.txt", "/link.txt");

      await fs.writeFile("/link.txt", "after");

      await expect(fs.readFile("/target.txt")).resolves.toBe("after");
      await expect(fs.readFile("/link.txt")).resolves.toBe("after");
      await expect(fs.readlink("/link.txt")).resolves.toBe("/target.txt");
    });

    it("cp preserves symlinks and empty directories", async () => {
      const { fs } = await harness();

      await fs.writeFile("/src/file.txt", "data");
      await fs.symlink("file.txt", "/src/link.txt");
      await fs.mkdir("/src/empty", { recursive: true });

      await fs.cp("/src", "/copy", { recursive: true });

      await expect(fs.readFile("/copy/file.txt")).resolves.toBe("data");
      await expect(fs.readlink("/copy/link.txt")).resolves.toBe("file.txt");
      await expect(fs.readdir("/copy/empty")).resolves.toEqual([]);
    });

    it("mv preserves symlinks and removes the source path", async () => {
      const { fs } = await harness();

      await fs.writeFile("/from/target.txt", "data");
      await fs.symlink("target.txt", "/from/link.txt");

      await fs.mv("/from", "/to");

      await expect(fs.exists("/from")).resolves.toBe(false);
      await expect(fs.readFile("/to/target.txt")).resolves.toBe("data");
      await expect(fs.readlink("/to/link.txt")).resolves.toBe("target.txt");
    });

    it("rm removes directories recursively", async () => {
      const { fs } = await harness();

      await fs.writeFile("/tmp/a.txt", "a");
      await fs.writeFile("/tmp/b.txt", "b");

      await fs.rm("/tmp", { recursive: true });

      await expect(fs.exists("/tmp")).resolves.toBe(false);
    });

    it("rm with force on a missing path is a no-op", async () => {
      const { fs } = await harness();

      await fs.rm("/nope", { force: true, recursive: true });

      await expect(fs.exists("/nope")).resolves.toBe(false);
    });

    it("rm without recursive rejects non-empty directories and leaves them intact", async () => {
      const { fs } = await harness();

      await fs.writeFile("/dir/file.txt", "x");

      await expect(fs.rm("/dir")).rejects.toThrow("ENOTEMPTY");
      await expect(fs.readFile("/dir/file.txt")).resolves.toBe("x");
    });

    it("mkdir -p on an existing directory is a no-op", async () => {
      const { fs } = await harness();

      await fs.mkdir("/a/b", { recursive: true });
      await fs.mkdir("/a/b", { recursive: true });

      await expect(fs.readdir("/a")).resolves.toEqual(["b"]);
    });

    it("cp rejects copying a directory without recursive", async () => {
      const { fs } = await harness();

      await fs.writeFile("/src/file.txt", "data");

      await expect(fs.cp("/src", "/copy")).rejects.toThrow("EISDIR");
      await expect(fs.exists("/copy")).resolves.toBe(false);
    });

    it("cp preserves a single symlink instead of following it", async () => {
      const { fs } = await harness();

      await fs.writeFile("/target.txt", "data");
      await fs.symlink("/target.txt", "/link.txt");

      await fs.cp("/link.txt", "/copied.txt");

      const lstat = await fs.lstat("/copied.txt");
      expect(lstat.type).toBe("symlink");
      await expect(fs.readlink("/copied.txt")).resolves.toBe("/target.txt");
    });

    it("mv to the same path is a no-op", async () => {
      const { fs } = await harness();

      await fs.writeFile("/same.txt", "x");
      await fs.mv("/same.txt", "/same.txt");

      await expect(fs.readFile("/same.txt")).resolves.toBe("x");
    });

    it("rejects moving a directory into its own descendant", async () => {
      const { fs } = await harness();

      await fs.writeFile("/src/file.txt", "x");

      let error: unknown = null;
      try {
        await fs.mv("/src", "/src/nested/dest");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("EINVAL");
      await expect(fs.readFile("/src/file.txt")).resolves.toBe("x");
    });

    it("globs across the tree", async () => {
      const { fs } = await harness();

      await fs.writeFile("/src/a.ts", "export const a = 1;");
      await fs.writeFile("/src/b.ts", "export const b = 2;");
      await fs.writeFile("/src/c.txt", "nope");

      await expect(fs.glob("/**/*.ts")).resolves.toEqual([
        "/src/a.ts",
        "/src/b.ts"
      ]);
    });

    it("allows a visible /.git directory in the tree", async () => {
      const { fs, reload } = await harness();

      await fs.writeFile("/.git/config", "user data");
      await fs.writeFile("/visible.txt", "ok");

      await expect(fs.exists("/.git")).resolves.toBe(true);
      await expect(fs.readFile("/.git/config")).resolves.toBe("user data");
      await expect(fs.readdir("/")).resolves.toEqual([".git", "visible.txt"]);
      await expect(fs.readdir("/.git")).resolves.toEqual(["config"]);
      await expect(fs.readFile("/.git/HEAD")).rejects.toThrow("ENOENT");

      const reloaded = await reload();
      await expect(reloaded.readFile("/.git/config")).resolves.toBe(
        "user data"
      );
      await expect(reloaded.readFile("/.git/HEAD")).rejects.toThrow("ENOENT");
    });

    it("copies a visible /.git subtree like normal user content", async () => {
      const { fs } = await harness();

      await fs.writeFile("/.git/config", "user data");
      await fs.writeFile("/.git/hooks/pre-commit", "echo hi\n");
      await fs.symlink("config", "/.git/config-link");

      await fs.cp("/.git", "/copied-dotgit", { recursive: true });

      await expect(fs.readFile("/copied-dotgit/config")).resolves.toBe(
        "user data"
      );
      await expect(fs.readlink("/copied-dotgit/config-link")).resolves.toBe(
        "config"
      );
      await expect(
        fs.readFile("/copied-dotgit/hooks/pre-commit")
      ).resolves.toBe("echo hi\n");
    });

    it("moves a visible /.git subtree", async () => {
      const { fs } = await harness();

      await fs.writeFile("/.git/config", "user data");
      await fs.mkdir("/.git/objects", { recursive: true });

      await fs.mv("/.git", "/renamed-dotgit");

      await expect(fs.exists("/.git")).resolves.toBe(false);
      await expect(fs.readFile("/renamed-dotgit/config")).resolves.toBe(
        "user data"
      );
      await expect(fs.readdir("/renamed-dotgit")).resolves.toEqual([
        "config",
        "objects"
      ]);
    });

    it("removes a visible /.git subtree", async () => {
      const { fs } = await harness();

      await fs.writeFile("/.git/config", "user data");

      await fs.rm("/.git", { recursive: true });

      await expect(fs.exists("/.git")).resolves.toBe(false);
      await expect(fs.readFile("/.git/config")).rejects.toThrow("ENOENT");
    });

    it("globs can match visible /.git content", async () => {
      const { fs } = await harness();

      await fs.writeFile("/.git/config.ts", "export const x = 1;\n");
      await fs.writeFile("/.git/hooks/pre-commit.ts", "export const y = 2;\n");
      await fs.writeFile("/src/a.ts", "export const z = 3;\n");

      await expect(fs.glob("/**/*.ts")).resolves.toEqual([
        "/.git/config.ts",
        "/.git/hooks/pre-commit.ts",
        "/src/a.ts"
      ]);
    });
  });
}
