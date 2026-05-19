import { decodeKittyPrintable, matchesKey, parseKey } from "@earendil-works/pi-tui";

export const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce((width, char) => width + charWidth(char), 0);
}

export function truncateToWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let width = 0;
  let result = "";
  let index = 0;
  const ansiAtIndex = new RegExp(ANSI_RE.source, "y");

  while (index < value.length) {
    ansiAtIndex.lastIndex = index;
    const ansi = ansiAtIndex.exec(value);
    if (ansi) {
      result += ansi[0];
      index = ansiAtIndex.lastIndex;
      continue;
    }

    const char = Array.from(value.slice(index))[0];
    const nextWidth = width + charWidth(char);
    if (nextWidth > maxWidth) break;
    result += char;
    width = nextWidth;
    index += char.length;
  }
  return result;
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
