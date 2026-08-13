import { describe, expect, it, vi, afterEach } from "vitest";

import {
  getGithubAppInstallation,
  getGithubInstallationRepository,
  GithubAppError,
  isGithubAppInstallMissingError,
  listGithubInstallationRepositories,
} from "./app-client";

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDi/EgW322m4ZpD
GAquyPvOcbiI2jz0+UsFjcMu3jct2l4PGFBAVPU3ekLL5ReH9nheQUY3V1lWOQYa
L3aqhev368oHtHIgExtoqLmHGbVejLNOX+yuCPPhQCvH99lkObyhTthTacp5dG2l
rwFpvFUrLluli1+B8d0MCKhQJfLZUv3CduXw06hkZsKd0HVOAQuXZAy57jhXorcx
goU8Hoy5KGdTRugBhR8wiZmq8ScR/FjvAw+TnQyDDOQfGdakfpL7b5rxmbsrhwIf
TMOO4v0v6r9JK9D+xg2XGQZSDtJaUNTCAunmpwYxj3mrZuCd3jP9DATihAewne/V
1l62xIOlAgMBAAECggEANB0tlPjL1WSXNR/UNhCFhb7E2kDW/XyuDZKgdUaGPzQT
Y95WcIrA+TGMHAGXbzs2pBdS/npC0+HIRaNPmLOiO3vqmO3ERRp18MfKPts3ccOW
mGA8ODHsgnMoCiOcyR7bcOKoFrCjkNKbKQ7e4W6g1EbyujWfYjeMY4qqUCqCUQRG
6MCP6jHK6RmLI0gobnyFExp0V2bbWh0uhSzbUb++OMDnNgHn6Nz5aXKmMrEQdn8w
+zFrdrhG/OL/hS6KyJ/iozvAba1QN44Mmc5VUbpm++SoMGzzaUmzujG7gJCRrqEK
lsv1Au/2w052STNh8OXe/sfM5lv3w/oMlilZAJB0MQKBgQD48PORJtL1g0lvdQNB
AWGHFyVg1mETKXUdDg7693zUapTEryDbLULKeMjhgRbgPGU4l6/TPC5uQPZ3gLOT
MoTG8YDdzGyQifTY7BugPozSO6QER4lRdTjxnhzp1cqm4edaVwtnEsicvJL1w3qv
w7WHGHf0GsgYT0fZpJdL6U2qUQKBgQDpa/RvX24U+BVwcV0tuJjFSFVPHJcoXvW9
YnnoVa/UOfQ8MNqMmwKbHPC9/k1Ak5eAQepHt48v8XOhf5Lt2duyCAvC6Oj17NSb
/CZRw6a6X8mPSu1ZJW64/1yB2P5hQW/o7sVOmyVPAkj8Wetual+7uv8LVDFGqlc4
pUn+UL8bFQKBgQCgZghaJ0zYOk5vzVJaaTxg4a4I1jjYMuct4GgQlrRM3Zubm0et
UV1uviKZAicuNlv1+e6lSWqVSbBE0Z1jI7LfyK4Cu3vcKbekqYUnXAY6U4lb5If6
/2/AZuM0W7dmjboWwG0tbbHrI6oBRoHfjFeDg2WO2E7DMxoVhvKhS+Lp8QKBgDhz
3XgaEluL7FN3d1uZa4k7BzbM6VngLXqSGH2yS4X+Ri1Qe2rKCoVNKIQqvrBBgcCJ
MIoLwNuNf7OtUPGpYNLb00xeXAkuL/VRtErOEMK+a9b1/hUzUmX3jH3y5wLKerBR
HvL13r4PBWvSq3fWzjRu80PgJtK6W8HdZ9nT2YRJAoGBAJnfByEKokc978x9ZUWu
CuTxY7Wc8B1eqPrszfM1277XqTSwt70MSqq4EOMdjHJHDB1FJl/2xq0yzI8TzRWT
dvaYjnfADGLAzSpwrPg8sFMbPhp++SPKV4MExsCOic1707z9VIwxe+W1AogIFykp
7DULxnXmv91EHNNgZw9uTqC6
-----END PRIVATE KEY-----`;

describe("isGithubAppInstallMissingError", () => {
  it("detects missing-install signals without treating every 401 as uninstall", () => {
    expect(
      isGithubAppInstallMissingError(new GithubAppError("Not Found", 404)),
    ).toBe(true);
    expect(
      isGithubAppInstallMissingError(
        new GithubAppError("Installation not found", 401),
      ),
    ).toBe(true);
    expect(
      isGithubAppInstallMissingError(
        new GithubAppError("GitHub App 已卸载或未安装，请重新授权安装", 401),
      ),
    ).toBe(true);
    expect(
      isGithubAppInstallMissingError(new GithubAppError("bad credentials", 401)),
    ).toBe(false);
    expect(
      isGithubAppInstallMissingError(new GithubAppError("boom", 502)),
    ).toBe(false);
  });
});

describe("installation-scoped GitHub APIs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("reads installation metadata with an App JWT", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/app/installations/99")) {
          return new Response(
            JSON.stringify({
              id: 99,
              app_id: 12345,
              repository_selection: "selected",
              suspended_at: null,
              account: { id: 7, login: "octocat", type: "User" },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await expect(getGithubAppInstallation(99)).resolves.toMatchObject({
      id: 99,
      accountId: 7,
      accountLogin: "octocat",
      accountType: "User",
    });
  });

  it("lists every repository page with an installation token", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      full_name: `octocat/repo-${String(index + 1).padStart(3, "0")}`,
      name: `repo-${index + 1}`,
      private: true,
      html_url: `https://github.com/octocat/repo-${index + 1}`,
      created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      size: 0,
      owner: { login: "octocat" },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/app/installations/99/access_tokens")) {
          expect(init?.body).toBeUndefined();
          return new Response(JSON.stringify({ token: "ghs_x" }), {
            status: 201,
          });
        }
        if (url.includes("/installation/repositories?per_page=100&page=1")) {
          return new Response(
            JSON.stringify({
              total_count: 101,
              repositories: firstPage,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/installation/repositories?per_page=100&page=2")) {
          return new Response(
            JSON.stringify({
              total_count: 101,
              repositories: [
                {
                  id: 101,
                  full_name: "octocat/repo-101",
                  name: "repo-101",
                  private: false,
                  html_url: "https://github.com/octocat/repo-101",
                  created_at: "2027-01-01T00:00:00Z",
                  size: 0,
                  owner: { login: "octocat" },
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const repos = await listGithubInstallationRepositories(99);
    expect(repos).toHaveLength(101);
    expect(repos[0]).toMatchObject({
      fullName: "octocat/repo-101",
      createdAt: "2027-01-01T00:00:00Z",
    });
    expect(repos.at(-1)?.fullName).toBe("octocat/repo-001");
  });

  it("restricts repository lookup and verifies the selection is empty", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/app/installations/99/access_tokens")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            repository_ids: [321],
          });
          return new Response(JSON.stringify({ token: "ghs_scoped" }), {
            status: 201,
          });
        }
        if (url.endsWith("/repositories/321")) {
          return new Response(
            JSON.stringify({
              id: 321,
              full_name: "octocat/existing",
              name: "existing",
              private: true,
              html_url: "https://github.com/octocat/existing",
              created_at: "2026-08-13T08:00:00Z",
              size: 0,
              owner: { login: "octocat" },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/repos/octocat/existing/commits?per_page=1")) {
          return new Response(
            JSON.stringify({ message: "Git Repository is empty." }),
            { status: 409 },
          );
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await expect(
      getGithubInstallationRepository(99, 321, { requireEmpty: true }),
    ).resolves.toMatchObject({
      id: 321,
      fullName: "octocat/existing",
      size: 0,
    });
  });
});
