import type { Page } from "playwright-core";

import type { AppTestStep } from "./types";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shot(
  page: Page,
  path: string,
  screenshots: string[],
): Promise<boolean> {
  try {
    await page.locator("body").screenshot({
      path,
      timeout: 10_000,
      animations: "disabled",
    });
    screenshots.push(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Heuristic list/form smoke: type into a primary text field, submit, assert
 * the text appears, then try to delete that item and assert it is gone.
 * Returns true when an add (+ optional delete) path was exercised.
 */
export async function exerciseListFormFlow(
  page: Page,
  artifactDir: string,
  steps: AppTestStep[],
  screenshots: string[],
): Promise<{ exercised: boolean; addOk: boolean; deleteOk: boolean }> {
  const taskText = `AppTest item ${Date.now().toString(36)}`;

  const input = page
    .locator(
      [
        'input[placeholder*="Add" i]',
        'input[placeholder*="task" i]',
        'input[placeholder*="todo" i]',
        'input[placeholder*="new" i]',
        'textarea[placeholder*="Add" i]',
        'textarea[placeholder*="task" i]',
        'input[type="text"]',
        "textarea",
      ].join(", "),
    )
    .first();

  // Allow client components time to hydrate after first paint.
  const inputVisible = await input
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!inputVisible) {
    steps.push({
      name: "form:discover",
      ok: true,
      detail: "no primary text input found — skip form flow",
    });
    return { exercised: false, addOk: false, deleteOk: false };
  }

  try {
    await input.click({ timeout: 5_000 });
    await input.fill("");
    await input.fill(taskText);
    steps.push({ name: "form:fill", ok: true, detail: taskText });
  } catch (error) {
    steps.push({
      name: "form:fill",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { exercised: false, addOk: false, deleteOk: false };
  }

  // Prefer an explicit Add/submit control; fall back to Enter.
  const addButton = page
    .locator(
      [
        'button:has-text("Add")',
        'button[type="submit"]',
        '[role="button"]:has-text("Add")',
        'input[type="submit"]',
      ].join(", "),
    )
    .first();

  try {
    if (await addButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await addButton.click({ timeout: 5_000 });
      steps.push({ name: "form:submit", ok: true, detail: "clicked Add" });
    } else {
      await input.press("Enter");
      steps.push({ name: "form:submit", ok: true, detail: "pressed Enter" });
    }
  } catch (error) {
    steps.push({
      name: "form:submit",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { exercised: true, addOk: false, deleteOk: false };
  }

  await sleep(800);

  // Ensure list filter shows all items if a Completed-only filter is active.
  const allFilter = page.getByRole("button", { name: /^All\b/i }).first();
  if (await allFilter.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await allFilter.click({ timeout: 3_000 }).catch(() => {});
    await sleep(300);
  }

  const item = page.getByText(taskText, { exact: false }).first();
  const addOk = await item.isVisible({ timeout: 8_000 }).catch(() => false);
  steps.push({
    name: "form:assertAdded",
    ok: addOk,
    detail: addOk ? "item visible after add" : "item not found after add",
  });
  await shot(page, `${artifactDir}/02-after-add.png`, screenshots);

  if (!addOk) {
    return { exercised: true, addOk: false, deleteOk: false };
  }

  // Delete: prefer controls near the row containing the task text.
  let deleteOk = false;
  try {
    const row = page
      .locator('li, [role="listitem"], article, tr, div')
      .filter({ hasText: taskText })
      .first();

    const deleteInRow = row
      .locator(
        [
          'button[aria-label*="delete" i]',
          'button[aria-label*="remove" i]',
          'button[title*="delete" i]',
          'button[title*="remove" i]',
          'button:has-text("Delete")',
          'button:has-text("Remove")',
          '[role="button"][aria-label*="delete" i]',
          '[role="button"][aria-label*="remove" i]',
        ].join(", "),
      )
      .first();

    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.hover({ timeout: 3_000 }).catch(() => {});
    await sleep(400);

    if (await deleteInRow.isVisible({ timeout: 2_500 }).catch(() => false)) {
      await deleteInRow.click({ timeout: 5_000 });
      steps.push({
        name: "form:deleteClick",
        ok: true,
        detail: "row delete control",
      });
    } else {
      // Icon-only buttons: last button in the row is often delete.
      const buttonsInRow = row.locator("button, [role='button']");
      const count = await buttonsInRow.count();
      if (count > 0) {
        await buttonsInRow.nth(count - 1).click({ timeout: 5_000 });
        steps.push({
          name: "form:deleteClick",
          ok: true,
          detail: `clicked last of ${count} row button(s)`,
        });
      } else {
        steps.push({
          name: "form:deleteClick",
          ok: false,
          detail: "no delete control found in row",
        });
        await shot(page, `${artifactDir}/03-after-delete.png`, screenshots);
        return { exercised: true, addOk: true, deleteOk: false };
      }
    }

    await sleep(800);
    deleteOk = !(await page
      .getByText(taskText, { exact: false })
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false));
    steps.push({
      name: "form:assertDeleted",
      ok: deleteOk,
      detail: deleteOk
        ? "item gone after delete"
        : "item still visible after delete",
    });
  } catch (error) {
    steps.push({
      name: "form:deleteClick",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  await shot(page, `${artifactDir}/03-after-delete.png`, screenshots);
  return { exercised: true, addOk, deleteOk };
}

export async function exerciseGenericClicks(
  page: Page,
  previewUrl: string,
  origin: string,
  artifactDir: string,
  maxClicks: number,
  steps: AppTestStep[],
  screenshots: string[],
): Promise<number> {
  const ctas = await collectVisibleCtas(page);
  let clickCount = 0;
  let shotIndex = 10;

  for (const cta of ctas) {
    if (clickCount >= maxClicks) break;
    // Skip Add — form flow owns that.
    if (/^add$/i.test(cta.label.trim())) continue;

    try {
      const beforeUrl = page.url();
      await page.locator(cta.selector).first().click({ timeout: 5_000 });
      await page
        .waitForLoadState("domcontentloaded", { timeout: 8_000 })
        .catch(() => {});
      await sleep(400);

      const afterUrl = page.url();
      if (!afterUrl.startsWith(origin)) {
        await page.goto(previewUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        steps.push({
          name: `click:${cta.label}`,
          ok: false,
          detail: `navigated off origin to ${afterUrl}; restored preview`,
        });
        clickCount += 1;
        continue;
      }

      clickCount += 1;
      shotIndex += 1;
      await shot(
        page,
        `${artifactDir}/${String(shotIndex).padStart(2, "0")}-after-click.png`,
        screenshots,
      );
      steps.push({
        name: `click:${cta.label}`,
        ok: true,
        detail: afterUrl === beforeUrl ? "same url" : afterUrl,
      });
    } catch (error) {
      steps.push({
        name: `click:${cta.label}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      clickCount += 1;
    }
  }

  if (ctas.length === 0) {
    steps.push({
      name: "discoverCtas",
      ok: true,
      detail: "no visible buttons/links found",
    });
  }

  return clickCount;
}

async function collectVisibleCtas(page: Page): Promise<
  Array<{ label: string; selector: string }>
> {
  try {
    return await page.evaluate(() => {
      const candidates: Array<{ label: string; selector: string }> = [];
      const nodes = document.querySelectorAll(
        'a[href], button, [role="button"], input[type="submit"]',
      );
      let index = 0;
      for (const node of nodes) {
        const el = node as HTMLElement;
        if (el.getAttribute("aria-hidden") === "true") continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;

        const label = (
          el.innerText ||
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          (el as HTMLInputElement).value ||
          el.tagName
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        if (!label) continue;

        const attr = `data-app-test-cta="${index}"`;
        el.setAttribute("data-app-test-cta", String(index));
        candidates.push({ label, selector: `[${attr}]` });
        index += 1;
        if (candidates.length >= 12) break;
      }
      return candidates;
    });
  } catch {
    return [];
  }
}
