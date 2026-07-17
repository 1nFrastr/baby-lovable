import type { AppServerCheck } from "./preview-types";

/** Browser overlay replays tagged in the dev log — not trustworthy compile errors. */
export function isUnreliableCompileError(message: string): boolean {
  return /\[browser\]/i.test(message);
}

/** Daytona proxy / cold-start 5xx with no compile log — often clears on retry. */
export function isSyntheticHttpPreviewError(message: string): boolean {
  return /Preview returned HTTP \d+ but no compile error was captured/i.test(
    message,
  );
}

/** Ready but likely still warming (5xx / flaky overlay) — retry rather than treat as hard fail. */
export function isTempFailure(report: AppServerCheck): boolean {
  if (report.status !== "ready") {
    return false;
  }

  if (
    report.httpStatus !== undefined &&
    report.httpStatus < 500 &&
    report.buildError === null
  ) {
    return false;
  }

  if (
    report.buildError &&
    !isUnreliableCompileError(report.buildError) &&
    !isSyntheticHttpPreviewError(report.buildError)
  ) {
    return false;
  }

  return (
    (report.httpStatus !== undefined && report.httpStatus >= 500) ||
    report.buildError !== null
  );
}
