import { describe, expect, it } from "vitest";

import {
  getSlashCommand,
  isSlashMenuDraft,
  matchSlashCommands,
  resolveComposerSubmit,
  slashMenuQuery,
} from "./slash-commands";

describe("slash commands", () => {
  it("opens the menu for a leading slash draft", () => {
    expect(isSlashMenuDraft("/")).toBe(true);
    expect(isSlashMenuDraft("/sum")).toBe(true);
    expect(isSlashMenuDraft("/summarize")).toBe(true);
    expect(isSlashMenuDraft(" /summarize")).toBe(true);
    expect(isSlashMenuDraft("/summarize extra")).toBe(false);
    expect(isSlashMenuDraft("hello")).toBe(false);
    expect(isSlashMenuDraft("hello /summarize")).toBe(false);
  });

  it("filters web commands by prefix", () => {
    expect(matchSlashCommands("", "web").map((command) => command.name)).toEqual(
      ["summarize"],
    );
    expect(
      matchSlashCommands("sum", "web").map((command) => command.name),
    ).toEqual(["summarize"]);
    expect(matchSlashCommands("exit", "web")).toEqual([]);
    expect(
      matchSlashCommands("exit", "cli").map((command) => command.name),
    ).toEqual(["exit"]);
  });

  it("resolves aliases", () => {
    expect(getSlashCommand("quit")?.name).toBe("exit");
  });

  it("submits a unique prefix as that command", () => {
    expect(resolveComposerSubmit("/sum", { surface: "web" })).toEqual({
      kind: "command",
      command: getSlashCommand("summarize"),
      args: "",
    });
    expect(resolveComposerSubmit("/summarize", { surface: "web" })).toEqual({
      kind: "command",
      command: getSlashCommand("summarize"),
      args: "",
    });
    expect(
      resolveComposerSubmit("/summarize focus on auth", { surface: "web" }),
    ).toEqual({
      kind: "command",
      command: getSlashCommand("summarize"),
      args: "focus on auth",
    });
  });

  it("keeps an incomplete slash as a draft", () => {
    expect(resolveComposerSubmit("/", { surface: "web" })).toEqual({
      kind: "slash-draft",
      query: "",
    });
  });

  it("uses the highlighted menu row when provided", () => {
    expect(
      resolveComposerSubmit("/", {
        surface: "web",
        highlightedName: "summarize",
      }),
    ).toEqual({
      kind: "command",
      command: getSlashCommand("summarize"),
      args: "",
    });
  });

  it("rejects unknown commands instead of sending them as chat", () => {
    expect(resolveComposerSubmit("/nope", { surface: "web" })).toEqual({
      kind: "unknown-command",
      name: "nope",
    });
    expect(slashMenuQuery("/nope")).toBe("nope");
  });

  it("leaves ordinary prompts as messages", () => {
    expect(resolveComposerSubmit("add a todo list")).toEqual({
      kind: "message",
      text: "add a todo list",
    });
  });

  it("resolves CLI aliases", () => {
    expect(resolveComposerSubmit("/quit", { surface: "cli" })).toEqual({
      kind: "command",
      command: getSlashCommand("exit"),
      args: "",
    });
  });
});
