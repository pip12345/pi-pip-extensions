export interface FormattedWebSearch {
  text: string;
  source: "json-results" | "raw";
  resultCount?: number;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function normalizeExcerpt(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  return text ? [text] : [];
}

function parseJsonObject(rawText: string): any | undefined {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function formatWebSearchArtifact(rawText: string, query: string): FormattedWebSearch {
  const parsed = parseJsonObject(rawText);
  const results = Array.isArray(parsed?.results) ? parsed.results : undefined;
  if (!results) return { text: rawText, source: "raw" };

  const lines: string[] = [`# Web search: ${query || "results"}`];
  const searchId = clean(parsed.search_id);
  if (searchId) lines.push("", `Search ID: ${searchId}`);

  results.forEach((result: any, index: number) => {
    const title = clean(result?.title) || clean(result?.url) || `Result ${index + 1}`;
    const url = clean(result?.url);
    const date = clean(result?.publish_date);
    lines.push("", `## ${index + 1}. ${title}`);
    if (url) lines.push(`URL: ${url}`);
    if (date) lines.push(`Date: ${date}`);

    const excerpts = normalizeExcerpt(result?.excerpts);
    if (excerpts.length) {
      lines.push("", "### Excerpts");
      for (const excerpt of excerpts) lines.push("", excerpt);
    }
  });

  const text = lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return { text, source: "json-results", resultCount: results.length };
}
