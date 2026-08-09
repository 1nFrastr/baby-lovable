import { describe, expect, it, vi, afterEach } from "vitest";

import {
  assertGithubAppInstalledForUser,
  GithubAppError,
  isGithubAppInstallMissingError,
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
  it("treats 401/403/404 as missing install", () => {
    expect(
      isGithubAppInstallMissingError(new GithubAppError("gone", 404)),
    ).toBe(true);
    expect(
      isGithubAppInstallMissingError(new GithubAppError("nope", 403)),
    ).toBe(true);
    expect(
      isGithubAppInstallMissingError(new GithubAppError("auth", 401)),
    ).toBe(true);
    expect(
      isGithubAppInstallMissingError(new GithubAppError("boom", 502)),
    ).toBe(false);
  });
});

describe("assertGithubAppInstalledForUser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("returns stored installation id when mint succeeds", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/app/installations/99/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_x" }), {
            status: 201,
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await expect(
      assertGithubAppInstalledForUser("token", 99),
    ).resolves.toBe(99);
  });

  it("falls back to user installations when stored id is gone", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/app/installations/99/access_tokens")) {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
          });
        }
        if (url.includes("/user/installations")) {
          return new Response(
            JSON.stringify({
              installations: [{ id: 77, app_id: 12345 }],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await expect(
      assertGithubAppInstalledForUser("token", 99),
    ).resolves.toBe(77);
  });

  it("throws 401 when app is not installed", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/user/installations")) {
          return new Response(JSON.stringify({ installations: [] }), {
            status: 200,
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await expect(
      assertGithubAppInstalledForUser("token", null),
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});
