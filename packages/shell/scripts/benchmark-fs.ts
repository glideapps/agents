import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { InMemoryFs } from "../src/fs/in-memory-fs";
import type { FileSystem, FileSystemDirent, FsStat } from "../src/fs/interface";
import { GitFileSystem } from "../src/git-fs/git-file-system";

const execFileAsync = promisify(execFile);
const identity = {
  name: "Benchmark User",
  email: "benchmark@example.com"
};

const countedMethodNames = [
  "readFile",
  "readFileBytes",
  "writeFile",
  "writeFileBytes",
  "appendFile",
  "exists",
  "stat",
  "lstat",
  "mkdir",
  "readdir",
  "readdirWithFileTypes",
  "rm",
  "cp",
  "mv",
  "symlink",
  "readlink",
  "realpath",
  "glob"
] as const;

type CountedMethodName = (typeof countedMethodNames)[number];
type BenchmarkMode = "inmemory" | "git" | "nested-git" | "all";
type BenchmarkStatus = "ok" | "timeout" | "error";

type MethodCounts = Record<CountedMethodName, number>;

interface OperationResult {
  name: string;
  wallTimeMs: number;
  inMemoryOps: number;
  inMemoryOpsByMethod: MethodCounts;
}

interface BenchmarkResult {
  mode: Exclude<BenchmarkMode, "all">;
  label: string;
  status: BenchmarkStatus;
  wallTimeMs: number;
  operationCount: number;
  operationsCompleted: number;
  currentOperation: string | null;
  inMemoryOps: {
    total: number;
    byMethod: MethodCounts;
  };
  operationResults: OperationResult[];
  error?: string;
}

interface CreateBenchmarkTargetResult {
  fs: FileSystem;
  storage: CountingInMemoryFs;
}

interface BenchmarkOperation {
  name: string;
  run: (fs: FileSystem) => Promise<void>;
}

class CountingInMemoryFs implements FileSystem {
  readonly inner = new InMemoryFs();
  private readonly counts: MethodCounts = createZeroCounts();

  snapshotCounts(): MethodCounts {
    return { ...this.counts };
  }

  private bump(name: CountedMethodName): void {
    this.counts[name] += 1;
  }

  async readFile(path: string): Promise<string> {
    this.bump("readFile");
    return this.inner.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    this.bump("readFileBytes");
    return this.inner.readFileBytes(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.bump("writeFile");
    await this.inner.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    this.bump("writeFileBytes");
    await this.inner.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    this.bump("appendFile");
    await this.inner.appendFile(path, content);
  }

  async exists(path: string): Promise<boolean> {
    this.bump("exists");
    return this.inner.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    this.bump("stat");
    return this.inner.stat(path);
  }

  async lstat(path: string): Promise<FsStat> {
    this.bump("lstat");
    return this.inner.lstat(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.bump("mkdir");
    await this.inner.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    this.bump("readdir");
    return this.inner.readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    this.bump("readdirWithFileTypes");
    return this.inner.readdirWithFileTypes(path);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    this.bump("rm");
    await this.inner.rm(path, options);
  }

  async cp(
    src: string,
    dest: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    this.bump("cp");
    await this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    this.bump("mv");
    await this.inner.mv(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.bump("symlink");
    await this.inner.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    this.bump("readlink");
    return this.inner.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    this.bump("realpath");
    return this.inner.realpath(path);
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    this.bump("glob");
    return this.inner.glob(pattern);
  }
}

const operations: BenchmarkOperation[] = [
  {
    name: "mkdir recursive /docs/empty",
    run: async (fs) => {
      await fs.mkdir("/docs/empty", { recursive: true });
    }
  },
  {
    name: "write /docs/a.txt",
    run: async (fs) => {
      await fs.writeFile("/docs/a.txt", "alpha");
    }
  },
  {
    name: "write /docs/b.txt",
    run: async (fs) => {
      await fs.writeFile("/docs/b.txt", "beta");
    }
  },
  {
    name: "write bytes /bin/data.bin",
    run: async (fs) => {
      await fs.writeFileBytes("/bin/data.bin", new Uint8Array([1, 2, 3, 4]));
    }
  },
  {
    name: "append /docs/a.txt",
    run: async (fs) => {
      await fs.appendFile("/docs/a.txt", "-tail");
    }
  },
  {
    name: "read /docs/a.txt",
    run: async (fs) => {
      const content = await fs.readFile("/docs/a.txt");
      assertEqual(content, "alpha-tail", "readFile(/docs/a.txt)");
    }
  },
  {
    name: "read bytes /bin/data.bin",
    run: async (fs) => {
      const bytes = await fs.readFileBytes("/bin/data.bin");
      assertEqual(Array.from(bytes).join(","), "1,2,3,4", "readFileBytes");
    }
  },
  {
    name: "create symlink /docs/link.txt",
    run: async (fs) => {
      await fs.symlink("a.txt", "/docs/link.txt");
    }
  },
  {
    name: "readlink /docs/link.txt",
    run: async (fs) => {
      const target = await fs.readlink("/docs/link.txt");
      assertEqual(target, "a.txt", "readlink(/docs/link.txt)");
    }
  },
  {
    name: "realpath /docs/link.txt",
    run: async (fs) => {
      const resolved = await fs.realpath("/docs/link.txt");
      assertEqual(resolved, "/docs/a.txt", "realpath(/docs/link.txt)");
    }
  },
  {
    name: "stat+lstat /docs/link.txt",
    run: async (fs) => {
      const stat = await fs.stat("/docs/link.txt");
      const lstat = await fs.lstat("/docs/link.txt");
      assertEqual(stat.type, "file", "stat(/docs/link.txt).type");
      assertEqual(lstat.type, "symlink", "lstat(/docs/link.txt).type");
    }
  },
  {
    name: "readdir /docs",
    run: async (fs) => {
      const names = await fs.readdir("/docs");
      assertEqual(
        JSON.stringify(names),
        JSON.stringify(["a.txt", "b.txt", "empty", "link.txt"]),
        "readdir(/docs)"
      );
    }
  },
  {
    name: "readdirWithFileTypes /docs",
    run: async (fs) => {
      const entries = await fs.readdirWithFileTypes("/docs");
      assertEqual(entries[3]?.type ?? "", "symlink", "dirent link type");
    }
  },
  {
    name: "write through symlink /docs/link.txt",
    run: async (fs) => {
      await fs.writeFile("/docs/link.txt", "via-link");
      const content = await fs.readFile("/docs/a.txt");
      assertEqual(content, "via-link", "write through symlink target");
    }
  },
  {
    name: "cp /docs -> /copy",
    run: async (fs) => {
      await fs.cp("/docs", "/copy", { recursive: true });
      const copyLink = await fs.readlink("/copy/link.txt");
      assertEqual(copyLink, "a.txt", "copied symlink target");
    }
  },
  {
    name: "mv /copy -> /moved",
    run: async (fs) => {
      await fs.mv("/copy", "/moved");
      const exists = await fs.exists("/copy");
      assertEqual(String(exists), "false", "copy removed after mv");
    }
  },
  {
    name: "glob /**/*.txt",
    run: async (fs) => {
      const matches = await fs.glob("/**/*.txt");
      assertEqual(
        JSON.stringify(matches),
        JSON.stringify([
          "/docs/a.txt",
          "/docs/b.txt",
          "/docs/link.txt",
          "/moved/a.txt",
          "/moved/b.txt",
          "/moved/link.txt"
        ]),
        "glob(/**/*.txt)"
      );
    }
  },
  {
    name: "rm /moved recursive",
    run: async (fs) => {
      await fs.rm("/moved", { recursive: true });
    }
  },
  {
    name: "rm missing force",
    run: async (fs) => {
      await fs.rm("/does-not-exist", { recursive: true, force: true });
    }
  },
  {
    name: "exists /moved",
    run: async (fs) => {
      const exists = await fs.exists("/moved");
      assertEqual(String(exists), "false", "exists(/moved)");
    }
  }
];

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "all") {
    const results = await runAllModes(args.timeoutMs);
    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    printSummary(results);
    printDetails(results);
    if (results.some((result) => result.status === "error")) {
      process.exitCode = 1;
    }
    return;
  }

  const result = await runSingleModeWithTimeout(args.mode, args.timeoutMs);
  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    printSummary([result]);
    printDetails([result]);
  }

  if (result.status === "timeout") {
    process.exitCode = 124;
  } else if (result.status === "error") {
    process.exitCode = 1;
  }
}

async function runAllModes(timeoutMs: number): Promise<BenchmarkResult[]> {
  const modes: Array<Exclude<BenchmarkMode, "all">> = [
    "inmemory",
    "git",
    "nested-git"
  ];
  const scriptPath = fileURLToPath(import.meta.url);
  const results: BenchmarkResult[] = [];

  for (const mode of modes) {
    const stdout = await runBenchmarkChild(scriptPath, mode, timeoutMs);
    const jsonLine = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1);
    if (!jsonLine) {
      throw new Error(`Benchmark child for mode '${mode}' produced no output`);
    }
    results.push(JSON.parse(jsonLine) as BenchmarkResult);
  }

  return results;
}

async function runSingleModeWithTimeout(
  mode: Exclude<BenchmarkMode, "all">,
  timeoutMs: number
): Promise<BenchmarkResult> {
  const setupStart = performance.now();
  const target = createBenchmarkTarget(mode);
  const setupEnd = performance.now();

  const result: BenchmarkResult = {
    mode,
    label: modeLabel(mode),
    status: "ok",
    wallTimeMs: 0,
    operationCount: operations.length,
    operationsCompleted: 0,
    currentOperation: null,
    inMemoryOps: {
      total: 0,
      byMethod: createZeroCounts()
    },
    operationResults: []
  };

  const benchmarkStart = performance.now();
  const timeout = setTimeout(() => {
    const elapsed =
      performance.now() - benchmarkStart + (setupEnd - setupStart);
    const counts = target.storage.snapshotCounts();
    const timedOut: BenchmarkResult = {
      ...result,
      status: "timeout",
      wallTimeMs: elapsed,
      inMemoryOps: {
        total: totalCounts(counts),
        byMethod: counts
      }
    };
    console.log(JSON.stringify(timedOut));
    process.exit(124);
  }, timeoutMs);

  try {
    for (const operation of operations) {
      result.currentOperation = operation.name;
      const before = target.storage.snapshotCounts();
      const start = performance.now();
      await operation.run(target.fs);
      const end = performance.now();
      const after = target.storage.snapshotCounts();
      result.operationResults.push({
        name: operation.name,
        wallTimeMs: end - start,
        inMemoryOps: totalCounts(diffCounts(before, after)),
        inMemoryOpsByMethod: diffCounts(before, after)
      });
      result.operationsCompleted += 1;
    }

    const finalCounts = target.storage.snapshotCounts();
    result.wallTimeMs =
      performance.now() - benchmarkStart + (setupEnd - setupStart);
    result.currentOperation = null;
    result.inMemoryOps = {
      total: totalCounts(finalCounts),
      byMethod: finalCounts
    };
    return result;
  } catch (error) {
    const finalCounts = target.storage.snapshotCounts();
    result.status = "error";
    result.error = error instanceof Error ? error.message : String(error);
    result.wallTimeMs =
      performance.now() - benchmarkStart + (setupEnd - setupStart);
    result.inMemoryOps = {
      total: totalCounts(finalCounts),
      byMethod: finalCounts
    };
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function createBenchmarkTarget(
  mode: Exclude<BenchmarkMode, "all">
): CreateBenchmarkTargetResult {
  const storage = new CountingInMemoryFs();
  switch (mode) {
    case "inmemory":
      return { fs: storage, storage };
    case "git":
      return {
        fs: new GitFileSystem({
          storage,
          dir: "/repo",
          gitdir: "/repo/.git",
          identity
        }),
        storage
      };
    case "nested-git": {
      const inner = new GitFileSystem({
        storage,
        dir: "/inner",
        gitdir: "/inner/.git",
        identity
      });
      return {
        fs: new GitFileSystem({
          storage: inner,
          dir: "/outer",
          gitdir: "/outer/.git",
          identity
        }),
        storage
      };
    }
  }
}

async function runBenchmarkChild(
  scriptPath: string,
  mode: Exclude<BenchmarkMode, "all">,
  timeoutMs: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      [
        "tsx",
        scriptPath,
        "--mode",
        mode,
        "--timeoutMs",
        String(timeoutMs),
        "--json"
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024
      }
    );
    return stdout;
  } catch (error) {
    if (isExecFileError(error) && typeof error.stdout === "string") {
      return error.stdout;
    }
    throw error;
  }
}

function parseArgs(argv: string[]): {
  mode: BenchmarkMode;
  timeoutMs: number;
  json: boolean;
} {
  let mode: BenchmarkMode = "all";
  let timeoutMs = 10_000;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      const value = argv[index + 1];
      if (
        value !== "all" &&
        value !== "inmemory" &&
        value !== "git" &&
        value !== "nested-git"
      ) {
        throw new Error(`Invalid --mode value: ${value}`);
      }
      mode = value;
      index += 1;
      continue;
    }
    if (arg === "--timeoutMs") {
      const raw = argv[index + 1];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeoutMs value: ${raw}`);
      }
      timeoutMs = parsed;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { mode, timeoutMs, json };
}

function printSummary(results: BenchmarkResult[]): void {
  const rows = results.map((result) => ({
    mode: result.label,
    status: result.status,
    wall_ms: result.wallTimeMs.toFixed(1),
    completed_ops: `${result.operationsCompleted}/${result.operationCount}`,
    in_memory_ops: result.inMemoryOps.total,
    current_operation: result.currentOperation ?? "-"
  }));
  console.table(rows);
}

function printDetails(results: BenchmarkResult[]): void {
  for (const result of results) {
    console.log(`\n# ${result.label}`);
    if (result.error) {
      console.log(`error: ${result.error}`);
    }
    console.log("underlying InMemoryFs operations:");
    console.table(
      countedMethodNames.map((name) => ({
        method: name,
        count: result.inMemoryOps.byMethod[name]
      }))
    );
    console.log("operation timings:");
    console.table(
      result.operationResults.map((operation) => ({
        operation: operation.name,
        wall_ms: operation.wallTimeMs.toFixed(1),
        in_memory_ops: operation.inMemoryOps
      }))
    );
  }
}

function createZeroCounts(): MethodCounts {
  return {
    readFile: 0,
    readFileBytes: 0,
    writeFile: 0,
    writeFileBytes: 0,
    appendFile: 0,
    exists: 0,
    stat: 0,
    lstat: 0,
    mkdir: 0,
    readdir: 0,
    readdirWithFileTypes: 0,
    rm: 0,
    cp: 0,
    mv: 0,
    symlink: 0,
    readlink: 0,
    realpath: 0,
    glob: 0
  };
}

function diffCounts(before: MethodCounts, after: MethodCounts): MethodCounts {
  const out = createZeroCounts();
  for (const name of countedMethodNames) {
    out[name] = after[name] - before[name];
  }
  return out;
}

function totalCounts(counts: MethodCounts): number {
  return countedMethodNames.reduce((sum, name) => sum + counts[name], 0);
}

function modeLabel(mode: Exclude<BenchmarkMode, "all">): string {
  switch (mode) {
    case "inmemory":
      return "InMemoryFs";
    case "git":
      return "GitFileSystem <- InMemoryFs";
    case "nested-git":
      return "GitFileSystem <- GitFileSystem <- InMemoryFs";
  }
}

function isExecFileError(error: unknown): error is Error & { stdout?: string } {
  return error instanceof Error;
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected '${expected}', got '${actual}'`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
