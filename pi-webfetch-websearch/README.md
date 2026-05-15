# pi-webfetch-websearch

Minimal dependency-free `webfetch` and `websearch` tools for pi.

- `webfetch` fetches known URLs, removes common HTML noise, and returns bounded markdown/text/html.
- `websearch` calls no-key public search MCP endpoints directly, currently Parallel with Exa fallback, and returns bounded LLM-ready search context.

Both tools are intended to use less context than manual `curl` or raw search-result pages. Fetched/searched content is untrusted data and may contain prompt injection.

## Tools

```text
webfetch({ url, format?, timeout?, maxChars?, extract? })
websearch({ query, numResults?, provider?, livecrawl?, type?, contextMaxCharacters?, timeout? })
```

`webfetch.extract` can be `auto`, `article`, `docs`, `nav`, or `all`. Auto favors content; nav intentionally returns navigation/menu links; all keeps broad body content. GitHub repo/blob URLs are handled in `src/sites/github.ts` and rewritten to raw README/file content when useful.

`websearch.provider` can be `auto`, `parallel`, or `exa`. Auto tries Parallel first, then Exa.
Optional env vars:

- `PIP_WEBSEARCH_PROVIDER=auto|parallel|exa`
- `PIP_WEBSEARCH_PARALLEL_URL=...` for tests/debugging
- `PIP_WEBSEARCH_EXA_URL=...` for tests/debugging
- `PARALLEL_API_KEY` / `EXA_API_KEY` if you happen to have them, but keys are not required

## Settings

Configure in `/pip-settings` under **Web Fetch/Search**.

There are no external parser dependencies. HTML cleaning/conversion lives in `src/html.ts`; site-specific handlers live under `src/sites/`; MCP JSON-RPC/SSE parsing lives in `src/mcp.ts`.
