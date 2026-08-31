/**
 * Postgres jsonb rejects U+0000 and unpaired UTF-16 surrogates
 * (`unsupported Unicode escape sequence`). Drop those code points rather
 * than substituting U+FFFD, so the UI never shows a replacement glyph.
 *
 * Iterate by Unicode code point (`for...of`): a valid emoji is one
 * iteration and is kept; a lone surrogate is one iteration and is dropped.
 */
export function sanitizeJsonbText(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) {
      continue;
    }
    out += ch;
  }
  return out;
}

export function sanitizeJsonbValue<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeJsonbText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonbValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[sanitizeJsonbText(key)] = sanitizeJsonbValue(child);
    }
    return out as T;
  }
  return value;
}
