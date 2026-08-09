import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEmptyUserRepo,
  GithubAppError,
  isGithubRepoNameTakenError,
  sanitizeGithubRepoBaseName,
} from "./app-client";

describe("isGithubRepoNameTakenError", () => {
  it("detects GitHub wrapped creation failures", () => {
    expect(
      isGithubRepoNameTakenError(
        new Error(
          "Repository creation failed. (name already exists on this account)",
        ),
      ),
    ).toBe(true);
    expect(
      isGithubRepoNameTakenError(new Error("name already exists on this account")),
    ).toBe(true);
    expect(
      isGithubRepoNameTakenError(new Error("Repository creation failed.")),
    ).toBe(false);
    expect(isGithubRepoNameTakenError(new Error("Bad credentials"))).toBe(
      false,
    );
  });
});

describe("sanitizeGithubRepoBaseName", () => {
  it("normalizes names", () => {
    expect(sanitizeGithubRepoBaseName("Baby Lovable App")).toBe(
      "baby-lovable-app",
    );
  });
});

describe("createEmptyUserRepo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reuses an existing repo for the same owner/name (reconnect)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/repos/acme/baby-lovable-demo")) {
        return new Response(
          JSON.stringify({
            full_name: "acme/baby-lovable-demo",
            name: "baby-lovable-demo",
            private: true,
            html_url: "https://github.com/acme/baby-lovable-demo",
            owner: { login: "acme" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repo = await createEmptyUserRepo("token", "baby-lovable-demo", {
      ownerLogin: "acme",
    });

    expect(repo.fullName).toBe("acme/baby-lovable-demo");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/repos/acme/baby-lovable-demo",
    );
  });

  it("creates when missing, and retries suffix when name is taken without owner", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/user/repos") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        if (body.name === "demo-app") {
          return new Response(
            JSON.stringify({
              message: "Repository creation failed.",
              errors: [
                {
                  resource: "Repository",
                  code: "custom",
                  field: "name",
                  message: "name already exists on this account",
                },
              ],
            }),
            { status: 422 },
          );
        }
        return new Response(
          JSON.stringify({
            full_name: `acme/${body.name}`,
            name: body.name,
            private: true,
            html_url: `https://github.com/acme/${body.name}`,
            owner: { login: "acme" },
          }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repo = await createEmptyUserRepo("token", "demo-app");
    expect(repo.fullName).toBe("acme/demo-app-2");
  });

  it("surfaces non-collision create failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ message: "Bad credentials" }),
          { status: 401 },
        );
      }),
    );

    await expect(createEmptyUserRepo("token", "demo-app")).rejects.toBeInstanceOf(
      GithubAppError,
    );
  });
});
