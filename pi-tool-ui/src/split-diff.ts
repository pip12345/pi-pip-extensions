import { padAnsi, safeTruncateToWidth, themeFg, visibleWidth } from "../../pip-common/index.ts";

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

function numericLineNo(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function hasLineNumberGap(previous: SplitDiffRow, next: SplitDiffRow): boolean {
  if (previous.kind === "skip" || next.kind === "skip") return false;
  const previousOld = numericLineNo(previous.oldNo);
  const nextOld = numericLineNo(next.oldNo);
  if (previousOld !== undefined && nextOld !== undefined && nextOld > previousOld + 1) return true;
  const previousNew = numericLineNo(previous.newNo);
  const nextNew = numericLineNo(next.newNo);
  return previousNew !== undefined && nextNew !== undefined && nextNew > previousNew + 1;
}

function insertImplicitSkipRows(rows: SplitDiffRow[]): SplitDiffRow[] {
  const rendered: SplitDiffRow[] = [];
  for (const row of rows) {
    const previous = rendered[rendered.length - 1];
    if (previous && hasLineNumberGap(previous, row)) rendered.push({ kind: "skip", oldText: "...", newText: "..." });
    rendered.push(row);
  }
  return rendered;
}

function lineNumberText(value: number): string {
  return String(value);
}

export function parseEditDisplayDiff(diff: string): SplitDiffRow[] | undefined {
  const parsed = diff.split("\n").map(parseDiffLine);
  if (!parsed.length || parsed.some((line) => !line)) return undefined;
  const lines = parsed as ParsedDiffLine[];
  const rows: SplitDiffRow[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  const syncOldLine = (line: ParsedDiffLine): number | undefined => {
    const parsedLineNo = numericLineNo(line.lineNo);
    if (parsedLineNo === undefined) return oldLine;
    if (oldLine === undefined) {
      oldLine = parsedLineNo;
      if (newLine === undefined) newLine = parsedLineNo;
      return oldLine;
    }
    if (newLine !== undefined) newLine += parsedLineNo - oldLine;
    oldLine = parsedLineNo;
    return oldLine;
  };

  const syncNewLine = (line: ParsedDiffLine): number | undefined => {
    const parsedLineNo = numericLineNo(line.lineNo);
    if (parsedLineNo === undefined) return newLine;
    if (newLine === undefined) {
      newLine = parsedLineNo;
      if (oldLine === undefined) oldLine = parsedLineNo;
      return newLine;
    }
    if (oldLine !== undefined) oldLine += parsedLineNo - newLine;
    newLine = parsedLineNo;
    return newLine;
  };

  const pushContext = (line: ParsedDiffLine): void => {
    const oldNo = syncOldLine(line);
    const newNo = newLine;
    rows.push({ kind: "context", oldNo: oldNo === undefined ? line.lineNo : lineNumberText(oldNo), newNo: newNo === undefined ? line.lineNo : lineNumberText(newNo), oldText: line.content, newText: line.content });
    if (oldLine !== undefined) oldLine++;
    if (newLine !== undefined) newLine++;
  };

  const pushRemove = (line: ParsedDiffLine): void => {
    const oldNo = syncOldLine(line);
    rows.push({ kind: "remove", oldNo: oldNo === undefined ? line.lineNo : lineNumberText(oldNo), oldText: line.content });
    if (oldLine !== undefined) oldLine++;
  };

  const pushAdd = (line: ParsedDiffLine): void => {
    const newNo = syncNewLine(line);
    rows.push({ kind: "add", newNo: newNo === undefined ? line.lineNo : lineNumberText(newNo), newText: line.content });
    if (newLine !== undefined) newLine++;
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.prefix === " ") {
      if (line.content === "...") rows.push({ kind: "skip", oldText: "...", newText: "..." });
      else pushContext(line);
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
        const oldLineData = removed[index];
        const newLineData = added[index];
        if (oldLineData && newLineData) {
          const oldNo = syncOldLine(oldLineData);
          const newNo = syncNewLine(newLineData);
          rows.push({ kind: "change", oldNo: oldNo === undefined ? oldLineData.lineNo : lineNumberText(oldNo), newNo: newNo === undefined ? newLineData.lineNo : lineNumberText(newNo), oldText: oldLineData.content, newText: newLineData.content });
          if (oldLine !== undefined) oldLine++;
          if (newLine !== undefined) newLine++;
        } else if (oldLineData) pushRemove(oldLineData);
        else if (newLineData) pushAdd(newLineData);
      }
      continue;
    }

    pushAdd(line);
    i++;
  }

  return insertImplicitSkipRows(rows);
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
  const body = safeTruncateToWidth(text ?? "", contentWidth);
  return themeFg(theme, color, `${gutter} ${padAnsi(body, contentWidth)}`);
}

function summaryLine(rows: SplitDiffRow[], theme: any): string {
  const added = rows.filter((row) => row.kind === "add" || row.kind === "change").length;
  const removed = rows.filter((row) => row.kind === "remove" || row.kind === "change").length;
  return `${themeFg(theme, "muted", "diff")} ${themeFg(theme, "toolDiffAdded", `+${added}`)} ${themeFg(theme, "toolDiffRemoved", `-${removed}`)}`;
}

function colorForUnifiedPrefix(prefix: string): string {
  if (prefix === "+") return "toolDiffAdded";
  if (prefix === "-") return "toolDiffRemoved";
  return "toolDiffContext";
}

function capRenderedLines(lines: string[], width: number): string[] {
  return lines.map((line) => safeTruncateToWidth(line, width));
}

export function renderUnifiedEditDiff(diff: string, width: number, theme: any, options: { maxLines?: number } = {}): string[] {
  const lines = diff.split("\n");
  const maxLines = options.maxLines && options.maxLines > 0 ? options.maxLines : lines.length;
  const visibleLines = lines.slice(0, maxLines);
  const rendered = visibleLines.map((line) => themeFg(theme, colorForUnifiedPrefix(line[0] ?? " "), line));
  const hidden = lines.length - visibleLines.length;
  if (hidden > 0) rendered.push(themeFg(theme, "muted", `... ${hidden} more diff lines`));
  return capRenderedLines(rendered, width);
}

export function renderSplitEditDiff(diff: string, width: number, theme: any, options: { maxLines?: number } = {}): string[] | undefined {
  const rows = parseEditDisplayDiff(diff);
  if (!rows) return undefined;
  const gutterWidth = lineNoWidth(rows);
  const separator = themeFg(theme, "border", " │ ");
  const minContentWidth = 8;
  const available = width - visibleWidth(separator) - (gutterWidth + 1) * 2;
  const contentWidth = Math.floor(available / 2);
  if (contentWidth < minContentWidth) return undefined;

  const maxLines = options.maxLines && options.maxLines > 0 ? options.maxLines : rows.length;
  const visibleRows = rows.slice(0, maxLines);
  const rendered = [summaryLine(rows, theme), ...visibleRows.map((row) => {
    const oldCell = renderCell(row.oldNo, row.oldText, gutterWidth, contentWidth, theme, colorForSide(row, "old"));
    const newCell = renderCell(row.newNo, row.newText, gutterWidth, contentWidth, theme, colorForSide(row, "new"));
    return oldCell + separator + newCell;
  })];
  const hidden = rows.length - visibleRows.length;
  if (hidden > 0) rendered.push(themeFg(theme, "muted", `... ${hidden} more diff lines`));
  return capRenderedLines(rendered, width);
}
