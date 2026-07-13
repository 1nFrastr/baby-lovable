import type { Page } from "playwright-core";

import type { AppTestAction, AppTestStep } from "./types";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shot(
  page: Page,
  filePath: string | undefined,
  screenshots: string[],
): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    await page.locator("body").screenshot({
      path: filePath,
      timeout: 10_000,
      animations: "disabled",
    });
    screenshots.push(filePath);
    return true;
  } catch {
    return false;
  }
}

function artifactPath(
  artifactDir: string | undefined,
  name: string,
): string | undefined {
  return artifactDir ? `${artifactDir}/${name}` : undefined;
}

/** Expand `{{now}}` / `{{unique}}` placeholders so assert values stay in sync. */
export function expandPlaceholders(
  text: string,
  unique: string,
): string {
  return text
    .replaceAll("{{now}}", unique)
    .replaceAll("{{unique}}", unique);
}

/**
 * Models often JSON-escape quotes inside selector strings, leaving literal
 * backslashes (e.g. `input[aria-label=\"New todo\"]`) which break Playwright.
 */
export function sanitizeSelector(selector: string): string {
  return selector
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'")
    .replaceAll("\\\\", "\\");
}

function stepName(action: AppTestAction, index: number): string {
  return action.name?.trim() || `${action.action}:${index + 1}`;
}

function resolveTarget(action: AppTestAction, unique: string): {
  selector?: string;
  text?: string;
} {
  return {
    selector: action.selector
      ? sanitizeSelector(expandPlaceholders(action.selector, unique))
      : undefined,
    text: action.text ? expandPlaceholders(action.text, unique) : undefined,
  };
}

/**
 * Execute caller-supplied Playwright steps (selectors from Builder Agent / CLI).
 * Stops on the first failing step unless `continueOnError` is set on that step.
 */
export async function executeScriptedActions(
  page: Page,
  actions: AppTestAction[],
  artifactDir: string | undefined,
  reportSteps: AppTestStep[],
  screenshots: string[],
): Promise<{ ok: boolean; completed: number }> {
  const unique = Date.now().toString(36);
  let shotIndex = 20;
  let completed = 0;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const name = stepName(action, i);
    const timeout = action.timeoutMs ?? 8_000;

    try {
      switch (action.action) {
        case "fill": {
          const { selector } = resolveTarget(action, unique);
          const value = expandPlaceholders(action.value ?? "", unique);
          if (!selector) {
            throw new Error("fill requires selector");
          }
          if (!value) {
            throw new Error("fill requires value");
          }
          const loc = page.locator(selector).first();
          await loc.waitFor({ state: "visible", timeout });
          await loc.click({ timeout });
          await loc.fill("");
          await loc.fill(value);
          reportSteps.push({ name, ok: true, detail: value });
          break;
        }
        case "click": {
          const { selector } = resolveTarget(action, unique);
          if (!selector) {
            throw new Error("click requires selector");
          }
          const loc = page.locator(selector).first();
          await loc.waitFor({ state: "visible", timeout });
          await loc.click({ timeout });
          reportSteps.push({ name, ok: true, detail: selector });
          break;
        }
        case "press": {
          const { selector } = resolveTarget(action, unique);
          const key = action.key ?? "Enter";
          if (!selector) {
            throw new Error("press requires selector");
          }
          await page.locator(selector).first().press(key, { timeout });
          reportSteps.push({ name, ok: true, detail: key });
          break;
        }
        case "hover": {
          const { selector } = resolveTarget(action, unique);
          if (!selector) {
            throw new Error("hover requires selector");
          }
          const loc = page.locator(selector).first();
          await loc.waitFor({ state: "visible", timeout });
          await loc.hover({ timeout });
          reportSteps.push({ name, ok: true, detail: selector });
          break;
        }
        case "assertVisible": {
          const { selector, text } = resolveTarget(action, unique);
          if (!selector && !text) {
            throw new Error("assertVisible requires selector or text");
          }
          // Prefer `text` when provided — agents escape quotes badly in :has-text().
          const loc = text
            ? page.getByText(text, { exact: false }).first()
            : page.locator(selector!).first();
          const visible = await loc
            .waitFor({ state: "visible", timeout })
            .then(() => true)
            .catch(() => false);
          if (!visible) {
            throw new Error(
              `not visible: ${text ? `text=${text}` : selector}`,
            );
          }
          reportSteps.push({
            name,
            ok: true,
            detail: text ? `text=${text}` : selector,
          });
          break;
        }
        case "assertHidden": {
          const { selector, text } = resolveTarget(action, unique);
          if (!selector && !text) {
            throw new Error("assertHidden requires selector or text");
          }
          const loc = text
            ? page.getByText(text, { exact: false }).first()
            : page.locator(selector!).first();
          const gone = await loc
            .waitFor({ state: "hidden", timeout })
            .then(() => true)
            .catch(async () => {
              const count = await loc.count().catch(() => 0);
              return count === 0;
            });
          if (!gone) {
            throw new Error(
              `still visible: ${text ? `text=${text}` : selector}`,
            );
          }
          reportSteps.push({
            name,
            ok: true,
            detail: text ? `text=${text}` : selector,
          });
          break;
        }
        case "wait": {
          const ms = action.ms ?? 500;
          await sleep(ms);
          reportSteps.push({ name, ok: true, detail: `${ms}ms` });
          break;
        }
        case "screenshot": {
          shotIndex += 1;
          const file =
            action.path ??
            artifactPath(
              artifactDir,
              `${String(shotIndex).padStart(2, "0")}-step.png`,
            );
          if (!file) {
            reportSteps.push({
              name,
              ok: true,
              detail: "skipped (no artifact dir)",
            });
            break;
          }
          const ok = await shot(page, file, screenshots);
          reportSteps.push({
            name,
            ok,
            detail: ok ? file : "screenshot failed",
          });
          if (!ok && !action.continueOnError) {
            return { ok: false, completed };
          }
          break;
        }
        default: {
          const exhaustive: never = action.action;
          throw new Error(`Unknown action: ${String(exhaustive)}`);
        }
      }

      completed += 1;

      // Auto-screenshot after mutating actions (skip wait/assert/screenshot).
      if (
        action.action === "fill" ||
        action.action === "click" ||
        action.action === "press"
      ) {
        await sleep(action.settleMs ?? 400);
        shotIndex += 1;
        await shot(
          page,
          artifactPath(
            artifactDir,
            `${String(shotIndex).padStart(2, "0")}-after-${action.action}.png`,
          ),
          screenshots,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reportSteps.push({ name, ok: false, detail });
      shotIndex += 1;
      await shot(
        page,
        artifactPath(
          artifactDir,
          `${String(shotIndex).padStart(2, "0")}-fail-${i + 1}.png`,
        ),
        screenshots,
      );
      if (!action.continueOnError) {
        return { ok: false, completed };
      }
      completed += 1;
    }
  }

  return { ok: true, completed };
}

const ACTIONS = new Set([
  "fill",
  "click",
  "press",
  "hover",
  "assertVisible",
  "assertHidden",
  "wait",
  "screenshot",
]);

/** Parse / validate a JSON array of scripted actions (CLI / future tool input). */
export function parseAppTestActions(raw: unknown): AppTestAction[] {
  if (!Array.isArray(raw)) {
    throw new Error("steps must be a JSON array");
  }
  if (raw.length === 0) {
    throw new Error("steps array is empty");
  }
  if (raw.length > 8) {
    throw new Error("steps array too long (max 8)");
  }

  const actions: AppTestAction[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      throw new Error(`steps[${i}] must be an object`);
    }
    const rec = item as Record<string, unknown>;
    const action = rec.action;
    if (typeof action !== "string" || !ACTIONS.has(action)) {
      throw new Error(
        `steps[${i}].action must be one of: ${[...ACTIONS].join(", ")}`,
      );
    }

    const out: AppTestAction = { action: action as AppTestAction["action"] };

    if (rec.selector !== undefined) {
      if (typeof rec.selector !== "string" || !rec.selector.trim()) {
        throw new Error(`steps[${i}].selector must be a non-empty string`);
      }
      out.selector = sanitizeSelector(rec.selector);
    }
    if (rec.text !== undefined) {
      if (typeof rec.text !== "string") {
        throw new Error(`steps[${i}].text must be a string`);
      }
      out.text = rec.text;
    }
    if (rec.value !== undefined) {
      if (typeof rec.value !== "string") {
        throw new Error(`steps[${i}].value must be a string`);
      }
      out.value = rec.value;
    }
    if (rec.key !== undefined) {
      if (typeof rec.key !== "string") {
        throw new Error(`steps[${i}].key must be a string`);
      }
      out.key = rec.key;
    }
    if (rec.ms !== undefined) {
      if (typeof rec.ms !== "number" || !Number.isFinite(rec.ms) || rec.ms < 0) {
        throw new Error(`steps[${i}].ms must be a non-negative number`);
      }
      out.ms = rec.ms;
    }
    if (rec.timeoutMs !== undefined) {
      if (
        typeof rec.timeoutMs !== "number" ||
        !Number.isFinite(rec.timeoutMs) ||
        rec.timeoutMs < 0
      ) {
        throw new Error(`steps[${i}].timeoutMs must be a non-negative number`);
      }
      out.timeoutMs = rec.timeoutMs;
    }
    if (rec.settleMs !== undefined) {
      if (
        typeof rec.settleMs !== "number" ||
        !Number.isFinite(rec.settleMs) ||
        rec.settleMs < 0
      ) {
        throw new Error(`steps[${i}].settleMs must be a non-negative number`);
      }
      out.settleMs = rec.settleMs;
    }
    if (rec.name !== undefined) {
      if (typeof rec.name !== "string") {
        throw new Error(`steps[${i}].name must be a string`);
      }
      out.name = rec.name;
    }
    if (rec.path !== undefined) {
      if (typeof rec.path !== "string") {
        throw new Error(`steps[${i}].path must be a string`);
      }
      out.path = rec.path;
    }
    if (rec.continueOnError !== undefined) {
      if (typeof rec.continueOnError !== "boolean") {
        throw new Error(`steps[${i}].continueOnError must be a boolean`);
      }
      out.continueOnError = rec.continueOnError;
    }

    // Light per-action required-field checks
    if (
      (action === "fill" ||
        action === "click" ||
        action === "press" ||
        action === "hover") &&
      !out.selector
    ) {
      throw new Error(`steps[${i}] (${action}) requires selector`);
    }
    if (action === "fill" && out.value === undefined) {
      throw new Error(`steps[${i}] (fill) requires value`);
    }
    if (
      (action === "assertVisible" || action === "assertHidden") &&
      !out.selector &&
      !out.text
    ) {
      throw new Error(
        `steps[${i}] (${action}) requires selector or text`,
      );
    }

    actions.push(out);
  }

  return actions;
}
