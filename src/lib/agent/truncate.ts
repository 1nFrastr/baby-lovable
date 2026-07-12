/** Truncate long values so logs stay readable. Workflow-safe (no Node stdio). */
export function truncate(value: unknown, max = 600): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… (${text.length} chars total)`;
}
