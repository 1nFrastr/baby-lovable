import { describe, expect, it } from "vitest";

import {
  isEmptyRemoteGitError,
  isZeroIdRefError,
} from "./empty-remote-error";

const PROD_PUSH_ERROR =
  'internal server error: pkt-line 3: malformed zero-id ref ( capabilitiesside-band-64k side-band report-status delete-refs quiet shallow)';

describe("empty-remote git errors", () => {
  it("matches the production Daytona/go-git receive-pack advertisement", () => {
    expect(isZeroIdRefError(new Error(PROD_PUSH_ERROR))).toBe(true);
    expect(isEmptyRemoteGitError(new Error(PROD_PUSH_ERROR))).toBe(true);
  });

  it("matches the older illegal zero-id wording", () => {
    expect(isZeroIdRefError("Daytona SDK git.push: illegal zero-id ref")).toBe(
      true,
    );
  });

  it("does not treat unrelated push failures as empty remotes", () => {
    expect(isZeroIdRefError(new Error("non-fast-forward"))).toBe(false);
    expect(isEmptyRemoteGitError(new Error("authentication failed"))).toBe(
      false,
    );
  });
});
