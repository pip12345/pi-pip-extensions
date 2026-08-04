export const COLOR_TAG_NAMES = ["red", "yellow", "green", "cyan", "magenta"] as const;

export type ColorTagName = (typeof COLOR_TAG_NAMES)[number];

type ColorTagToken = {
  start: number;
  end: number;
  color: ColorTagName;
  closing: boolean;
};

const COLOR_TAG_PATTERN = /^\[(\/)?(red|yellow|green|cyan|magenta)\]/i;
const ANSI_FOREGROUND: Record<ColorTagName, string> = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};
const ANSI_FOREGROUND_RESET = "\x1b[39m";

type Fence = { marker: "`" | "~"; length: number };

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return undefined;
  const sequence = match[1]!;
  return { marker: sequence[0] as Fence["marker"], length: sequence.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  if (!match) return false;
  const sequence = match[1]!;
  return sequence[0] === fence.marker && sequence.length >= fence.length;
}

function tagAt(source: string, index: number): ColorTagToken | undefined {
  if (isEscaped(source, index)) return undefined;
  const match = COLOR_TAG_PATTERN.exec(source.slice(index));
  if (!match) return undefined;
  return {
    start: index,
    end: index + match[0].length,
    color: match[2]!.toLowerCase() as ColorTagName,
    closing: Boolean(match[1]),
  };
}

function collectColorTags(source: string): ColorTagToken[] {
  const tags: ColorTagToken[] = [];
  let cursor = 0;
  let lineStart = true;
  let fence: Fence | undefined;
  let inlineTicks = 0;

  while (cursor < source.length) {
    if (lineStart) {
      const newline = source.indexOf("\n", cursor);
      const lineEnd = newline === -1 ? source.length : newline;
      const line = source.slice(cursor, lineEnd).replace(/\r$/, "");

      if (fence) {
        if (closesFence(line, fence)) fence = undefined;
        cursor = newline === -1 ? source.length : newline + 1;
        lineStart = true;
        continue;
      }

      const nextFence = openingFence(line);
      if (nextFence) {
        fence = nextFence;
        cursor = newline === -1 ? source.length : newline + 1;
        lineStart = true;
        continue;
      }

      lineStart = false;
    }

    const char = source[cursor]!;
    if (char === "\n") {
      cursor++;
      lineStart = true;
      continue;
    }

    if (char === "`") {
      let runLength = 1;
      while (source[cursor + runLength] === "`") runLength++;
      if (inlineTicks === 0) inlineTicks = runLength;
      else if (inlineTicks === runLength) inlineTicks = 0;
      cursor += runLength;
      continue;
    }

    if (char === "[" && inlineTicks === 0) {
      const tag = tagAt(source, cursor);
      if (tag) {
        tags.push(tag);
        cursor = tag.end;
        continue;
      }
    }

    cursor++;
  }

  return tags;
}

function pairColorTags(tags: readonly ColorTagToken[]): Map<number, ColorTagToken> {
  const pairs = new Map<number, ColorTagToken>();
  const stack: ColorTagToken[] = [];

  for (const tag of tags) {
    if (!tag.closing) {
      stack.push(tag);
      continue;
    }

    const opener = stack.at(-1);
    if (!opener || opener.color !== tag.color) continue;
    stack.pop();
    pairs.set(opener.start, tag);
    pairs.set(tag.start, opener);
  }

  return pairs;
}

function enclosingBoldMarker(source: string, opener: ColorTagToken, closer: ColorTagToken): "**" | "__" | undefined {
  for (const marker of ["**", "__"] as const) {
    const contentStart = opener.end;
    const contentEnd = closer.start;
    if (
      contentEnd - contentStart >= marker.length * 2 &&
      source.startsWith(marker, contentStart) &&
      source.slice(0, contentEnd).endsWith(marker)
    ) {
      return marker;
    }
  }
  return undefined;
}

/** Convert balanced color tags outside Markdown code into terminal foreground styling. */
export function renderColorTags(source: string): string {
  const tags = collectColorTags(source);
  const pairs = pairColorTags(tags);
  if (pairs.size === 0) return source;

  const activeColors: ColorTagName[] = [];
  const boldMarkerByCloser = new Map<number, "**" | "__">();
  let cursor = 0;
  let output = "";

  for (const tag of tags) {
    const beforeTag = source.slice(cursor, tag.start);
    const partner = pairs.get(tag.start);
    if (!partner) {
      output += beforeTag + source.slice(tag.start, tag.end);
    } else if (!tag.closing) {
      output += beforeTag;
      const boldMarker = enclosingBoldMarker(source, tag, partner);
      if (boldMarker) {
        output += boldMarker;
        cursor = tag.end + boldMarker.length;
        boldMarkerByCloser.set(partner.start, boldMarker);
      } else {
        cursor = tag.end;
      }
      activeColors.push(tag.color);
      output += ANSI_FOREGROUND[tag.color];
      continue;
    } else {
      const boldMarker = boldMarkerByCloser.get(tag.start);
      if (boldMarker && beforeTag.endsWith(boldMarker)) {
        output += beforeTag.slice(0, -boldMarker.length);
      } else {
        output += beforeTag;
      }
      activeColors.pop();
      const outerColor = activeColors.at(-1);
      output += outerColor ? ANSI_FOREGROUND[outerColor] : ANSI_FOREGROUND_RESET;
      if (boldMarker) output += boldMarker;
    }
    cursor = tag.end;
  }

  return output + source.slice(cursor);
}

export function colorizeAssistantMessage<T>(message: T): T {
  if (!message || typeof message !== "object") return message;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return message;

  let changed = false;
  const content = candidate.content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const textPart = part as { type?: unknown; text?: unknown };
    if (textPart.type !== "text" || typeof textPart.text !== "string") return part;
    const text = renderColorTags(textPart.text);
    if (text === textPart.text) return part;
    changed = true;
    return { ...textPart, text };
  });

  return changed ? ({ ...candidate, content } as T) : message;
}
