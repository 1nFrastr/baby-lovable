export interface AnsiTextStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: 700;
  fontStyle?: "italic";
  opacity?: number;
  textDecoration?: string;
}

export interface AnsiTextSegment {
  text: string;
  style: AnsiTextStyle;
}

interface AnsiState {
  foreground?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const NORMAL_COLORS = [
  "#27272a",
  "#f87171",
  "#4ade80",
  "#facc15",
  "#60a5fa",
  "#e879f9",
  "#22d3ee",
  "#e4e4e7",
];
const BRIGHT_COLORS = [
  "#71717a",
  "#fca5a5",
  "#86efac",
  "#fde047",
  "#93c5fd",
  "#f0abfc",
  "#67e8f9",
  "#ffffff",
];

// SGR is captured separately; other CSI/OSC terminal controls are discarded.
const ANSI_SEQUENCE =
  /\u001B\[((?:\d{0,3}(?:;\d{0,3})*)?)m|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]/g;

function emptyState(): AnsiState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function indexedColor(index: number): string | undefined {
  if (index < 0 || index > 255) {
    return undefined;
  }
  if (index < 8) {
    return NORMAL_COLORS[index];
  }
  if (index < 16) {
    return BRIGHT_COLORS[index - 8];
  }
  if (index < 232) {
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(value / 36) % 6];
    const green = levels[Math.floor(value / 6) % 6];
    const blue = levels[value % 6];
    return `rgb(${red}, ${green}, ${blue})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function segmentStyle(state: AnsiState): AnsiTextStyle {
  const foreground = state.inverse ? state.background : state.foreground;
  const background = state.inverse ? state.foreground : state.background;
  const decorations = [
    state.underline ? "underline" : "",
    state.strike ? "line-through" : "",
  ].filter(Boolean);
  return {
    ...(foreground ? { color: foreground } : {}),
    ...(background ? { backgroundColor: background } : {}),
    ...(state.bold ? { fontWeight: 700 as const } : {}),
    ...(state.italic ? { fontStyle: "italic" as const } : {}),
    ...(state.dim ? { opacity: 0.7 } : {}),
    ...(decorations.length > 0
      ? { textDecoration: decorations.join(" ") }
      : {}),
  };
}

function applyExtendedColor(
  codes: number[],
  start: number,
): { color?: string; consumed: number } {
  const mode = codes[start + 1];
  if (mode === 5 && Number.isFinite(codes[start + 2])) {
    return { color: indexedColor(codes[start + 2]), consumed: 2 };
  }
  if (
    mode === 2 &&
    Number.isFinite(codes[start + 2]) &&
    Number.isFinite(codes[start + 3]) &&
    Number.isFinite(codes[start + 4])
  ) {
    const red = clampByte(codes[start + 2]);
    const green = clampByte(codes[start + 3]);
    const blue = clampByte(codes[start + 4]);
    return { color: `rgb(${red}, ${green}, ${blue})`, consumed: 4 };
  }
  return { consumed: 0 };
}

function applySgr(state: AnsiState, rawCodes: string): AnsiState {
  const codes = rawCodes === "" ? [0] : rawCodes.split(";").map(Number);
  let next = { ...state };

  for (let index = 0; index < codes.length; index += 1) {
    const code = Number.isFinite(codes[index]) ? codes[index] : 0;
    if (code === 0) {
      next = emptyState();
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 9) {
      next.strike = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 27) {
      next.inverse = false;
    } else if (code === 29) {
      next.strike = false;
    } else if (code >= 30 && code <= 37) {
      next.foreground = NORMAL_COLORS[code - 30];
    } else if (code === 39) {
      next.foreground = undefined;
    } else if (code >= 40 && code <= 47) {
      next.background = NORMAL_COLORS[code - 40];
    } else if (code === 49) {
      next.background = undefined;
    } else if (code >= 90 && code <= 97) {
      next.foreground = BRIGHT_COLORS[code - 90];
    } else if (code >= 100 && code <= 107) {
      next.background = BRIGHT_COLORS[code - 100];
    } else if (code === 38 || code === 48) {
      const extended = applyExtendedColor(codes, index);
      if (extended.color) {
        if (code === 38) {
          next.foreground = extended.color;
        } else {
          next.background = extended.color;
        }
      }
      index += extended.consumed;
    }
  }
  return next;
}

/**
 * Convert ANSI terminal output into safe text/style segments.
 * The returned text never contains ESC control characters.
 */
export function parseAnsiText(input: string): AnsiTextSegment[] {
  const normalized = input.replaceAll("\u009b", "\u001b[");
  const segments: AnsiTextSegment[] = [];
  let state = emptyState();
  let cursor = 0;

  const append = (text: string) => {
    const clean = text.replaceAll("\u001b", "");
    if (clean) {
      segments.push({ text: clean, style: segmentStyle(state) });
    }
  };

  for (const match of normalized.matchAll(ANSI_SEQUENCE)) {
    append(normalized.slice(cursor, match.index));
    if (match[1] !== undefined) {
      state = applySgr(state, match[1]);
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  append(normalized.slice(cursor));
  return segments;
}
