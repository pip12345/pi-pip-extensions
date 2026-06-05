import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "./keys.ts";

export type ThemeLike = { fg?: (name: string, text: string) => string; bg?: (name: string, text: string) => string; bold?: (text: string) => string };

export function themeFg(theme: ThemeLike | undefined, name: string, text: string): string {
  return theme?.fg ? theme.fg(name, text) : text;
}

export function themeBg(theme: ThemeLike | undefined, name: string, text: string): string {
  return theme?.bg ? theme.bg(name, text) : text;
}

export function themeBold(theme: ThemeLike | undefined, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

export function padAnsi(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function padLeftAnsi(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

export function wrapAnsi(value: string, width: number): string[] {
  return wrapTextWithAnsi(value, Math.max(1, width));
}

export interface BoxOptions {
  title?: string;
  borderColor?: string;
  titleColor?: string;
}

export function boxLines(lines: string[], width: number, theme?: ThemeLike, options: BoxOptions = {}): string[] {
  const inner = Math.max(10, width - 2);
  const borderColor = options.borderColor ?? "border";
  const titleColor = options.titleColor ?? "accent";
  const title = options.title ? truncateToWidth(` ${options.title} `, inner) : "";

  let top: string;
  if (title) {
    const left = "─".repeat(Math.floor(Math.max(0, inner - visibleWidth(title)) / 2));
    const right = "─".repeat(Math.max(0, inner - visibleWidth(title) - visibleWidth(left)));
    top = themeFg(theme, borderColor, `╭${left}`) + themeFg(theme, titleColor, title) + themeFg(theme, borderColor, `${right}╮`);
  } else {
    top = themeFg(theme, borderColor, `╭${"─".repeat(inner)}╮`);
  }

  const out = [top];
  for (const line of lines) {
    out.push(themeFg(theme, borderColor, "│") + padAnsi(truncateToWidth(line, inner), inner) + themeFg(theme, borderColor, "│"));
  }
  out.push(themeFg(theme, borderColor, `╰${"─".repeat(inner)}╯`));
  return out;
}
