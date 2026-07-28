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
  /** Source-tree zip at a revision (no `.git` history). */
  downloadRepoZip(repoId: string, rev?: string): Promise<Uint8Array>;
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

  async downloadRepoZip(repoId: string, rev?: string): Promise<Uint8Array> {
    const repo = this.client.git.repos.ref({ repoId });
    const buffer = await repo.contents.downloadZip(
      rev ? { rev } : undefined,
    );
    return new Uint8Array(buffer);
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

  async downloadRepoZip(repoId: string, _rev?: string): Promise<Uint8Array> {
    if (!this.repos.has(repoId)) {
      throw new Error(`Fake Freestyle repo not found: ${repoId}`);
    }
    // Minimal ZIP: local file header for "package.json" + empty payload + EOCD.
    // Enough for export smoke checks that look for ZIP magic + package.json.
    void _rev;
    const name = Buffer.from("package.json");
    const data = Buffer.from('{"name":"fake-export"}\n');
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(0, 42);
    name.copy(central, 46);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(local.length, 16);
    end.writeUInt16LE(0, 20);

    return new Uint8Array(Buffer.concat([local, central, end]));
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
