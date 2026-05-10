export const REPO_PROTOCOL_VERSION = "0.1.0";

export interface WorkspaceCapability {
  protocolVersion: string;
  declare: {
    enabled: boolean;
    defaultVisibility: "private" | "hub_local" | "federated";
  };
  list: {
    enabled: boolean;
  };
}

export interface RepoClientTransport {
  notify(method: string, params: unknown): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
}

export interface RepoAttachConfig {
  remoteUrl: string;
  localPath: string;
  currentBranch?: string;
}

export interface RepoHandle {
  identity: {
    canonicalUrl: string;
  };
  localPath: string;
  currentBranch?: string;
}

export interface RepoDeclaration {
  bindings: Array<{
    canonical_url: string;
    local_path: string;
    current_branch?: string;
  }>;
}

export class RepoManager {
  private readonly repos: RepoHandle[] = [];

  async attach(config: RepoAttachConfig): Promise<RepoHandle> {
    const existing = this.repos.find(
      (repo) =>
        repo.identity.canonicalUrl === config.remoteUrl ||
        repo.localPath === config.localPath,
    );
    if (existing) return existing;

    const handle: RepoHandle = {
      identity: { canonicalUrl: config.remoteUrl },
      localPath: config.localPath,
      ...(config.currentBranch ? { currentBranch: config.currentBranch } : {}),
    };
    this.repos.push(handle);
    return handle;
  }

  list(): RepoHandle[] {
    return [...this.repos];
  }
}

export class RepoClient {
  constructor(private readonly transport: RepoClientTransport) {}

  static snapshot(manager: RepoManager): RepoDeclaration {
    return {
      bindings: manager.list().map((repo) => ({
        canonical_url: repo.identity.canonicalUrl,
        local_path: repo.localPath,
        ...(repo.currentBranch ? { current_branch: repo.currentBranch } : {}),
      })),
    };
  }

  async declare(declaration: RepoDeclaration): Promise<void> {
    await this.transport.notify("x-workspace/repo.declare", declaration);
  }
}
