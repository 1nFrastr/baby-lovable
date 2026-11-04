import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  barrier: vi.fn(), readRepo: vi.fn(), session: vi.fn(), latest: vi.fn(),
}));
vi.mock("@/lib/git/await-checkpoint", () => ({ awaitPreviousCheckpoint: mocks.barrier }));
vi.mock("@/lib/git/repository-store", () => ({ readGitRepository: mocks.readRepo }));
vi.mock("@/lib/session/store", () => ({ getSessionMeta: mocks.session }));
vi.mock("@/lib/git/freestyle-client", () => ({ getFreestyleAdapter: () => ({ listLatestCommitSha: mocks.latest }) }));

import { exportPublishSource, resolvePublishSource } from "./publish-source";

const pinnedSha = "a".repeat(40);
const newerSha = "b".repeat(40);
const repo = {
  repoId: "repo_123", provider: "freestyle", provisionStatus: "ready",
  syncStatus: "synced", unrecoverable: false, remoteHeadSha: newerSha, defaultBranch: "other",
};

type Json = Record<string, unknown>;
const revisions = new Map<string, Map<string, Json>>();

function blob(path: string, content: Buffer | string = "", mode?: string): Json {
  const bytes = Buffer.from(content);
  return {
    path, name: path.split("/").at(-1), type: "file", mode,
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    size: bytes.length, content: bytes.toString("base64"),
  };
}

/** Model the SDK's documented directory entries and base64 file responses. */
function source(files: Json[], sha = pinnedSha): Map<string, Json> {
  const responses = new Map<string, Json>();
  const directories = new Map<string, Json[]>([["", []]]);
  for (const file of files) {
    const path = file.path as string;
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      if (!directories.has(directory)) directories.set(directory, []);
    }
    const { content: _, ...entry } = file;
    void _;
    directories.get(parts.slice(0, -1).join("/"))!.push(entry);
    responses.set(path, file);
  }
  for (const directory of directories.keys()) {
    if (directory) {
      const parent = directory.split("/").slice(0, -1).join("/");
      directories.get(parent)!.push({ path: directory, type: "dir", sha: pinnedSha });
    }
  }
  for (const [path, entries] of directories) responses.set(path, { path, type: "dir", sha: pinnedSha, entries });
  revisions.set(sha, responses);
  return responses;
}

function requestedPaths(): string[] {
  return vi.mocked(fetch).mock.calls.map(([input]) =>
    decodeURIComponent(new URL(String(input)).pathname.split("/contents/")[1]));
}

beforeEach(() => {
  vi.resetAllMocks();
  revisions.clear();
  vi.stubEnv("FREESTYLE_API_KEY", "server-only-test-key");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.split("/contents/")[1]);
    const response = revisions.get(url.searchParams.get("rev")!)?.get(path);
    return Response.json(response ?? { message: "not found" }, { status: response ? 200 : 404 });
  }));
  mocks.session.mockResolvedValue({ userId: "owner" });
  mocks.barrier.mockResolvedValue(undefined);
  mocks.readRepo.mockResolvedValue(repo);
  mocks.latest.mockResolvedValue(pinnedSha);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolvePublishSource", () => {
  it("waits for the checkpoint before reading the binding and resolves actual Freestyle main", async () => {
    let finish!: () => void;
    mocks.barrier.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const resolving = resolvePublishSource("sess_1", "owner");
    await vi.waitFor(() => expect(mocks.barrier).toHaveBeenCalledWith("sess_1", { userId: "owner" }));
    expect(mocks.readRepo).not.toHaveBeenCalled();
    expect(mocks.latest).not.toHaveBeenCalled();
    finish();
    await expect(resolving).resolves.toEqual({ repoId: repo.repoId, sha: pinnedSha });
    expect(mocks.readRepo).toHaveBeenCalledWith("sess_1", "owner");
    expect(mocks.latest).toHaveBeenCalledWith(repo.repoId, "main");
  });

  it("stops on a checkpoint failure", async () => {
    mocks.barrier.mockRejectedValue(new Error("checkpoint conflict"));
    await expect(resolvePublishSource("sess_1", "owner")).rejects.toThrow("checkpoint conflict");
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(mocks.readRepo).not.toHaveBeenCalled();
  });

  it.each([null, { ...repo, repoId: null }, { ...repo, provisionStatus: "preparing" },
    { ...repo, unrecoverable: true }, { ...repo, syncStatus: "conflict" }, { ...repo, syncStatus: "error" }])(
    "refuses unavailable source %j", async (binding) => {
      mocks.readRepo.mockResolvedValue(binding);
      await expect(resolvePublishSource("sess_1", "owner")).rejects.toThrow("not ready");
      expect(mocks.latest).not.toHaveBeenCalled();
    },
  );

  it.each([null, "main", "a".repeat(7)])("does not substitute stored or symbolic revisions for %s", async (sha) => {
    mocks.latest.mockResolvedValue(sha);
    await expect(resolvePublishSource("sess_1", "owner")).rejects.toThrow("no valid commit");
  });

  it("checks ownership before waiting or calling Freestyle", async () => {
    mocks.session.mockResolvedValue({ userId: "someone_else" });
    await expect(resolvePublishSource("sess_1", "owner")).rejects.toThrow("access was denied");
    await expect(resolvePublishSource("sess_1", "")).rejects.toThrow("Authentication");
    expect(mocks.barrier).not.toHaveBeenCalled();
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("removes provider credentials from resolution errors", async () => {
    mocks.latest.mockRejectedValue(new Error("Authorization: Bearer secret-token"));
    const error = await resolvePublishSource("sess_1", "owner").catch((error: Error) => error);
    expect(error).toEqual(new Error("Unable to resolve the Freestyle main commit."));
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("exportPublishSource", () => {
  it("pins every SDK request while main advances, preserving binary bytes and raw export-subst content", async () => {
    const binary = Buffer.from([0, 255, 128, 13, 10, 0, 195, 40]);
    source([
      blob("public/asset.bin", binary), blob("src/app.ts", "$Format:%H$"),
      blob(".gitattributes", "src/app.ts export-subst\npublic/asset.bin export-ignore\n"),
      blob("package.json", '{"scripts":{"prepublish":"throw new Error()"}}'),
    ]);
    source([blob("public/asset.bin", "new main content")], newerSha);
    const resolved = await resolvePublishSource("sess_1", "owner");
    mocks.latest.mockResolvedValue(newerSha);
    const files = await exportPublishSource(resolved.repoId, resolved.sha);
    expect(files.find((file) => file.path === "public/asset.bin")?.content).toEqual(binary);
    expect(files.find((file) => file.path === "src/app.ts")?.content.toString()).toBe("$Format:%H$");
    expect(files.every((file) => Buffer.isBuffer(file.content))).toBe(true);
    for (const [input, init] of vi.mocked(fetch).mock.calls) {
      expect(new URL(String(input)).searchParams.get("rev")).toBe(pinnedSha);
      expect(init).toEqual(expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer server-only-test-key" }),
        redirect: "error", cache: "no-store", signal: expect.any(AbortSignal),
      }));
    }
    expect(mocks.latest).toHaveBeenCalledOnce();
  });

  it("keeps empty files and env templates, excludes internal trees, and never fetches excluded blobs", async () => {
    source([
      blob("src/app.ts"), blob(".env.example"), blob("nested/.env.template"),
      ...[".git/config", "node_modules/pkg/index.js", ".next/cache/x", ".baby/tools/run", "nested/node_modules/x"].map((name) => blob(name)),
    ]);
    const files = await exportPublishSource(repo.repoId, pinnedSha);
    expect(files.map((file) => file.path).sort()).toEqual([".env.example", "nested/.env.template", "src/app.ts"]);
    expect(files[0].content).toEqual(Buffer.alloc(0));
    expect(requestedPaths()).not.toContain(".git/config");
    expect(requestedPaths()).not.toContain("node_modules/pkg/index.js");
  });

  it.each([".env", ".env.local", "nested/.env.production", ".ENV.LOCAL", ".env.example.local", ".baby/.env.secret"])(
    "refuses tracked private env %s before downloading any source blobs", async (name) => {
      source([blob("safe.ts"), blob(name)]);
      await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("tracked private environment file");
      expect(requestedPaths()).not.toContain("safe.ts");
    },
  );

  it.each(["../outside", "/absolute", "src/../../outside", "src/./x", "src//x", "C:/outside", "src\\outside", "src/\u0000file", "src/\nfile", "//server/share", "\ud800"])(
    "rejects unsafe API path %j before requesting it", async (name) => {
      source([]).set("", { type: "dir", path: "", entries: [blob(name)] });
      await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("unsafe file path");
      expect(requestedPaths()).toEqual([""]);
    },
  );

  it.each(["symlink", "submodule", "unknown"])("refuses a reported %s entry", async (type) => {
    source([]).set("", { type: "dir", path: "", entries: [{ ...blob("link"), type }] });
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("symlinks or special files");
  });

  it.each(["120777", "160000", "010644"])("refuses special Unix modes when supplied (%s)", async (mode) => {
    source([blob("link", "/etc/passwd", mode)]);
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("symlinks or special files");
  });

  it("safely emits a link-target blob as regular bytes when the API omits Unix modes", async () => {
    source([blob("link", "../../outside")]);
    await expect(exportPublishSource(repo.repoId, pinnedSha)).resolves.toEqual([
      { path: "link", content: Buffer.from("../../outside"), mode: 0o644 },
    ]);
  });

  it("refuses a dereferenced link payload whose bytes do not match the tracked link blob", async () => {
    const responses = source([blob("link", "../../private")]);
    responses.set("link", { ...responses.get("link"), content: Buffer.from("secret value!").toString("base64") });
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("invalid pinned");
  });

  it("rejects inconsistent directory paths, duplicates, and paths outside the requested directory", async () => {
    for (const entries of [[blob("same"), blob("same")], [blob("nested/file")]]) {
      source([]).set("", { path: "", type: "dir", entries });
      await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("invalid pinned");
    }
    const responses = source([blob("src/file")]);
    responses.set("src", { path: "wrong", sha: pinnedSha, type: "dir", entries: [] });
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("invalid pinned");
  });

  it("refuses changed object IDs, binary corruption, malformed base64, and inconsistent sizes", async () => {
    for (const patch of [
      { sha: newerSha }, { content: Buffer.from("xyz").toString("base64") },
      { content: "!!!!" }, { content: "YWJj====" }, { size: 4 },
    ]) {
      const responses = source([blob("file", "abc")]);
      responses.set("file", { ...responses.get("file"), ...patch });
      await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("invalid pinned");
    }
  });

  it("bounds entry count and declared per-file/total decoded size before fetching blobs", async () => {
    source([]).set("", { path: "", type: "dir", entries: Array(10_001).fill(blob("file")) });
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("too many files");
    source([{ ...blob("large"), size: 25 * 1024 * 1024 + 1 }]);
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("size limit");
    source(Array.from({ length: 5 }, (_, index) => ({ ...blob(`file-${index}`), size: 25 * 1024 * 1024 })));
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("size limit");
    expect(requestedPaths().every((path) => path === "")).toBe(true);
  });

  it("bounds aggregate directory count rather than just entries in one response", async () => {
    const responses = source([]);
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ path: `dir-${index}`, type: "dir", sha: pinnedSha }));
    responses.set("", { path: "", type: "dir", entries });
    responses.set("dir-0", { path: "dir-0", type: "dir", sha: pinnedSha, entries: [blob("dir-0/file")] });
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("too many files");
  });

  it("cancels oversized responses before buffering their bodies", async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-length": String(150 * 1024 * 1024 + 1) },
    }));
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("Unable to read");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shares one response-byte budget across directory requests", async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      path: "", type: "dir", entries: [{ path: "src", type: "dir", sha: pinnedSha }],
    }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-length": String(150 * 1024 * 1024) },
    }));
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("Unable to read");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds streaming responses even when Content-Length is missing", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(25 * 1024 * 1024);
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(chunk); }, cancel,
    })));
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("Unable to read");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("requires a full immutable revision and a safe repository ID before downloading", async () => {
    for (const [repoId, sha] of [[repo.repoId, "main"], [repo.repoId, "abc123"], ["../repo", pinnedSha], ["repo?token=secret", pinnedSha]]) {
      await expect(exportPublishSource(repoId, sha)).rejects.toThrow("full commit SHA");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes credential-bearing download failures and HTTP error bodies", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("https://token:secret@git.freestyle.sh/repo"));
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Authorization: secret", { status: 401 }));
    for (let index = 0; index < 2; index++) {
      const error = await exportPublishSource(repo.repoId, pinnedSha).catch((error: Error) => error);
      expect(error).toEqual(new Error("Unable to read the pinned Freestyle source commit."));
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("refuses browser execution before accessing source credentials", async () => {
    vi.stubGlobal("window", {});
    await expect(exportPublishSource(repo.repoId, pinnedSha)).rejects.toThrow("only available on the server");
    expect(fetch).not.toHaveBeenCalled();
  });
});
