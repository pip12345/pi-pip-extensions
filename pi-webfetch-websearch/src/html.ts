import { decodeHtmlEntities } from "./entities.ts";

const SKIP_BLOCKS = ["script", "style", "noscript", "iframe", "object", "embed", "canvas", "svg", "template"];
const CHROME_BLOCKS = ["nav", "aside", "footer", "header"];
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "br", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

export type HtmlExtractMode = "auto" | "nav" | "all";

export interface HtmlConversionResult {
  text: string;
  rawChars: number;
  extractedChars: number;
  extractMode: HtmlExtractMode;
}

interface Candidate {
  html: string;
  tag: string;
  attrs: string;
  score: number;
}

export function htmlToText(html: string, options: { extract?: HtmlExtractMode } = {}): HtmlConversionResult {
  const mode = options.extract ?? "auto";
  const extracted = extractHtml(html, mode);
  const withoutNoise = stripNoiseBlocks(mode === "all" || mode === "nav" ? extracted : stripChromeBlocks(extracted));
  const withBreaks = withoutNoise
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n");
  const stripped = withBreaks.replace(/<\s*\/\s*(p|div|section|article|main|header|footer|blockquote|li|tr|table|ul|ol|h[1-6]|pre)\s*>/gi, "\n").replace(/<[^>]*>/g, " ");
  return {
    text: normalizePlainText(decodeHtmlEntities(stripped)),
    rawChars: html.length,
    extractedChars: extracted.length,
    extractMode: mode,
  };
}

export function htmlToMarkdown(html: string, baseUrl?: string, options: { extract?: HtmlExtractMode } = {}): HtmlConversionResult {
  const mode = options.extract ?? "auto";
  const extracted = extractHtml(html, mode);
  let out = stripNoiseBlocks(mode === "all" || mode === "nav" ? extracted : stripChromeBlocks(extracted)).replace(/<!--[^]*?-->/g, " ");

  out = convertPreBlocks(out);
  out = convertLinks(out, baseUrl);
  out = out
    .replace(/<\s*h1\b[^>]*>/gi, "\n# ").replace(/<\s*\/\s*h1\s*>/gi, "\n\n")
    .replace(/<\s*h2\b[^>]*>/gi, "\n## ").replace(/<\s*\/\s*h2\s*>/gi, "\n\n")
    .replace(/<\s*h3\b[^>]*>/gi, "\n### ").replace(/<\s*\/\s*h3\s*>/gi, "\n\n")
    .replace(/<\s*h[4-6]\b[^>]*>/gi, "\n#### ").replace(/<\s*\/\s*h[4-6]\s*>/gi, "\n\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ").replace(/<\s*\/\s*li\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|section|article|main|header|footer|blockquote|tr|table|ul|ol)\s*>/gi, "\n\n")
    .replace(/<\s*(p|div|section|article|main|header|footer|blockquote|tr|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\s*\/?\s*(strong|b)\b[^>]*>/gi, "**")
    .replace(/<\s*\/?\s*(em|i)\b[^>]*>/gi, "*")
    .replace(/<[^>]*>/g, " ");

  return {
    text: normalizeMarkdown(decodeHtmlEntities(out)),
    rawChars: html.length,
    extractedChars: extracted.length,
    extractMode: mode,
  };
}

export function extractTitle(html: string): string | undefined {
  const match = /<\s*title\b[^>]*>([^]*?)<\s*\/\s*title\s*>/i.exec(html);
  const title = match ? normalizePlainText(decodeHtmlEntities(match[1].replace(/<[^>]*>/g, " "))) : "";
  return title || undefined;
}

export function extractHtml(html: string, mode: HtmlExtractMode = "auto"): string {
  if (mode === "all") return firstTagContent(html, "body") ?? html;
  if (mode === "nav") return extractNavHtml(html);
  const candidates = collectCandidates(html, mode);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.html ?? firstTagContent(html, "body") ?? html;
}

function extractNavHtml(html: string): string {
  const navs = [...tagContents(html, "nav"), ...tagContents(html, "header")].map((candidate) => candidate.html).filter((value) => visibleTextScore(value) > 0);
  if (navs.length) return navs.join("\n");
  return firstTagContent(html, "body") ?? html;
}

function collectCandidates(html: string, mode: HtmlExtractMode): Candidate[] {
  const out: Candidate[] = [];
  const tags = ["article", "main", "section", "div", "body"];
  for (const tag of tags) {
    for (const candidate of tagContents(html, tag)) {
      const textScore = visibleTextScore(candidate.html);
      if (textScore < 40 && tag !== "body") continue;
      const linkPenalty = linkDensity(candidate.html) * 300;
      const attrBoost = attributeBoost(candidate.attrs);
      const tagBoost = tag === "article" ? 700 : tag === "main" ? 600 : tag === "section" ? 120 : tag === "body" ? -250 : 0;
      const headingBoost = /<\s*h1\b/i.test(candidate.html) ? 180 : /<\s*h[2-3]\b/i.test(candidate.html) ? 80 : 0;
      const chromePenalty = /\b(nav|menu|sidebar|footer|header|breadcrumb|pagination)\b/i.test(candidate.attrs) ? 500 : 0;
      out.push({ ...candidate, score: textScore + attrBoost + tagBoost + headingBoost - linkPenalty - chromePenalty });
    }
  }
  return out;
}

function attributeBoost(attrs: string): number {
  const value = attrs.toLowerCase();
  let boost = 0;
  if (/\b(markdown-body|readme|article|post|entry-content|content|main|prose|doc|docs|documentation|api|reference)\b/.test(value)) boost += 900;
  if (/\b(nav|menu|sidebar|footer|header|breadcrumb|toc)\b/.test(value)) boost -= 900;
  return boost;
}

function tagContents(html: string, tag: string): Candidate[] {
  const out: Candidate[] = [];
  const openPattern = new RegExp(`<\\s*${tag}\\b([^>]*)>`, "gi");
  let open: RegExpExecArray | null;
  while ((open = openPattern.exec(html))) {
    const start = open.index + open[0].length;
    const tagPattern = new RegExp(`<\\s*\\/?\\s*${tag}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = start;
    let depth = 1;
    let match: RegExpExecArray | null;
    let end = html.length;
    while ((match = tagPattern.exec(html))) {
      if (/^<\s*\//.test(match[0])) depth--;
      else depth++;
      if (depth === 0) {
        end = match.index;
        break;
      }
    }
    out.push({ tag, attrs: open[1] ?? "", html: html.slice(start, end), score: 0 });
    openPattern.lastIndex = Math.max(openPattern.lastIndex, end);
  }
  return out;
}

function stripNoiseBlocks(html: string): string {
  let out = html;
  for (const tag of SKIP_BLOCKS) out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[^]*?<\\s*\\/\\s*${tag}\\s*>`, "gi"), " ");
  return out;
}

function stripChromeBlocks(html: string): string {
  let out = html;
  for (const tag of CHROME_BLOCKS) out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[^]*?<\\s*\\/\\s*${tag}\\s*>`, "gi"), " ");
  return out;
}

function firstTagContent(html: string, tag: string): string | undefined {
  return tagContents(html, tag)[0]?.html;
}

function visibleTextScore(html: string): number {
  return stripNoiseBlocks(html).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().length;
}

function linkDensity(html: string): number {
  const total = Math.max(1, visibleTextScore(html));
  const links = [...html.matchAll(/<\s*a\b[^>]*>([^]*?)<\s*\/\s*a\s*>/gi)].map((match) => match[1].replace(/<[^>]*>/g, "")).join(" ").trim().length;
  return links / total;
}

function convertPreBlocks(html: string): string {
  return html.replace(/<\s*pre\b[^>]*>([^]*?)<\s*\/\s*pre\s*>/gi, (_match, body: string) => {
    const text = decodeHtmlEntities(body.replace(/<[^>]*>/g, "")).trim();
    return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : "\n\n";
  });
}

function convertLinks(html: string, baseUrl?: string): string {
  return html.replace(/<\s*a\b([^>]*)>([^]*?)<\s*\/\s*a\s*>/gi, (_match, attrs: string, body: string) => {
    const text = normalizePlainText(decodeHtmlEntities(body.replace(/<[^>]*>/g, " ")));
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)?.slice(1).find(Boolean);
    if (!text) return "";
    const url = href ? resolveUrl(decodeHtmlEntities(href), baseUrl) : undefined;
    return url ? `[${escapeMarkdownLinkText(text)}](${url})` : text;
  });
}

function resolveUrl(href: string, baseUrl?: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^javascript:/i.test(trimmed) || /^mailto:/i.test(trimmed)) return undefined;
  try {
    return baseUrl ? new URL(trimmed, baseUrl).toString() : new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\[\]]/g, "\\$&");
}

function normalizePlainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^ +/gm, "")
    .trim();
}

export function tagLooksBlock(tag: string): boolean {
  return BLOCK_TAGS.has(tag.toLowerCase());
}
