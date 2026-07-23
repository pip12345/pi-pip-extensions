export const MAX_SUBAGENT_RESULT_CHARS = 20_000;
export const MAX_SUBAGENT_STATUS_CHARS = 12_000;
export const MAX_SUBAGENT_COMPLETION_CHARS = 8_000;
export const MAX_SUBAGENT_EVENT_TEXT_CHARS = 2_000;
export const MAX_SUBAGENT_ERROR_CHARS = 4_000;
export const MAX_SUBAGENT_PERSISTED_PROMPT_CHARS = 8_000;
export const MAX_SUBAGENT_EVENTS = 120;

export function boundSubagentText(value: unknown, maxChars: number, maxLines = 200): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const sampled = text.slice(0, maxChars + 1);
  const lines = sampled.split("\n");
  const lineBounded = lines.slice(0, maxLines).join("\n");
  const truncated = text.length > maxChars || lines.length > maxLines;
  if (!truncated) return lineBounded;
  const suffix = "\n...[truncated]";
  return `${lineBounded.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

export function boundSubagentResult(value: unknown, sessionFile?: string, maxChars = MAX_SUBAGENT_RESULT_CHARS): string {
  const hint = sessionFile ? `\n...[truncated; full child transcript: ${boundSubagentText(sessionFile, 500, 1)}]` : "\n...[truncated]";
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const sampled = boundSubagentText(text, maxChars, 200);
  if (sampled === text) return sampled;
  return `${sampled.replace(/\n\.\.\.\[truncated\]$/, "").slice(0, Math.max(0, maxChars - hint.length))}${hint}`;
}
