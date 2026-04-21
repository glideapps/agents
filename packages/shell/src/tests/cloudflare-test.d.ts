declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader;
    TestWorkspaceAgent: DurableObjectNamespace<
      import("./agents/workspace").TestWorkspaceAgent
    >;
    TestGitAgent: DurableObjectNamespace<import("./agents/git").TestGitAgent>;
    TestVersionedFileSystemAgent: DurableObjectNamespace<
      import("./agents/versioned-filesystem").TestVersionedFileSystemAgent
    >;
  }
}
