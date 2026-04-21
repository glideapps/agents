---
"@cloudflare/shell": minor
---

Add a new versioned durable filesystem for `@cloudflare/shell`.

New exports:

- `FileSystemStorage`
- `VersionedFileSystem`
- `FileSystemStorageOptions`
- `VersionedFileSystemChangeEvent`
- `VersionedFileSystemChangeType`

`FileSystemStorage` manages named filesystem versions backed by SQLite plus optional R2 spillover. Each `VersionedFileSystem` instance is bound to one existing version, supports the standard `FileSystem` interface directly, and stores deduplicated content blobs by SHA-256 across the whole database.
