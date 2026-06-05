import { decodeKittyPrintable, matchesKey, parseKey, truncateToWidth as tuiTruncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export { visibleWidth };

export const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export function charWidth(char: string): number {
  return visibleWidth(char);
}

const TRAILING_SGR_RESET_RE = /\x1b\[0m$/;

export function truncateToWidth(value: string, maxWidth: number, ellipsis = "", pad = false): string {
  if (ellipsis !== "") return tuiTruncateToWidth(value, maxWidth, ellipsis, pad);
  const clipped = tuiTruncateToWidth(value, maxWidth, "", pad).replace(TRAILING_SGR_RESET_RE, "");
  return pad ? clipped + " ".repeat(Math.max(0, maxWidth - visibleWidth(clipped))) : clipped;
}

export function truncateWithEllipsis(value: string, maxWidth: number, ellipsis = "…", pad = false): string {
  return tuiTruncateToWidth(value, maxWidth, ellipsis, pad);
}

export function normalizeInputKey(data: string): string {
  if (matchesKey(data, "escape") || data === "\u001b") return "escape";
  if (matchesKey(data, "ctrl+c") || data === "\u0003") return "ctrl+c";
  if (matchesKey(data, "ctrl+d") || data === "\u0004") return "ctrl+d";
  if (matchesKey(data, "tab") || data === "\t") return "tab";
  if (matchesKey(data, "up") || data === "\u001b[A") return "up";
  if (matchesKey(data, "down") || data === "\u001b[B") return "down";
  if (matchesKey(data, "right") || data === "\u001b[C") return "right";
  if (matchesKey(data, "left") || data === "\u001b[D") return "left";
  if (matchesKey(data, "home") || data === "\u001b[H" || data === "\u001b[1~") return "home";
  if (matchesKey(data, "end") || data === "\u001b[F" || data === "\u001b[4~") return "end";
  if (data === "\u001b[1;5D" || data === "\u001b[5D") return "ctrl+left";
  if (data === "\u001b[1;5C" || data === "\u001b[5C") return "ctrl+right";
  if (matchesKey(data, "pageUp") || data === "\u001b[5~") return "pageup";
  if (matchesKey(data, "pageDown") || data === "\u001b[6~") return "pagedown";
  if (matchesKey(data, "return") || data === "\r" || data === "\n") return "return";
  if (matchesKey(data, "backspace")) return "backspace";
  if (data.length === 1 && data >= "A" && data <= "Z") return data;

  const parsed = parseKey(data);
  if (parsed) {
    if (parsed.startsWith("shift+") && parsed.length === "shift+q".length) return parsed.slice("shift+".length).toUpperCase();
    return parsed.toLowerCase();
  }

  const printable = decodeKittyPrintable(data);
  if (printable?.length === 1) return printable;
  if (data.length === 1) return data;
  return data;
}

export function printableInput(data: string): string | undefined {
  const parsed = parseKey(data);
  if (parsed?.length === 1) return parsed;
  if (parsed?.startsWith("shift+") && parsed.length === "shift+q".length) return parsed.slice("shift+".length).toUpperCase();
  const printable = decodeKittyPrintable(data);
  if (printable?.length === 1) return printable;
  if (data >= " " && data.length === 1) return data;
  return undefined;
}
