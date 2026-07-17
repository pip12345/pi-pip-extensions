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

There is no model-facing `inline`/`file` switch. Output mode is automatic.

## Output behavior

The tools decide whether to return content inline or save it to a session artifact based on size and intent.

### webfetch

`webfetch` is for a known URL.

- Small cleaned pages are returned inline directly.
- Larger cleaned pages are saved to an artifact file under `~/.pi/agent/pip/webfetch-websearch`.
- If `maxChars` is explicitly small, `webfetch` treats that as a request for a small inline excerpt and truncates to that limit.
- Artifact responses include the saved path and an outline when headings are available.
- Bodies are streamed and cancelled at the configured 1–5 MB byte limit.
- With private-host blocking enabled, every redirect is validated and DNS-approved public addresses are pinned to the connection.

Current inline threshold: about 8k characters.

Use `read`, `grep`, or `bash`/`sed` against artifact paths for focused inspection instead of pulling whole large pages into chat context.

### websearch

`websearch` is for unknown/current information.

- Compact formatted search results are returned inline.
- Full formatted search context is saved to an artifact automatically.
- Larger search contexts return the artifact summary/path instead of dumping all result context inline.
- `contextMaxCharacters` bounds provider-side context when supported and also caps compact inline output.
- Provider responses have an additional client-side streaming byte cap; malformed and JSON-RPC error responses trigger automatic fallback.

This gives the model enough immediate context for small searches while preserving the full result set for follow-up inspection.

## Fetch options

`webfetch.extract` can be `auto`, `nav`, or `all`.

- `auto` favors article/content extraction.
- `nav` intentionally extracts navigation/menu links.
- `all` keeps broad body content.

GitHub repo/blob URLs are handled in `src/sites/github.ts` and rewritten to raw README/file content when useful.

## Search options

`websearch.provider` can be `auto`, `parallel`, or `exa`. Auto tries Parallel first, then Exa.

Optional env vars:

- `PIP_WEBSEARCH_PROVIDER=auto|parallel|exa`
- `PIP_WEBSEARCH_PARALLEL_URL=...` for tests/debugging
- `PIP_WEBSEARCH_EXA_URL=...` for tests/debugging
- `PARALLEL_API_KEY` / `EXA_API_KEY` if you happen to have them, but keys are not required

## Settings

Configure in `/pip-settings` under **Web Fetch/Search**.

There are no external parser dependencies. HTML cleaning/conversion lives in `src/html.ts`; site-specific handlers live under `src/sites/`; MCP JSON-RPC/SSE parsing lives in `src/mcp.ts`.
