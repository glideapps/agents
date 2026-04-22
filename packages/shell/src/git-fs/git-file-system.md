# GitFileSystem implementation plan

## Goal

Implement a new `GitFileSystem` that satisfies the `FileSystem` interface from `src/fs/interface.ts` while storing all state as a git repository inside another `FileSystem`.

To callers of `GitFileSystem`, git is completely opaque:

- reads come from the tree at `HEAD`
- mutating `FileSystem` calls create commits directly
- there is no exposed staging area, checkout, branch API, or history API

Internally, `GitFileSystem` will use `isomorphic-git`'s low-level object APIs to write:

- blobs
- trees
- commits
- refs

without relying on normal working-tree + index workflows.

---

## Confirmed design decisions

### Repository layout

- The backing store is another `FileSystem`.
- Inside that backing store, `GitFileSystem` will create a normal repo layout with a `.git/` directory.
- `HEAD` will be a symbolic ref to `refs/heads/main`.
- The filesystem view is the tree of `refs/heads/main`.
- The repo is opaque to callers of `GitFileSystem`.
- Important distinction:
  - the backing store's `.git/` directory is internal repository metadata and is **not** directly exposed through the `GitFileSystem` API
  - a path named `/.git` inside the committed tree is perfectly valid user content and should be treated like any other visible path

### Initialization

If the repo is missing, `GitFileSystem` will auto-initialize it with:

- `.git/HEAD` = symbolic ref to `refs/heads/main`
- an initial empty commit
- `refs/heads/main` pointing at that empty commit

### Mutation semantics

- One mutating `FileSystem` call creates at most one commit.
- If an operation is a no-op, it should not create a commit.
- Multi-file operations like recursive `rm`, `cp`, and `mv` still create a single commit.

### Metadata

- Commit messages are auto-generated.
- Author/committer identity is injected at instance creation.
- Timestamps use `Date.now()`.

### Filesystem semantics

- Support the full `FileSystem` interface in `src/fs/interface.ts`.
- Support symlinks using git's native symlink representation.
- Preserve executable bits if they already exist in underlying git trees.
- Do not add public APIs to set executable bits.
- Preserve empty directories by writing explicit tree objects.
- No extra history API for now.
- Assume single-writer access.

---

## Non-goals

This implementation should not:

- expose git internals to callers
- expose branch, tag, log, reset, or checkout operations
- maintain or use a staging area as part of its public behavior
- require a working-tree checkout in the backing `FileSystem`
- implement extra `InMemoryFs`-specific methods like `chmod`, `utimes`, or `link`

---

## Public API shape

## New class

Add a new class:

```ts
export class GitFileSystem implements FileSystem {
  constructor(options: GitFileSystemOptions);
}
```

## Options

```ts
export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitFileSystemOptions {
  storage: FileSystem;
  dir?: string; // default: "/repo"
  gitdir?: string; // default: `${dir}/.git`
  branchRef?: string; // default: "refs/heads/main"
  identity: GitIdentity;
}
```

### Notes

- `storage` is the backing `FileSystem` where repo files live.
- `dir` is the logical work tree path used by `isomorphic-git`.
- `gitdir` defaults to `join(dir, ".git")`.
- `branchRef` defaults to `refs/heads/main` but should remain configurable.
- We should not expose git-specific knobs beyond what is needed for storage layout and identity.

---

## Internal architecture

## Layers

```text
Caller
  ↓
GitFileSystem (implements FileSystem)
  ↓
RepoState cache + tree mutation helpers
  ↓
isomorphic-git low-level APIs
  ↓
Git adapter over backing FileSystem
  ↓
backing FileSystem
```

## Key internal components

### 1. Backing git fs adapter

Reuse the existing `createGitFs` adapter from `src/git/fs-adapter.ts`.

Purpose:

- adapt the backing `FileSystem` into the Node-like `fs.promises` shape expected by `isomorphic-git`
- store `.git` objects, refs, and metadata in the backing filesystem

Important: `createGitFs` is for the backing store only, not for exposing `GitFileSystem` itself. That means the backing store's repo metadata may physically live under something like `/repo/.git`, while the visible tree exposed by `GitFileSystem` can still legitimately contain its own `/.git` directory as committed user data.

### 2. Repository bootstrap helper

A private `ensureInit()` method should:

1. detect whether the repo exists
2. if not, initialize it
3. create the initial empty commit
4. set `refs/heads/main`
5. ensure `HEAD` is symbolic to that ref

### 3. Head snapshot loader

A helper should read the current committed tree from `HEAD` into an in-memory tree model.

This model will drive:

- reads
- mutations
- recursive operations
- glob
- stat / lstat / readdir

### 4. Commit writer

A helper should:

1. serialize changed nodes into git objects
2. write blobs and trees bottom-up
3. write a new commit with parent = previous head
4. advance the branch ref

---

## In-memory tree model

Use a git-oriented tree representation, but **do not eagerly materialize the whole repository** and **do not keep blob contents in memory as part of the tree**.

The logical model is still tree-shaped, because git itself is tree-shaped, but operations should load only the path or subtree they need.

```ts
type GitFsNode = GitFsFileNode | GitFsDirNode | GitFsSymlinkNode;

interface GitFsFileNode {
  kind: "file";
  oid: string;
  mode: "100644" | "100755";
  size?: number;
}

interface GitFsDirNode {
  kind: "dir";
  oid?: string;
  children: Map<string, GitFsNode>;
}

interface GitFsSymlinkNode {
  kind: "symlink";
  oid: string;
  target?: string;
}
```

### Why this model

It gives us a single logical representation for:

- committed files
- committed symlinks
- explicit empty directories
- path resolution
- subtree rewrites
- recursive operations

while still allowing lazy access:

- file nodes store blob identity and mode, not file contents
- directory nodes can be loaded only for the path/subtree being traversed
- blob contents are loaded only when needed for a specific read or mutation

### Important semantic choices

- Directories exist explicitly in memory and in git trees.
- Empty directories are preserved by writing explicit tree entries pointing at empty tree objects.
- Symlinks are represented separately in memory, even though git stores them as blobs with mode `120000`.
- Large blobs are never retained in the lazy tree model; they are fetched transiently and returned or transformed immediately.

---

## Mapping between git objects and in-memory nodes

## Reading from git

Use `resolveRef`, `readCommit`, and `readTree` lazily along the path or subtree needed by the operation.

### Files

Git tree entry:

- `type: "blob"`
- `mode: "100644"` or `"100755"`

becomes:

```ts
{
  kind: ("file", oid, mode);
}
```

Blob bytes should be loaded via `readBlob` only when a specific operation needs them, such as `readFile`, `readFileBytes`, `appendFile`, or content-preserving copies.

### Symlinks

Git tree entry:

- `type: "blob"`
- `mode: "120000"`

becomes:

```ts
{
  kind: ("symlink", target);
}
```

where `target` is the UTF-8 content of the blob.

### Directories

Git tree entry:

- `type: "tree"`
- `mode: "040000"`

becomes:

```ts
{
  kind: ("dir", oid, children);
}
```

Directory children should be loaded only when that directory is traversed. Do not recursively load the full repository tree unless the specific operation requires it.

## Writing to git

### Files

- write bytes with `writeBlob`
- emit tree entry with mode `100644` or `100755`

### Symlinks

- encode target string as UTF-8 bytes
- write as blob via `writeBlob`
- emit tree entry with mode `120000`

### Directories

- recursively write child nodes
- assemble `TreeObject`
- write via `writeTree`
- emit parent entry with mode `040000`

---

## Repository initialization details

## Bootstrap sequence

On first use:

1. `git.init({ fs, dir, gitdir, defaultBranch: "main" })`
2. ensure `.git/HEAD` is symbolic to `refs/heads/main`
3. write the empty tree
4. write an initial commit with:
   - `tree = <empty-tree-oid>`
   - `parent = []`
   - message like `init`
   - injected author / committer
5. `writeRef({ ref: "refs/heads/main", value: <commit-oid>, force: true })`
6. `writeRef({ ref: "HEAD", value: "refs/heads/main", symbolic: true, force: true })`

## Empty tree oid

Two acceptable strategies:

### Option A: compute naturally

Call `writeTree({ tree: [] })` and use the returned oid.

### Option B: rely on the canonical empty-tree oid

Use the well-known empty tree oid if desired.

Preferred: Option A, since it keeps the implementation uniform and avoids magic constants.

---

## Path semantics

Use the same normalized absolute path semantics as the other filesystem implementations:

- all public paths are absolute
- `/` is the root directory of the committed tree
- `.` and `..` are normalized away
- symlink resolution should match `InMemoryFs` and `WorkspaceFileSystem` behavior

Private helpers should mirror the existing path helper style used in:

- `src/fs/in-memory-fs.ts`
- `src/workspace.ts`

Consider extracting shared path helpers if it keeps code clean, but only if the extraction is obviously beneficial.

---

## Read path plan

## `exists(path)`

- Resolve only the trees needed to walk that path.
- Resolve the path without throwing.
- Return `true` if the node exists.
- Return `false` on invalid/missing path.

## `readFile(path)`

- Resolve only the trees needed to find the target.
- Resolve symlinks for the final target.
- Fail on missing path with `ENOENT`.
- Fail on directories with `EISDIR`.
- Load the target blob on demand.
- Decode bytes as UTF-8.
- Do not retain blob contents in the lazy tree after returning.

## `readFileBytes(path)`

- Same as `readFile`, but return raw bytes.
- Do not retain blob contents in the lazy tree after returning.

## `stat(path)`

- Follow the final symlink.
- Return `FsStat` using git node type and byte size.
- `mtime` should come from the current head commit timestamp.

## `lstat(path)`

- Do not follow the final symlink.
- Otherwise same as `stat`.

## `readdir(path)` / `readdirWithFileTypes(path)`

- Resolve the directory.
- Fail with `ENOENT` if missing.
- Fail with `ENOTDIR` if not a directory.
- Return sorted names / dirents.

## `glob(pattern)`

- Walk the git tree lazily and match normalized absolute paths.
- This may require traversing a large part of the repo, but should still avoid loading blob contents unless necessary.
- Return sorted absolute paths.
- Reuse existing glob helper logic if possible.

## `readlink(path)`

- Require the final node to be a symlink.
- Return the symlink target string.

## `realpath(path)`

- Resolve chained symlinks recursively.
- Use the same loop limit semantics as `InMemoryFs` / `WorkspaceFileSystem`.

## `resolvePath(base, path)`

- Pure path helper.
- No git IO required.

---

## Write path plan

All mutations follow the same high-level flow:

1. `ensureInit()`
2. resolve current head oid
3. load only the path/subtree and ancestor chain needed for the mutation
4. apply the mutation in memory
5. detect whether anything actually changed
6. if changed:
   - rewrite only the affected subtree and its ancestors up to the root
   - write a commit
   - advance the branch ref

## Shared commit helper

Implement a private helper like:

```ts
private async mutate(
  message: string,
  apply: (root: GitFsDirNode) => Promise<boolean> | boolean
): Promise<void>
```

Responsibilities:

- load current head state lazily
- load only the affected ancestor chain and subtree
- clone or mutate only the loaded structures
- call `apply`
- if `apply` returns false or produces no semantic diff, do nothing
- otherwise rewrite the changed subtree and its ancestor chain, then update the branch ref

This helper is the heart of the implementation.

---

## Per-method mutation behavior

## `writeFile(path, content)`

- Normalize path.
- Reject `/` with `EISDIR`.
- Resolve intermediate symlinks when traversing parents.
- Ensure parent directories exist.
- Write/replace the file node with mode:
  - preserve existing file mode if it was `100755`
  - otherwise use `100644`
- Commit message:
  - `write /path`

## `writeFileBytes(path, content)`

- Same as `writeFile`, but keep bytes.

## `appendFile(path, content)`

- If missing, create a new regular file.
- If existing file, append bytes.
- If directory, throw `EISDIR`.
- If symlink, follow it like the other implementations do.
- Commit message:
  - `append /path`

## `mkdir(path, { recursive })`

Because this design supports explicit tree entries, `mkdir` should persist directories even when empty.

Behavior:

- `/` is a no-op, or throws only where consistent with existing behavior
- create explicit dir nodes
- honor `recursive`
- error on file collisions
- no commit if the directory already exists and no state changes

Commit messages:

- `mkdir /path`
- `mkdir -p /path` when recursive is true

## `rm(path, { recursive, force })`

- Remove files, symlinks, or directories from the in-memory tree.
- Honor `recursive` and `force`.
- Reject removing `/`.
- Recursive delete of a directory should be a single commit.

Commit message:

- `rm /path`

## `cp(src, dest, { recursive })`

- Resolve source using `lstat` semantics first.
- Preserve symlinks as symlinks.
- Preserve file mode for regular files.
- Preserve explicit directories, including empty directories.
- Reject directory copies without `recursive`.
- Commit once after the full copy.

Commit message:

- `cp /src -> /dest`

## `mv(src, dest)`

- Move the node in memory.
- Preserve symlinks and explicit directories.
- Commit once.

Commit message:

- `mv /src -> /dest`

## `symlink(target, linkPath)`

- Create a symlink node.
- Store the target string exactly as provided.
- Serialize as blob + mode `120000`.

Commit message:

- `symlink /linkPath`

---

## Commit construction plan

## Reading head

Use:

- `resolveRef({ ref: branchRef })` to get current head oid
- `readCommit` to get the current commit
- `readTree` / `readBlob` recursively to reconstruct the root tree

## Writing blobs and trees

Implement serializers that rewrite only the changed subtree and its ancestors.

```ts
private async writeNode(node: GitFsNode): Promise<{ oid: string; mode?: string; type: "blob" | "tree" }>
```

Or more likely:

```ts
private async writeTreeNode(dir: GitFsDirNode): Promise<string>
```

Behavior:

- for each changed child:
  - file -> `writeBlob` from transient bytes supplied by the mutation
  - symlink -> `writeBlob` of target string
  - dir -> recursive `writeTreeNode`
- for each unchanged child, reuse its existing `oid` and mode without re-reading blob contents
- assemble a sorted `TreeObject`
- call `writeTree`
- return tree oid

## Writing the commit

Construct:

```ts
const commit: CommitObject = {
  message,
  tree: rootTreeOid,
  parent: [previousHeadOid],
  author,
  committer
};
```

Then:

- `writeCommit({ commit })`
- `writeRef({ ref: branchRef, value: commitOid, force: true })`

We should leave `HEAD` symbolic and stable, not rewrite it on every mutation.

---

## Detecting no-op mutations

Avoid creating commits when nothing changes.

Examples:

- writing the same file bytes
- `mkdir` on an existing directory when that is a no-op
- `rm` with `force: true` on a missing path
- `cp` resulting in identical state

Recommended approach:

- mutate the in-memory tree
- compare resulting structure against original during mutation, or
- compute a `changed` boolean in helper functions

Do not rely on comparing newly written tree oid to old tree oid after writing, because that still does unnecessary git object writes.

---

## `FsStat` semantics

The `FileSystem` interface requires:

```ts
interface FsStat {
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: Date;
  mode?: number;
}
```

Plan:

- `type`: from the in-memory node
- `size`:
  - file: byte length
  - symlink: target string byte length or string length; prefer byte length for consistency
  - directory: `0`
- `mtime`:
  - use the current head commit's committer timestamp for all nodes in that snapshot
- `mode`:
  - regular file: `0o100644` or `0o100755`
  - directory: `0o040000`
  - symlink: `0o120000`

Note that per-path mtimes are not available from git trees alone. Snapshot-level commit time is the best fit without extra metadata.

---

## Empty-directory strategy

This implementation will intentionally preserve empty directories by writing explicit tree entries for them.

Example:

```text
/
└── empty/
```

will be serialized as:

- root tree contains entry `empty` of type `tree` and mode `040000`
- that entry points to an empty tree object

## Important compatibility note

This is valid in git object terms, but it is unusual compared to normal git porcelain workflows.

Implications:

- `GitFileSystem` can round-trip empty directories correctly
- external git tools may or may not preserve those empty tree entries if they rewrite history using the normal index-based model

That is acceptable for this design because `GitFileSystem` owns the repo semantics.

---

## Symlink semantics

Support the same conceptual behavior as the existing filesystem implementations:

- `stat` follows the final symlink
- `lstat` does not
- `readlink` returns the stored target
- `realpath` resolves chained symlinks with loop detection
- path traversal should resolve intermediate symlinks

Serialize symlinks using git's native representation:

- mode `120000`
- blob content = symlink target string

---

## Interaction with the backing `FileSystem`

The backing `FileSystem` stores:

- `.git/objects/**`
- `.git/refs/**`
- `.git/HEAD`
- other git metadata created by `isomorphic-git`

The backing store does not need to contain checked-out working tree files for the committed tree view.

All committed content lives in git objects.

The visible tree presented by `GitFileSystem` is reconstructed from git objects, not from checked-out files.

This distinction matters for `/.git`:

- internal repo metadata lives in the backing store under the configured `gitdir`
- visible `GitFileSystem` paths come from the committed tree rooted at `HEAD`
- therefore a committed `/.git/**` subtree is allowed and should behave like normal user content
- but callers of `GitFileSystem` still do not get direct access to the backing store's internal repo metadata

---

## Error behavior

Match existing `FileSystem` conventions as closely as possible:

- missing file for `readFile`, `readFileBytes`, `stat`, `lstat` -> `ENOENT`
- reading a directory as a file -> `EISDIR`
- readdir on a non-directory -> `ENOTDIR`
- existing path collisions -> `EEXIST`
- symlink loops -> `ELOOP`
- remove root -> `EPERM`
- invalid `readlink` target -> `EINVAL`

Where possible, mirror message style already used by:

- `src/fs/in-memory-fs.ts`
- `src/workspace.ts`

---

## Suggested file layout

Add new source files:

- `src/fs/git-file-system.ts`
- optionally `src/fs/git-tree.ts` if tree loading / serialization becomes large

Potential exports:

- `GitFileSystem`
- `GitFileSystemOptions`
- `GitIdentity`

Update exports in:

- `src/index.ts`

Possibly document in:

- `README.md`

---

## Implementation phases

## Phase 1: scaffolding

1. Add `GitFileSystem` class and options types.
2. Wire backing storage to `createGitFs`.
3. Implement `ensureInit()`.
4. Export the new class.

Deliverable:

- repo bootstraps successfully
- initial empty commit exists
- `HEAD` is symbolic to `refs/heads/main`

## Phase 2: snapshot loading

1. Implement root snapshot loading from `HEAD`.
2. Implement in-memory node types.
3. Implement path normalization and lookup helpers.
4. Implement read-only methods:
   - `exists`
   - `readFile`
   - `readFileBytes`
   - `stat`
   - `lstat`
   - `readdir`
   - `readdirWithFileTypes`
   - `readlink`
   - `realpath`
   - `resolvePath`
   - `glob`

Deliverable:

- `GitFileSystem` can serve as a read-only committed-tree filesystem

## Phase 3: tree writing and commits

1. Implement node-to-git serialization.
2. Implement shared `mutate()` helper.
3. Implement:
   - `writeFile`
   - `writeFileBytes`
   - `appendFile`
   - `mkdir`
   - `rm`
   - `symlink`

Deliverable:

- basic mutations create commits directly

## Phase 4: copy and move

1. Implement deep clone helpers for nodes.
2. Implement `cp`.
3. Implement `mv`.
4. Ensure recursive semantics and one-commit-per-call behavior.

Deliverable:

- full `FileSystem` surface implemented

## Phase 5: correctness and polish

1. Add no-op detection.
2. Preserve executable modes when rewriting existing files.
3. Refine error messages.
4. Add tests for empty directories and symlinks.
5. Document caveats around snapshot-level mtimes.

---

## Test plan

## Contract tests

Use the existing `FileSystem` contract expectations from `src/fs/interface.ts` and adapt existing `InMemoryFs` tests into reusable coverage where practical.

## New `GitFileSystem` tests

Add targeted tests for:

### Initialization

- auto-creates repo on first use
- creates initial empty commit
- `HEAD` is symbolic to `refs/heads/main`

### Read behavior

- reads files from committed tree
- `stat` vs `lstat` semantics
- directory listing
- globbing

### Mutation behavior

- `writeFile` creates a new commit
- no-op write does not create a commit
- `appendFile` creates one commit
- recursive `rm` creates one commit
- recursive `cp` creates one commit
- `mv` creates one commit

### Git object behavior

- head ref advances after mutation
- commit parent chain is linear
- blob contents match file contents
- symlink stored as mode `120000`
- preserved executable mode if source tree used `100755`

### Empty directories

- `mkdir` persists an empty directory
- empty directory survives reload from `HEAD`
- nested empty directories survive reload

### Compatibility tests

- `FileSystemStateBackend` works over `new GitFileSystem(...)`
- `createGit(new GitFileSystem(...))` is either explicitly supported and tested, or explicitly rejected and documented

## Important note about nested git-on-git

If we want `createGit(new GitFileSystem(...))`, we must be careful not to create confusing recursion:

- `GitFileSystem` itself uses git objects internally
- `createGit(...)` would use the visible committed tree as another git worktree-like filesystem

This may be valid, but it should be an intentional choice. If it is not a target use case, document that the primary supported composition is:

- backing `FileSystem` -> `GitFileSystem`
- not git commands against `GitFileSystem` itself

---

## Open implementation choice: snapshot caching

We can choose one of two strategies.

### Option A: resolve from git objects on every call

Pros:

- simplest
- always reflects latest committed state
- safe under the single-writer assumption
- avoids retaining large blob contents in memory

Cons:

- more object reads

### Option B: cache lightweight tree metadata

Pros:

- fewer repeated tree reads

Cons:

- more invalidation logic
- must be careful never to cache large blob contents as part of the tree model

Recommended initial version:

- start with Option A
- optionally cache only lightweight metadata later, never blob contents
- only add caching if profiling shows it matters

---

## Recommended first implementation choices

To reduce risk, the first implementation should:

- resolve from `HEAD` for every public call
- load only the trees needed for the path or subtree being operated on
- never retain blob contents in the lazy tree model
- rewrite only the changed subtree and its ancestors for each commit
- prefer correctness and clarity over aggressive caching

This is still simple, but it avoids assuming that the whole repo fits in memory.

Optimization can come later by memoizing unchanged subtree oids or lightweight tree metadata.

---

## Summary of the concrete plan

Implement `GitFileSystem` as a full `FileSystem` implementation backed by a git repo stored in another `FileSystem`.

Core strategy:

1. Store a normal repo layout with `.git/` in the backing filesystem.
2. Keep `HEAD` symbolic to `refs/heads/main`.
3. Auto-initialize with an initial empty commit.
4. Treat the tree at `HEAD` as the filesystem view.
5. For each mutating call:
   - load only the affected path/subtree and ancestor chain
   - apply the change in memory
   - write only changed blobs / trees / commit directly with `isomorphic-git`
   - advance `refs/heads/main`
6. Preserve symlinks and explicit empty directories.
7. Preserve executable bits only when already present.
8. Keep the implementation git-opaque to callers.

This gives a self-contained, linear-history, commit-per-mutation filesystem without exposing git workflow concepts to the caller.
