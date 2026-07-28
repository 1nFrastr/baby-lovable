import { Freestyle } from "freestyle";

import {
  FREESTYLE_GIT_USERNAME,
  freestyleRemoteUrl,
  getFreestyleApiKey,
  isFreestyleConfigured,
} from "./freestyle-config";

export interface FreestyleRepoHandle {
  repoId: string;
  remoteUrl: string;
  identityId: string;
}

export interface FreestyleGitCredentials {
  username: string;
  password: string;
  tokenId: string;
}

export interface FreestyleAdapter {
  createPrivateRepo(options: {
    name: string;
    defaultBranch?: string;
  }): Promise<FreestyleRepoHandle>;
  issueWriteToken(identityId: string): Promise<FreestyleGitCredentials>;
  deleteRepo(repoId: string): Promise<void>;
}

class LiveFreestyleAdapter implements FreestyleAdapter {
  private readonly client: Freestyle;

  constructor() {
    this.client = new Freestyle({ apiKey: getFreestyleApiKey() });
  }

  async createPrivateRepo(options: {
    name: string;
    defaultBranch?: string;
  }): Promise<FreestyleRepoHandle> {
    const { repoId } = await this.client.git.repos.create({
      name: options.name,
      public: false,
      defaultBranch: options.defaultBranch ?? "main",
    });

    const { identityId, identity } = await this.client.identities.create();
    await identity.permissions.git.grant({
      repoId,
      permission: "write",
    });

    return {
      repoId,
      remoteUrl: freestyleRemoteUrl(repoId),
      identityId,
    };
  }

  async issueWriteToken(identityId: string): Promise<FreestyleGitCredentials> {
    const identity = this.client.identities.ref({ identityId });
    const { tokenId, token } = await identity.tokens.create();
    return {
      username: FREESTYLE_GIT_USERNAME,
      password: token,
      tokenId,
    };
  }

  async deleteRepo(repoId: string): Promise<void> {
    await this.client.git.repos.delete({ repoId });
  }
}

/** In-memory fake for local/unit tests — never calls Freestyle APIs. */
export class FakeFreestyleAdapter implements FreestyleAdapter {
  readonly repos = new Map<string, FreestyleRepoHandle>();
  createCalls = 0;
  tokenCalls = 0;
  deleteCalls = 0;

  async createPrivateRepo(options: {
    name: string;
    defaultBranch?: string;
  }): Promise<FreestyleRepoHandle> {
    this.createCalls += 1;
    const repoId = `fake_${options.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${this.createCalls}`;
    const handle: FreestyleRepoHandle = {
      repoId,
      remoteUrl: freestyleRemoteUrl(repoId),
      identityId: `identity_${repoId}`,
    };
    this.repos.set(repoId, handle);
    return handle;
  }

  async issueWriteToken(identityId: string): Promise<FreestyleGitCredentials> {
    this.tokenCalls += 1;
    return {
      username: FREESTYLE_GIT_USERNAME,
      password: `fake-token-${identityId}-${this.tokenCalls}`,
      tokenId: `tok_${this.tokenCalls}`,
    };
  }

  async deleteRepo(repoId: string): Promise<void> {
    this.deleteCalls += 1;
    this.repos.delete(repoId);
  }
}

let overrideAdapter: FreestyleAdapter | null = null;

export function setFreestyleAdapterForTests(
  adapter: FreestyleAdapter | null,
): void {
  overrideAdapter = adapter;
}

export function getFreestyleAdapter(): FreestyleAdapter {
  if (overrideAdapter) {
    return overrideAdapter;
  }
  if (!isFreestyleConfigured()) {
    throw new Error("FREESTYLE_API_KEY is not configured");
  }
  return new LiveFreestyleAdapter();
}
