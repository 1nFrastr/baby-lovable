import { useCallback, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

import {
  isSlashMenuDraft,
  matchSlashCommands,
  resolveComposerSubmit,
  slashMenuQuery,
  type SlashSurface,
} from "@/lib/chat/slash-commands";

export function useSlashCommandComposer(options: {
  surface: SlashSurface;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const query = slashMenuQuery(value);
  const matches = useMemo(
    () =>
      query == null ? [] : matchSlashCommands(query, options.surface),
    [options.surface, query],
  );

  const menuOpen =
    !options.disabled &&
    !dismissed &&
    isSlashMenuDraft(value) &&
    query != null;

  const highlighted = menuOpen ? matches[highlight] : undefined;

  const onValueChange = useCallback((next: string) => {
    setValue(next);
    setDismissed(false);
    setHighlight(0);
  }, []);

  const clear = useCallback(() => {
    setValue("");
    setDismissed(false);
    setHighlight(0);
  }, []);

  const resolveSubmit = useCallback(
    (text: string) =>
      resolveComposerSubmit(text, {
        surface: options.surface,
        highlightedName: menuOpen ? highlighted?.name : undefined,
      }),
    [highlighted?.name, menuOpen, options.surface],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!menuOpen) {
        return false;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return true;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (matches.length === 0) {
          return true;
        }
        setHighlight((index) => (index + 1) % matches.length);
        return true;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (matches.length === 0) {
          return true;
        }
        setHighlight(
          (index) => (index - 1 + matches.length) % matches.length,
        );
        return true;
      }

      if (event.key === "Tab" && matches.length > 0) {
        event.preventDefault();
        const command = matches[highlight] ?? matches[0];
        if (command) {
          setValue(`/${command.name} `);
          setDismissed(true);
          setHighlight(0);
        }
        return true;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        // Let the form submit; Chat resolves the highlighted command.
        return false;
      }

      return false;
    },
    [highlight, matches, menuOpen],
  );

  return {
    value,
    setValue: onValueChange,
    clear,
    menuOpen,
    matches,
    highlight,
    setHighlight,
    highlighted,
    resolveSubmit,
    handleKeyDown,
  };
}

export type SlashCommandComposer = ReturnType<typeof useSlashCommandComposer>;
