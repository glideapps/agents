# Versioned File System Plan

## Goal

Add a new durable `FileSystem` implementation alongside `Workspace` that stores multiple named filesystem versions in the same database.

Each `FileSystem` instance is bound to exactly one version. Versions are mutable and isolated from each other. File contents are deduplicated across the whole database by SHA-256 hash and stored separately from file metadata.

This is intentionally a new design, not an extension of `Workspace`.

## Repository Context

This plan is for `packages/shell`.

The relevant existing pieces are:

- `src/fs/interface.ts`
  - defines the `FileSystem` interface used by the shell state backend
- `src/filesystem.ts`
  - defines `Workspace`, the current durable filesystem backed by SQLite + optional R2
- `src/workspace.ts`
  - defines `WorkspaceFileSystem`, a thin adapter that makes `Workspace` satisfy `FileSystem`
- `src/index.ts`
  - exports the public package surface

Today, `Workspace` stores one row per path in a single table per namespace. Each row contains both metadata and either inline content or an R2 pointer. That means content is path-addressed, not content-addressed, and there is no built-in notion of multiple named filesystem versions.

This plan proposes a new implementation that keeps `Workspace` unchanged, but adds a separate version-aware durable filesystem with content-addressed blob storage.

## FileSystem Contract Context

The new bound filesystem must satisfy the existing `FileSystem` interface used by the shell state backend.

That interface includes these operations:

- `readFile`
- `readFileBytes`
- `writeFile`
- `writeFileBytes`
- `appendFile`
- `exists`
- `stat`
- `lstat`
- `mkdir`
- `readdir`
- `readdirWithFileTypes`
- `rm`
- `cp`
- `mv`
- `symlink`
- `readlink`
- `realpath`
- `resolvePath`
- `glob`

Important behavioral expectations from the existing interface:

- `readFile`, `readFileBytes`, `stat`, and `lstat` throw `ENOENT` when the path does not exist
- `exists` returns `false` for missing paths and does not throw
- `glob` returns sorted absolute paths
- symlink behavior should match current `Workspace` behavior closely

This means the new versioned implementation is not just a blob store or metadata store. It must behave like a full filesystem from the point of view of existing shell code.

## Tests-First Requirement

Implementation must start with tests.

That is not optional. Tests are the highest priority for this work.

Before writing the implementation:

1. add or update tests that define the expected API and behavior
2. cover version lifecycle, version isolation, blob deduplication, and observability
3. only then implement the production code to satisfy those tests

The intended workflow is:

- write failing tests first
- implement the smallest amount of code needed to make them pass
- expand test coverage before broad refactors

When in doubt, add a test first.

## Summary of Decisions

- Start implementation with tests; tests come before production code.
- Implement a new `FileSystem` directly; do not wrap a `Workspace`.
- Introduce a separate `FileSystemStorage` abstraction for version management.
- Bind each filesystem instance to a single explicit version.
- Versions are strings and must already exist when accessed via the async factory.
- `createVersion(name)` creates an empty version.
- `copyVersion(sourceName, destName)` creates `destName` by copying all rows from `sourceName`.
- File rows do not store file contents directly; they store `content_hash`.
- File contents are deduplicated globally across the database by SHA-256 of raw bytes.
- Large content uses the same `R2 + inlineThreshold` strategy as `Workspace`, but with hash-based R2 keys.
- Preserve the same metadata `Workspace` stores: file type, mime type, size, symlink target, timestamps, etc.
- Preserve `created_at` and `modified_at` when copying versions.
- If the destination version already exists, `createVersion` and `copyVersion` throw.
- Omit `Workspace` namespaces from this new design.
- Keep `onChange` callbacks and diagnostics-channel observability.
- Do not implement version deletion or blob cleanup yet.

## Proposed API

### Storage layer

Introduce a new storage-oriented class responsible for schema management and version lifecycle:

```ts
export interface FileSystemStorageOptions {
  sql: SqlSource;
  r2?: R2Bucket;
  r2Prefix?: string;
  inlineThreshold?: number;
  name?: string | (() => string | undefined);
  onChange?: (event: VersionedFileSystemChangeEvent) => void;
}

export class FileSystemStorage {
  constructor(options: FileSystemStorageOptions);

  getVersion(name: string): Promise<VersionedFileSystem>;
  createVersion(name: string): Promise<void>;
  copyVersion(sourceName: string, destName: string): Promise<void>;
}
```

### Bound filesystem

Introduce a concrete filesystem implementation:

```ts
export class VersionedFileSystem implements FileSystem {
  // bound to one existing version
}
```

`getVersion(name)` is the async factory method that validates the version exists and returns a filesystem bound to it.

The bound instance should not expose `copyVersion` or `createVersion` methods.

## Table Schema

Use fixed table names rather than `Workspace`-style namespaced table names.

### `cf_filesystem_versions`

Tracks known versions.

Suggested columns:

- `name TEXT PRIMARY KEY`
- `created_at INTEGER NOT NULL`

### `cf_filesystem_files`

Stores per-version filesystem entries.

Suggested columns:

- `version TEXT NOT NULL`
- `path TEXT NOT NULL`
- `parent_path TEXT NOT NULL`
- `name TEXT NOT NULL`
- `type TEXT NOT NULL CHECK(type IN ('file','directory','symlink'))`
- `mime_type TEXT NOT NULL DEFAULT 'text/plain'`
- `size INTEGER NOT NULL DEFAULT 0`
- `target TEXT`
- `content_encoding TEXT NOT NULL DEFAULT 'utf8'`
- `content_hash TEXT`
- `created_at INTEGER NOT NULL`
- `modified_at INTEGER NOT NULL`

Suggested constraints and indexes:

- `PRIMARY KEY(version, path)`
- index on `(version, parent_path)`
- optional index on `(version, type)` if useful later
- `FOREIGN KEY(version) REFERENCES cf_filesystem_versions(name)` if the target backend supports/enforces it

Notes:

- Only file rows should have `content_hash`.
- Directory and symlink rows should leave `content_hash` null.
- Symlink rows should use `target` exactly like `Workspace`.
- `content_encoding` is preserved for compatibility with current metadata expectations, even though the actual content lives elsewhere.

### `cf_filesystem_contents`

Stores deduplicated content blobs.

Suggested columns:

- `hash TEXT PRIMARY KEY`
- `size INTEGER NOT NULL`
- `storage_backend TEXT NOT NULL CHECK(storage_backend IN ('inline','r2'))`
- `r2_key TEXT`
- `content TEXT`
- `created_at INTEGER NOT NULL`

Notes:

- For `inline` storage, `content` holds either UTF-8 text or base64-encoded binary, matching `content_encoding` from the file row.
- For `r2` storage, `content` is null and `r2_key` is set.
- Deduplication is global across the whole database, not per version.

## Version Semantics

### Creating a version

`createVersion(name)` should:

1. Ensure schema exists.
2. Fail with `EEXIST`-style error if `name` already exists.
3. Insert a row into `cf_filesystem_versions`.
4. Insert the root directory row for that version:
   - `path = '/'`
   - `parent_path = ''`
   - `name = ''`
   - `type = 'directory'`
   - `size = 0`
5. Emit observability for version creation.

### Copying a version

`copyVersion(sourceName, destName)` should:

1. Ensure schema exists.
2. Verify `sourceName` exists.
3. Fail if `destName` already exists.
4. Insert `destName` into `cf_filesystem_versions`.
5. Copy all rows from `cf_filesystem_files` where `version = sourceName` to `version = destName`.
6. Preserve `created_at` and `modified_at` exactly.
7. Reuse the same `content_hash` values; do not duplicate blobs.
8. Emit observability for version copy.

This means version copy is a metadata copy, not a blob copy.

### Getting a version

`getVersion(name)` should:

1. Ensure schema exists.
2. Verify `name` exists.
3. Throw if missing.
4. Return a `VersionedFileSystem` instance bound to `name`.

Constructing a bound filesystem for a non-existent version should not be possible through the public async factory.

## Content Addressing

### Hashing

- Hash algorithm: SHA-256
- Input: raw file bytes
- Text and binary writes dedupe if their raw bytes are identical

### Writing content

On file write:

1. Normalize and validate the target path.
2. Encode the incoming content to bytes.
3. Compute SHA-256 over the raw bytes.
4. Check whether `cf_filesystem_contents` already has that hash.
5. If absent, store the blob:
   - inline if below `inlineThreshold`
   - in R2 otherwise, if R2 is configured
   - inline with warning if above threshold and no R2 bucket exists
6. Upsert the file row for `(version, path)` with the new metadata and `content_hash`.

### R2 key layout

R2 objects should be hash-addressed rather than path-addressed.

Suggested format:

```txt
<prefix>/blobs/<sha256>
```

If desired, this can later be fan-out partitioned for large blob counts, e.g.:

```txt
<prefix>/blobs/ab/cd/<sha256>
```

but a flat `blobs/<sha256>` layout is sufficient initially.

### Reading content

On read:

1. Resolve the `(version, path)` row.
2. Verify it is a file.
3. Load the associated content row via `content_hash`.
4. Read from inline content or R2 depending on `storage_backend`.
5. Decode according to `content_encoding`.

If a file row references missing blob content, surface a hard error because that indicates data corruption or partial external deletion.

## Filesystem Behavior

`VersionedFileSystem` should provide the same operational behavior and metadata semantics as `Workspace` where practical.

Supported features should match the `FileSystem` interface:

- `readFile`
- `readFileBytes`
- `writeFile`
- `writeFileBytes`
- `appendFile`
- `exists`
- `stat`
- `lstat`
- `mkdir`
- `readdir`
- `readdirWithFileTypes`
- `rm`
- `cp`
- `mv`
- `symlink`
- `readlink`
- `realpath`
- `resolvePath`
- `glob`

Behavioral parity targets with `Workspace`:

- same path normalization rules
- same symlink semantics and loop limits
- same root directory semantics
- same directory creation behavior
- same recursive remove / copy / move behavior
- same basic error shape conventions (`ENOENT`, `EEXIST`, `EISDIR`, etc.)
- same timestamp metadata model

The main internal difference is that file content lookup is indirect through `content_hash`.

## Metadata Handling

Preserve all metadata currently stored by `Workspace`:

- `type`
- `mime_type`
- `size`
- `target`
- `content_encoding`
- `created_at`
- `modified_at`

Additional notes:

- Directory metadata remains stored directly in file rows.
- Symlinks have no `content_hash`.
- File `size` should remain denormalized on the file row for fast stat/readDir operations.
- Blob `size` is also stored in `cf_filesystem_contents` for validation and observability.

## Observability and Change Events

Preserve the same style of observability as `Workspace`.

### `onChange`

Support an `onChange` callback in storage options.

Suggested event shape:

```ts
export type VersionedFileSystemChangeType = "create" | "update" | "delete";

export type VersionedFileSystemChangeEvent = {
  type: VersionedFileSystemChangeType;
  version: string;
  path: string;
  entryType: "file" | "directory" | "symlink";
};
```

All mutations performed through a bound version should emit events tagged with that version.

### Diagnostics channel

Publish diagnostics events analogous to `Workspace`, but include `version` in the payload.

Suggested channel name:

- either reuse the existing channel with new event types
- or introduce a dedicated channel such as `agents:versioned-filesystem`

Suggested event types:

- `versioned-filesystem:read`
- `versioned-filesystem:write`
- `versioned-filesystem:delete`
- `versioned-filesystem:mkdir`
- `versioned-filesystem:rm`
- `versioned-filesystem:cp`
- `versioned-filesystem:mv`
- `versioned-filesystem:create-version`
- `versioned-filesystem:copy-version`

Each payload should include at least:

- `version` when the action is version-scoped
- `path` where applicable
- `size` for writes when known
- `storage` (`inline` or `r2`) for content operations when relevant
- `update` for overwrites when relevant

## Error Handling Expectations

- `getVersion(name)` throws if the version does not exist.
- `createVersion(name)` throws if the version already exists.
- `copyVersion(sourceName, destName)` throws if the source is missing or destination already exists.
- `FileSystem` methods should follow the existing interface contract:
  - missing paths throw `ENOENT`
  - `exists` returns boolean and never throws for missing paths
- Missing content blobs referenced by a file row should throw a corruption-style error.

## Non-Goals for Initial Implementation

These are intentionally out of scope for the first pass:

- deleting versions
- listing versions
- checking version existence as a separate public method
- content blob garbage collection
- reference counting for content blobs
- copy-on-write optimization for file rows
- transactional cross-row blob cleanup beyond best-effort handling already used in `Workspace`

## Implementation Strategy

Implementation must begin with tests. Do not start by writing production code.

### 1. Add tests first

Before creating the implementation, add failing tests that lock down the desired behavior.

Add tests covering at least:

#### Version lifecycle

- creating an empty version
- getting an existing version
- getting a missing version throws
- creating an already existing version throws
- copying a version clones all rows
- copying preserves timestamps
- copying to an existing version throws
- copying from a missing version throws

#### Content deduplication

- same content written in same version produces one blob row
- same content written in different versions produces one blob row
- text and bytes with identical raw bytes dedupe to the same blob
- overwriting a file to point at a different hash updates only the file row and leaves old blobs intact

#### File operations

- read/write roundtrips for text and bytes
- append behavior
- mkdir/readdir/glob/stat/lstat
- symlink behavior
- rm/cp/mv behavior within one version
- isolation between versions
- `FileSystem` contract behavior for missing paths and `exists`

#### R2 behavior

- large content spills to R2
- blob keys are hash-based
- same content in multiple files/versions reuses one R2 object row
- missing R2 configuration falls back inline with warning

#### Observability

- `onChange` includes `version`
- diagnostics payloads include `version`
- version creation and copy publish observability events

Only after these tests exist should the implementation begin.

### 2. Add new source file(s)

Suggested structure:

- `src/versioned-filesystem.ts`
  - `FileSystemStorage`
  - `VersionedFileSystem`
  - shared types/options

If the file grows large, split internals later, but start with one file for iteration speed.

### 3. Reuse proven helpers from `Workspace`

Lift or adapt the following patterns from `src/filesystem.ts`:

- SQL backend normalization (`SqlSource`, `SqlBackend`, `toBackend`)
- path normalization helpers
- glob helpers
- symlink resolution
- `R2 + inlineThreshold` handling
- diagnostics-channel publishing
- change-event emission

Do not couple the new implementation to `Workspace` at runtime.

### 4. Implement schema initialization

Lazy-init the three tables:

- `cf_filesystem_versions`
- `cf_filesystem_files`
- `cf_filesystem_contents`

Also create the necessary indexes.

### 5. Implement version lifecycle methods

- `createVersion`
- `copyVersion`
- `getVersion`

These should all share the same initialization path.

### 6. Implement blob store helpers

Add internal helpers for:

- computing SHA-256
- checking whether a blob already exists
- inserting inline blob rows
- inserting R2-backed blob rows
- reading blob bytes/text from hash
- generating hash-based R2 keys

### 7. Implement the bound filesystem

Build the `FileSystem` implementation around `(version, path)` lookups.

Keep the public behavior as close as possible to `WorkspaceFileSystem` + `Workspace` semantics, but without the adapter layer.

### 8. Export from package root

Update `src/index.ts` to export the new types/classes.

Potential exports:

```ts
export {
  FileSystemStorage,
  VersionedFileSystem,
  type FileSystemStorageOptions,
  type VersionedFileSystemChangeEvent,
  type VersionedFileSystemChangeType
} from "./versioned-filesystem";
```

### 9. Run and extend tests continuously

After each implementation slice, run the relevant tests and expand coverage before moving on.

Suggested order:

1. version lifecycle tests
2. content deduplication tests
3. basic file operation tests
4. symlink / recursive operation tests
5. R2 overflow tests
6. observability tests

Do not leave major behavior untested while continuing implementation.

## Migration / Compatibility Notes

This should be additive.

- Do not replace `Workspace`.
- Do not change `WorkspaceFileSystem`.
- Existing callers should remain unaffected.
- The new implementation is a separate durable storage option for use cases that need versioned state and content deduplication.

## Open Choices to Resolve During Implementation

These are not blocking, but should be decided in code while implementing:

- whether to fan out hash-based R2 keys into prefix directories
- whether diagnostics should reuse `agents:workspace` or use a new channel name
- whether helper types should be shared with `Workspace` or duplicated initially for decoupling

## Recommended First Pass

For the first implementation, optimize for correctness and API clarity:

- start with failing tests, not production code
- get the schema and version lifecycle right
- keep filesystem semantics close to `Workspace`
- dedupe blobs correctly by SHA-256
- preserve metadata and timestamps
- include observability from the start
- defer cleanup and extra management APIs

A good execution order is:

1. write lifecycle and dedup tests
2. implement schema init and version management
3. implement basic read/write/stat behavior
4. implement directory, symlink, and recursive operations
5. implement R2 overflow handling
6. finish observability details
7. expand and harden tests before cleanup/refactor work
