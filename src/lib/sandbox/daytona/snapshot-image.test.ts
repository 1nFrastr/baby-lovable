import { describe, expect, it } from "vitest";

import { DAYTONA_WORKSPACE_ROOT } from "./config";
import {
  DAYTONA_STARTER_BASE_IMAGE,
  DAYTONA_STARTER_PNPM_VERSION,
  NEXT_DEV_WARM_SCRIPT,
  buildNextDevWarmCommands,
  buildStarterSnapshotImage,
} from "./snapshot-image";

describe("buildNextDevWarmCommands", () => {
  it("runs the warm script after asserting node_modules", () => {
    const cmds = buildNextDevWarmCommands(3000);
    const joined = cmds.join("\n");

    expect(joined).toContain("test -f node_modules/next/package.json");
    expect(joined).toContain(`chmod +x ${NEXT_DEV_WARM_SCRIPT}`);
    expect(joined).toContain(`bash ${NEXT_DEV_WARM_SCRIPT} 3000`);
    expect(joined).toContain(`rm -f ${NEXT_DEV_WARM_SCRIPT}`);
  });
});

describe("buildStarterSnapshotImage", () => {
  it("bakes pnpm, node_modules, and next-dev warm into the image Dockerfile", () => {
    const image = buildStarterSnapshotImage();
    const df = image.dockerfile;

    expect(df).toContain(`FROM ${DAYTONA_STARTER_BASE_IMAGE}`);
    expect(df).toContain(`npm install -g pnpm@${DAYTONA_STARTER_PNPM_VERSION}`);
    expect(df).toContain("pnpm --version");
    expect(df).toContain(`COPY `);
    expect(df).toContain(DAYTONA_WORKSPACE_ROOT);
    expect(df).toContain("pnpm install --frozen-lockfile");
    expect(df).toContain("test -f node_modules/next/package.json");
    expect(df).toContain("test -d node_modules/.pnpm");
    expect(df).toContain("require('next/package.json')");
    expect(df).toContain(`bash ${NEXT_DEV_WARM_SCRIPT}`);
  });

  it("includes the starter template as build context", () => {
    const image = buildStarterSnapshotImage();
    expect(image.contextList.length).toBeGreaterThan(0);
    expect(image.contextList[0]?.sourcePath).toMatch(/templates[/\\]nextjs-starter$/);
  });
});
