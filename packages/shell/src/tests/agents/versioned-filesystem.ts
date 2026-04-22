import {
  subscribe as dcSubscribe,
  unsubscribe as dcUnsubscribe
} from "node:diagnostics_channel";
import { Agent } from "agents";
import {
  FileSystemStorage,
  type VersionedFileSystemChangeEvent
} from "../../versioned-filesystem";
import type { SqlBackend, SqlParam } from "../../filesystem";
import type { FileSystemDirent, FsStat } from "../../fs/interface";

type RowValue = unknown;

type ContentRow = {
  hash: string;
  size: number;
  storage_backend: string;
  r2_key: string | null;
  content: string | null;
  created_at: number;
};

type FileRow = {
  version: string;
  path: string;
  parent_path: string;
  name: string;
  type: string;
  mime_type: string;
  size: number;
  target: string | null;
  content_encoding: string;
  content_hash: string | null;
  created_at: number;
  modified_at: number;
};

class MockR2Object {
  constructor(
    private readonly bytes: Uint8Array,
    readonly httpMetadata?: { contentType?: string }
  ) {}

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }

  get body(): ReadableStream<Uint8Array> {
    const bytes = this.bytes;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
  }
}

class MockR2Bucket {
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; httpMetadata?: { contentType?: string } }
  >();

  async get(key: string): Promise<MockR2Object | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return new MockR2Object(entry.bytes, entry.httpMetadata);
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<void> {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer.slice(0));
    this.objects.set(key, {
      bytes,
      httpMetadata: options?.httpMetadata
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    if (typeof keys === "string") {
      this.objects.delete(keys);
      return;
    }
    for (const key of keys) {
      this.objects.delete(key);
    }
  }

  listKeys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

export class TestVersionedFileSystemAgent extends Agent {
  changeLog: VersionedFileSystemChangeEvent[] = [];
  observabilityLog: Record<string, unknown>[] = [];
  private _observabilityHandler:
    | ((message: unknown, name: string | symbol) => void)
    | null = null;
  private readonly mockR2 = new MockR2Bucket();

  private storage(options?: { useR2?: boolean; inlineThreshold?: number }) {
    return new FileSystemStorage({
      sql: this.ctx.storage.sql,
      r2: options?.useR2 ? (this.mockR2 as unknown as R2Bucket) : undefined,
      r2Prefix: options?.useR2 ? `agent/${this.name}` : undefined,
      inlineThreshold: options?.inlineThreshold,
      name: () => this.name,
      onChange: (event) => {
        this.changeLog.push(event);
      }
    });
  }

  private async fs(
    version: string,
    options?: { useR2?: boolean; inlineThreshold?: number }
  ) {
    return this.storage(options).getVersion(version);
  }

  async createVersion(
    name: string,
    options?: { useR2?: boolean; inlineThreshold?: number }
  ): Promise<void> {
    await this.storage(options).createVersion(name);
  }

  async copyVersion(
    sourceName: string,
    destName: string,
    options?: { useR2?: boolean; inlineThreshold?: number }
  ): Promise<void> {
    await this.storage(options).copyVersion(sourceName, destName);
  }

  async getVersion(name: string): Promise<"ok"> {
    await this.storage().getVersion(name);
    return "ok";
  }

  async write(version: string, path: string, content: string): Promise<void> {
    await (await this.fs(version)).writeFile(path, content);
  }

  async writeBytes(
    version: string,
    path: string,
    data: number[],
    options?: { useR2?: boolean; inlineThreshold?: number }
  ): Promise<void> {
    await (
      await this.fs(version, options)
    ).writeFileBytes(path, new Uint8Array(data));
  }

  async append(version: string, path: string, content: string): Promise<void> {
    await (await this.fs(version)).appendFile(path, content);
  }

  async appendBytes(
    version: string,
    path: string,
    data: number[]
  ): Promise<void> {
    await (await this.fs(version)).appendFile(path, new Uint8Array(data));
  }

  async read(version: string, path: string): Promise<string> {
    return (await this.fs(version)).readFile(path);
  }

  async readWithR2(version: string, path: string): Promise<string> {
    return (
      await this.fs(version, { useR2: true, inlineThreshold: 8 })
    ).readFile(path);
  }

  async readBytes(version: string, path: string): Promise<number[]> {
    return Array.from(await (await this.fs(version)).readFileBytes(path));
  }

  async readBytesWithR2(version: string, path: string): Promise<number[]> {
    return Array.from(
      await (
        await this.fs(version, { useR2: true, inlineThreshold: 8 })
      ).readFileBytes(path)
    );
  }

  async exists(version: string, path: string): Promise<boolean> {
    return (await this.fs(version)).exists(path);
  }

  async stat(version: string, path: string): Promise<FsStat> {
    return (await this.fs(version)).stat(path);
  }

  async lstat(version: string, path: string): Promise<FsStat> {
    return (await this.fs(version)).lstat(path);
  }

  async mkdir(version: string, path: string, recursive = false): Promise<void> {
    await (await this.fs(version)).mkdir(path, { recursive });
  }

  async readdir(version: string, path: string): Promise<string[]> {
    return (await this.fs(version)).readdir(path);
  }

  async readdirWithFileTypes(
    version: string,
    path: string
  ): Promise<FileSystemDirent[]> {
    return (await this.fs(version)).readdirWithFileTypes(path);
  }

  async glob(version: string, pattern: string): Promise<string[]> {
    return (await this.fs(version)).glob(pattern);
  }

  async rm(
    version: string,
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await (await this.fs(version)).rm(path, options);
  }

  async cp(
    version: string,
    src: string,
    dest: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    await (await this.fs(version)).cp(src, dest, options);
  }

  async mv(version: string, src: string, dest: string): Promise<void> {
    await (await this.fs(version)).mv(src, dest);
  }

  async symlink(
    version: string,
    target: string,
    linkPath: string
  ): Promise<void> {
    await (await this.fs(version)).symlink(target, linkPath);
  }

  async readlink(version: string, path: string): Promise<string> {
    return (await this.fs(version)).readlink(path);
  }

  async realpath(version: string, path: string): Promise<string> {
    return (await this.fs(version)).realpath(path);
  }

  async resolvePath(
    version: string,
    base: string,
    path: string
  ): Promise<string> {
    return (await this.fs(version)).resolvePath(base, path);
  }

  async getChangeLog(): Promise<VersionedFileSystemChangeEvent[]> {
    return this.changeLog;
  }

  async clearChangeLog(): Promise<void> {
    this.changeLog = [];
  }

  async startObservability(): Promise<void> {
    this.observabilityLog = [];
    this._observabilityHandler = (message: unknown) => {
      this.observabilityLog.push(message as Record<string, unknown>);
    };
    dcSubscribe("agents:versioned-filesystem", this._observabilityHandler);
  }

  async stopObservability(): Promise<void> {
    if (this._observabilityHandler) {
      dcUnsubscribe("agents:versioned-filesystem", this._observabilityHandler);
      this._observabilityHandler = null;
    }
  }

  async getObservabilityLog(): Promise<Record<string, unknown>[]> {
    return this.observabilityLog;
  }

  async clearObservabilityLog(): Promise<void> {
    this.observabilityLog = [];
  }

  async queryContentRows(): Promise<ContentRow[]> {
    return [
      ...this.ctx.storage.sql.exec(`
      SELECT hash, size, storage_backend, r2_key, content, created_at
      FROM cf_filesystem_contents
      ORDER BY hash
    `)
    ] as ContentRow[];
  }

  async queryFileRows(version: string): Promise<FileRow[]> {
    return [
      ...this.ctx.storage.sql.exec(
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
      FROM cf_filesystem_files
      WHERE version = ?
      ORDER BY path`,
        version
      )
    ] as FileRow[];
  }

  async queryVersionRows(): Promise<{ name: string; created_at: number }[]> {
    return [
      ...this.ctx.storage.sql.exec(`
      SELECT name, created_at
      FROM cf_filesystem_versions
      ORDER BY name
    `)
    ] as { name: string; created_at: number }[];
  }

  async queryFileRow(version: string, path: string): Promise<FileRow | null> {
    const rows = [
      ...this.ctx.storage.sql.exec(
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
      FROM cf_filesystem_files
      WHERE version = ? AND path = ?`,
        version,
        path
      )
    ] as FileRow[];
    return rows[0] ?? null;
  }

  async queryBlobCount(): Promise<number> {
    const rows = [
      ...this.ctx.storage.sql.exec(`
      SELECT COUNT(*) AS count
      FROM cf_filesystem_contents
    `)
    ] as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  async getMockR2Keys(): Promise<string[]> {
    return this.mockR2.listKeys();
  }

  async deleteContentRow(hash: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE FROM cf_filesystem_contents WHERE hash = ?`,
      hash
    );
  }

  async deleteMockR2Key(key: string): Promise<void> {
    await this.mockR2.delete(key);
  }

  async readError(
    version: string,
    path: string,
    options?: { useR2?: boolean; inlineThreshold?: number }
  ): Promise<{ error: string }> {
    try {
      const content = await (await this.fs(version, options)).readFile(path);
      return { error: content };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async readBytesError(
    version: string,
    path: string,
    options?: { useR2?: boolean; inlineThreshold?: number }
  ): Promise<{ error: string }> {
    try {
      await (await this.fs(version, options)).readFileBytes(path);
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async statError(version: string, path: string): Promise<{ error: string }> {
    try {
      await (await this.fs(version)).stat(path);
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async realpathError(
    version: string,
    path: string
  ): Promise<{ error: string }> {
    try {
      await (await this.fs(version)).realpath(path);
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async loopErrorProbe(): Promise<{
    read: string;
    stat: string;
    realpath: string;
  }> {
    await this.createVersion("loop-probe");
    await this.symlink("loop-probe", "/loop2", "/loop1");
    await this.symlink("loop-probe", "/loop1", "/loop2");
    const fs = await this.fs("loop-probe");

    const capture = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };

    return {
      read: await capture(() => fs.readFile("/loop1")),
      stat: await capture(() => fs.stat("/loop1")),
      realpath: await capture(() => fs.realpath("/loop1"))
    };
  }

  async readdirError(
    version: string,
    path: string
  ): Promise<{ error: string }> {
    try {
      await (await this.fs(version)).readdir(path);
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async mkdirError(
    version: string,
    path: string,
    recursive = false
  ): Promise<{ error: string }> {
    try {
      await (await this.fs(version)).mkdir(path, { recursive });
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async cpError(
    version: string,
    src: string,
    dest: string,
    options?: { recursive?: boolean }
  ): Promise<{ error: string }> {
    try {
      await (await this.fs(version)).cp(src, dest, options);
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async mvError(
    version: string,
    src: string,
    dest: string
  ): Promise<{ error: string }> {
    try {
      await (await this.fs(version)).mv(src, dest);
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async customBackendRoundtrip(): Promise<string> {
    const self = this;
    const sqlBackend: SqlBackend = {
      query(sql: string, ...params: SqlParam[]) {
        return [...self.ctx.storage.sql.exec(sql, ...params)] as never;
      },
      run(sql: string, ...params: SqlParam[]) {
        self.ctx.storage.sql.exec(sql, ...params);
      }
    };
    const storage = new FileSystemStorage({
      sql: sqlBackend,
      name: () => this.name
    });
    await storage.createVersion("custom");
    const fs = await storage.getVersion("custom");
    await fs.writeFile("/custom.txt", "via-custom-backend");
    return fs.readFile("/custom.txt");
  }

  async asyncBackendRoundtrip(): Promise<string> {
    const self = this;
    const sqlBackend: SqlBackend = {
      async query(sql: string, ...params: SqlParam[]) {
        return [...self.ctx.storage.sql.exec(sql, ...params)] as never;
      },
      async run(sql: string, ...params: SqlParam[]) {
        self.ctx.storage.sql.exec(sql, ...params);
      }
    };
    const storage = new FileSystemStorage({
      sql: sqlBackend,
      name: () => this.name
    });
    await storage.createVersion("async");
    const fs = await storage.getVersion("async");
    await fs.writeFile("/async.txt", "via-async-backend");
    return fs.readFile("/async.txt");
  }

  async writeLargeWithR2(
    version: string,
    path: string,
    content: string
  ): Promise<void> {
    await this.storage({ useR2: true, inlineThreshold: 8 }).createVersion(
      version
    );
    await (
      await this.fs(version, { useR2: true, inlineThreshold: 8 })
    ).writeFile(path, content);
  }

  async writeLargeBytesWithR2(
    version: string,
    path: string,
    data: number[]
  ): Promise<void> {
    await this.storage({ useR2: true, inlineThreshold: 8 }).createVersion(
      version
    );
    await (
      await this.fs(version, { useR2: true, inlineThreshold: 8 })
    ).writeFileBytes(path, new Uint8Array(data));
  }

  async createVersionWithR2(name: string): Promise<void> {
    await this.storage({ useR2: true, inlineThreshold: 8 }).createVersion(name);
  }

  async writeWithR2(
    version: string,
    path: string,
    content: string
  ): Promise<void> {
    await (
      await this.fs(version, { useR2: true, inlineThreshold: 8 })
    ).writeFile(path, content);
  }

  async writeBytesNoR2(
    version: string,
    path: string,
    data: number[]
  ): Promise<void> {
    await this.storage({ inlineThreshold: 1 }).createVersion(version);
    await (
      await this.fs(version, { inlineThreshold: 1 })
    ).writeFileBytes(path, new Uint8Array(data));
  }

  async callAndCaptureError(
    method: string,
    args: RowValue[]
  ): Promise<{ error: string }> {
    try {
      const fn = this[method as keyof this];
      if (typeof fn !== "function") {
        throw new Error(`unknown method: ${method}`);
      }
      await (fn as (...innerArgs: RowValue[]) => Promise<unknown>).apply(
        this,
        args
      );
      return { error: "" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
}
