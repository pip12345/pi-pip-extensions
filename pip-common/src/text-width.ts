import { padAnsi } from "./tui.ts";
import { truncateToWidth } from "./keys.ts";

export function expandTabs(value: string, tabSize = 4): string {
  return value.replace(/\t/g, " ".repeat(tabSize));
}

export function safeTruncateToWidth(value: string, width: number): string {
  return truncateToWidth(expandTabs(value), width);
}

export function safePadToWidth(value: string, width: number): string {
  return padAnsi(safeTruncateToWidth(value, width), width);
}
