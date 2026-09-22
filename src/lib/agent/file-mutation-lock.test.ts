import { describe, expect, it } from "vitest";

import { withFileMutationLock } from "./file-mutation-lock";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("withFileMutationLock", () => {
  it("serializes mutations on the same session path and sees prior writes", async () => {
    let shared = 0;
    const order: number[] = [];

    const first = withFileMutationLock("sess_a", "src/app/page.tsx", async () => {
      const seen = shared;
      await delay(40);
      shared = seen + 1;
      order.push(1);
      return shared;
    });

    const second = withFileMutationLock("sess_a", "src/app/page.tsx", async () => {
      const seen = shared;
      await delay(10);
      shared = seen + 10;
      order.push(2);
      return shared;
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(1);
    expect(secondResult).toBe(11);
    expect(order).toEqual([1, 2]);
    expect(shared).toBe(11);
  });

  it("treats equivalent workspace paths as the same key", async () => {
    const order: string[] = [];

    const first = withFileMutationLock("sess_b", "./src/lib/a.ts", async () => {
      await delay(30);
      order.push("a");
    });
    const second = withFileMutationLock("sess_b", "src/lib/a.ts", async () => {
      order.push("b");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
  });

  it("allows overlapping work on different paths", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    async function work() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(40);
      concurrent -= 1;
    }

    await Promise.all([
      withFileMutationLock("sess_c", "src/a.ts", work),
      withFileMutationLock("sess_c", "src/b.ts", work),
    ]);

    expect(maxConcurrent).toBe(2);
  });

  it("does not serialize the same path across sessions", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    async function work() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(40);
      concurrent -= 1;
    }

    await Promise.all([
      withFileMutationLock("sess_d", "src/a.ts", work),
      withFileMutationLock("sess_e", "src/a.ts", work),
    ]);

    expect(maxConcurrent).toBe(2);
  });

  it("releases the lock when the first mutation fails", async () => {
    const first = withFileMutationLock("sess_f", "src/a.ts", async () => {
      throw new Error("write failed");
    });
    const second = withFileMutationLock("sess_f", "src/a.ts", async () => "ok");

    await expect(first).rejects.toThrow("write failed");
    await expect(second).resolves.toBe("ok");
  });
});
