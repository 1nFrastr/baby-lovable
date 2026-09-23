import { describe, expect, it } from "vitest";

import { evaluateExecPolicy, execRestartsPreview } from "./exec-policy";

describe("evaluateExecPolicy", () => {
  it("allows inspect pipelines", () => {
    const result = evaluateExecPolicy("rg -n TODO src --glob '*.tsx' | head -50");
    expect(result).toMatchObject({ ok: true, kind: "inspect" });
  });

  it("allows ls/find and baby discovery", () => {
    expect(evaluateExecPolicy("ls -la src/components").ok).toBe(true);
    expect(evaluateExecPolicy("find src -name '*.tsx' | wc -l").ok).toBe(true);
    expect(evaluateExecPolicy("baby skills")).toMatchObject({
      ok: true,
      kind: "inspect",
    });
    expect(evaluateExecPolicy("baby skill preview")).toMatchObject({
      ok: true,
      kind: "inspect",
    });
  });

  it("allows mkdir for source folders", () => {
    expect(evaluateExecPolicy("mkdir -p src/components/todo").ok).toBe(true);
  });

  it("allows pnpm add/remove/install and npm spellings", () => {
    expect(evaluateExecPolicy("pnpm add lucide-react")).toMatchObject({
      ok: true,
      kind: "pkg",
    });
    expect(evaluateExecPolicy("pnpm add -D zod")).toMatchObject({
      ok: true,
      kind: "pkg",
    });
    expect(evaluateExecPolicy("pnpm install")).toMatchObject({
      ok: true,
      kind: "pkg",
    });
    expect(evaluateExecPolicy("npm uninstall lucide-react")).toMatchObject({
      ok: true,
      kind: "pkg",
    });
    expect(
      evaluateExecPolicy("pnpm add lucide-react && rg lucide package.json"),
    ).toMatchObject({ ok: true, kind: "pkg" });
  });

  it("allows skill scripts and restarts preview only for deps", () => {
    const depsCmd = "bash .baby/skills/deps/scripts/add.sh lucide-react";
    const deps = evaluateExecPolicy(depsCmd);
    expect(deps).toMatchObject({ ok: true, kind: "skill-script" });
    if (deps.ok) {
      expect(execRestartsPreview(deps, depsCmd)).toBe(true);
    }

    const webCmd = 'bash .baby/skills/web/scripts/search.sh "rust async"';
    const web = evaluateExecPolicy(webCmd);
    expect(web).toMatchObject({ ok: true, kind: "skill-script" });
    if (web.ok) {
      expect(execRestartsPreview(web, webCmd)).toBe(false);
    }
  });

  it("rejects preview lifecycle and background jobs", () => {
    expect(evaluateExecPolicy("pnpm dev").ok).toBe(false);
    expect(evaluateExecPolicy("npm run dev").ok).toBe(false);
    expect(evaluateExecPolicy("next dev --port 3000").ok).toBe(false);
    expect(evaluateExecPolicy("rg foo &").ok).toBe(false);
    expect(evaluateExecPolicy("nohup rg foo").ok).toBe(false);
  });

  it("rejects git and source mutation via bash", () => {
    expect(evaluateExecPolicy("git status").ok).toBe(false);
    expect(evaluateExecPolicy("sed -i 's/a/b/' src/app/page.tsx").ok).toBe(false);
    expect(evaluateExecPolicy("echo hi > src/app/page.tsx").ok).toBe(false);
    expect(evaluateExecPolicy("rg foo | tee src/out.txt").ok).toBe(false);
    expect(evaluateExecPolicy("rm src/app/page.tsx").ok).toBe(false);
    expect(evaluateExecPolicy("mv src/a.tsx src/b.tsx").ok).toBe(false);
  });

  it("rejects managed trees but allows negated ripgrep globs", () => {
    expect(evaluateExecPolicy("tail -n 20 .next/dev/logs/next-development.log").ok).toBe(
      false,
    );
    expect(evaluateExecPolicy("ls node_modules").ok).toBe(false);
    expect(evaluateExecPolicy("rg node_modules src").ok).toBe(true);
    expect(
      evaluateExecPolicy("rg -n Error src -g '!.next' -g '!node_modules'").ok,
    ).toBe(true);
  });

  it("allows curl and 2>&1", () => {
    expect(evaluateExecPolicy("curl -I https://example.com").ok).toBe(true);
    expect(evaluateExecPolicy("rg Error src 2>&1 | head").ok).toBe(true);
  });
});
