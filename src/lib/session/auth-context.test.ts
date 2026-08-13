import { describe, expect, it } from "vitest";

import { extractGithubAuthIdentity } from "./auth-context";

describe("extractGithubAuthIdentity", () => {
  it("extracts the numeric GitHub provider id and login", () => {
    const identity = extractGithubAuthIdentity({
      identities: [
        {
          id: "supabase-identity-row",
          identity_id: "supabase-identity-id",
          user_id: "user-1",
          provider: "github",
          identity_data: {
            sub: "123456",
            user_name: "octocat",
          },
        },
      ],
      user_metadata: {},
    });
    expect(identity).toEqual({ id: 123456, login: "octocat" });
  });

  it("does not treat anonymous or malformed identities as GitHub users", () => {
    expect(
      extractGithubAuthIdentity({
        identities: [
          {
            id: "anonymous-row",
            identity_id: "anonymous-id",
            user_id: "user-1",
            provider: "anonymous",
            identity_data: {},
          },
        ],
        user_metadata: {},
      }),
    ).toBeNull();
    expect(
      extractGithubAuthIdentity({
        identities: [
          {
            id: "github-row",
            identity_id: "github-id",
            user_id: "user-1",
            provider: "github",
            identity_data: { sub: "not-a-number" },
          },
        ],
        user_metadata: {},
      }),
    ).toBeNull();
  });
});
