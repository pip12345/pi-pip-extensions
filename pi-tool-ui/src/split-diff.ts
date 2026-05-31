import { padAnsi, themeFg, truncateToWidth, visibleWidth } from "../../pip-common/index.ts";

type Prefix = " " | "+" | "-";

interface ParsedDiffLine {
  prefix: Prefix;
  lineNo: string;
  content: string;
}

export interface SplitDiffRow {
  kind: "context" | "change" | "add" | "remove" | "skip";
  oldNo?: string;
  newNo?: string;
  oldText?: string;
  newText?: string;
}

function parseDiffLine(line: string): ParsedDiffLine | undefined {
  const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
  if (!match) return undefined;
  return { prefix: match[1] as Prefix, lineNo: match[2].trim(), content: match[3] ?? "" };
}

export function parseEditDisplayDiff(diff: string): SplitDiffRow[] | undefined {
  const parsed = diff.split("\n").map(parseDiffLine);
  if (!parsed.length || parsed.some((line) => !line)) return undefined;
  const lines = parsed as ParsedDiffLine[];
  const rows: SplitDiffRow[] = [];

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.prefix === " ") {
      rows.push(line.content === "..." ? { kind: "skip", oldText: "...", newText: "..." } : { kind: "context", oldNo: line.lineNo, newNo: line.lineNo, oldText: line.content, newText: line.content });
      i++;
      continue;
    }

    if (line.prefix === "-") {
      const removed: ParsedDiffLine[] = [];
      while (lines[i]?.prefix === "-") removed.push(lines[i++]);
      const added: ParsedDiffLine[] = [];
      while (lines[i]?.prefix === "+") added.push(lines[i++]);
      const count = Math.max(removed.length, added.length);
      for (let index = 0; index < count; index++) {
        const oldLine = removed[index];
        const newLine = added[index];
        if (oldLine && newLine) rows.push({ kind: "change", oldNo: oldLine.lineNo, newNo: newLine.lineNo, oldText: oldLine.content, newText: newLine.content });
        else if (oldLine) rows.push({ kind: "remove", oldNo: oldLine.lineNo, oldText: oldLine.content });
        else if (newLine) rows.push({ kind: "add", newNo: newLine.lineNo, newText: newLine.content });
      }
      continue;
    }

    rows.push({ kind: "add", newNo: line.lineNo, newText: line.content });
    i++;
  }

  return rows;
}

function lineNoWidth(rows: SplitDiffRow[]): number {
  const nums = rows.flatMap((row) => [row.oldNo, row.newNo]).filter((value): value is string => !!value);
  return Math.max(2, ...nums.map((num) => visibleWidth(num)));
}

function colorForSide(row: SplitDiffRow, side: "old" | "new"): string {
  if (row.kind === "skip") return "muted";
  if (side === "old" && (row.kind === "remove" || row.kind === "change")) return "toolDiffRemoved";
  if (side === "new" && (row.kind === "add" || row.kind === "change")) return "toolDiffAdded";
  if (row.kind === "add" && side === "old") return "dim";
  if (row.kind === "remove" && side === "new") return "dim";
  return "toolDiffContext";
}

function renderCell(no: string | undefined, text: string | undefined, gutterWidth: number, contentWidth: number, theme: any, color: string): string {
  const gutter = padAnsi(no ?? "", gutterWidth);
  const body = truncateToWidth(text ?? "", contentWidth);
  return themeFg(theme, color, `${gutter} ${padAnsi(body, contentWidth)}`);
}

export function renderSplitEditDiff(diff: string, width: number, theme: any, options: { maxLines?: number } = {}): string[] | undefined {
  const rows = parseEditDisplayDiff(diff);
  if (!rows) return undefined;
  const gutterWidth = lineNoWidth(rows);
  const separator = themeFg(theme, "border", " │ ");
  const minContentWidth = 8;
  const available = Math.max(20, width - visibleWidth(separator) - (gutterWidth + 1) * 2);
  const contentWidth = Math.floor(available / 2);
  if (contentWidth < minContentWidth) return undefined;

  const maxLines = options.maxLines && options.maxLines > 0 ? options.maxLines : rows.length;
  const visibleRows = rows.slice(0, maxLines);
  const rendered = visibleRows.map((row) => {
    const oldCell = renderCell(row.oldNo, row.oldText, gutterWidth, contentWidth, theme, colorForSide(row, "old"));
    const newCell = renderCell(row.newNo, row.newText, gutterWidth, contentWidth, theme, colorForSide(row, "new"));
    return oldCell + separator + newCell;
  });
  const hidden = rows.length - visibleRows.length;
  if (hidden > 0) rendered.push(themeFg(theme, "muted", `... ${hidden} more diff lines`));
  return rendered;
}
