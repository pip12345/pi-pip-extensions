import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import extension, { parseMcpResponse } from "./index.ts";
import { rewriteGitHubUrl } from "./src/sites/github.ts";
import { pipSettings } from "../pip-common/index.ts";
import { createMockPi, getRegisteredTool } from "../pip-common/testing.ts";

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, test: (url: string) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function exec(tool: any, params: any) {
  return tool.execute("call-test", params, new AbortController().signal, undefined, { cwd: process.cwd() });
}

beforeEach(() => {
  pipSettings.set("webfetch-websearch.enabled", true);
  pipSettings.set("webfetch-websearch.webfetchEnabled", true);
  pipSettings.set("webfetch-websearch.websearchEnabled", true);
  pipSettings.set("webfetch-websearch.defaultFormat", "markdown");
  pipSettings.set("webfetch-websearch.fetchTimeout", "30");
  pipSettings.set("webfetch-websearch.maxBytes", "5MB");
  pipSettings.set("webfetch-websearch.maxChars", "20000");
  pipSettings.set("webfetch-websearch.upgradeHttp", false);
  pipSettings.set("webfetch-websearch.blockPrivateHosts", false);
  pipSettings.set("webfetch-websearch.searchProvider", "auto");
  pipSettings.set("webfetch-websearch.searchResults", "8");
  pipSettings.set("webfetch-websearch.searchContext", "10000");
  pipSettings.set("webfetch-websearch.searchTimeout", "25");
  delete process.env.PIP_WEBSEARCH_PROVIDER;
  delete process.env.OPENCODE_WEBSEARCH_PROVIDER;
  delete process.env.PIP_WEBSEARCH_EXA_URL;
  delete process.env.PIP_WEBSEARCH_PARALLEL_URL;
});

afterEach(() => {
  pipSettings.set("webfetch-websearch.blockPrivateHosts", true);
});

describe("pi-webfetch-websearch", () => {
  it("registers the webfetch tool", () => {
    const pi = createMockPi();
    extension(pi as any);
    expect(getRegisteredTool(pi, "webfetch")).toBeTruthy();
  });

  it("rejects invalid protocols", async () => {
    const pi = createMockPi();
    extension(pi as any);
    const tool = getRegisteredTool(pi, "webfetch");
    await expect(exec(tool, { url: "file:///tmp/test" })).rejects.toThrow(/http/);
  });

  it("respects the enabled setting", async () => {
    pipSettings.set("webfetch-websearch.enabled", false);
    const pi = createMockPi();
    extension(pi as any);
    const result = await exec(getRegisteredTool(pi, "webfetch"), { url: "https://example.com" });
    expect(result.content[0].text).toContain("disabled");
    expect(result.details.disabled).toBe(true);
  });

  it("fetches plain text", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("hello from webfetch");
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/file.txt`, format: "text" });
      expect(result.content[0].text).toBe("hello from webfetch");
      expect(result.details.contentType).toContain("text/plain");
    });
  });

  it("extracts text from html without scripts or styles", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><head><style>.x{}</style><script>alert('x')</script></head><body><main>Hello <b>world</b></main></body></html>");
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/page`, format: "text" });
      expect(result.content[0].text).toBe("Hello world");
    });
  });

  it("converts common html to markdown-ish output", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<article><h1>Docs</h1><p>Read <a href='/guide'>the guide</a>.</p><ul><li>One</li><li>Two</li></ul></article>");
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/docs`, format: "markdown" });
      expect(result.content[0].text).toContain("# Docs");
      expect(result.content[0].text).toContain(`[the guide](${base}/guide)`);
      expect(result.content[0].text).toContain("- One");
    });
  });

  it("extracts article content over navigation in auto mode", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<body><nav><a href='/a'>Alpha</a><a href='/b'>Beta</a></nav><article><h1>Real Article</h1><p>This is the useful body text.</p></article></body>");
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/article`, format: "markdown" });
      expect(result.content[0].text).toContain("# Real Article");
      expect(result.content[0].text).not.toContain("Alpha");
    });
  });

  it("can intentionally extract navigation", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<body><nav><a href='/a'>Alpha</a><a href='/b'>Beta</a></nav><article><h1>Real Article</h1><p>This is the useful body text.</p></article></body>");
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/article`, format: "markdown", extract: "nav" });
      expect(result.content[0].text).toContain("[Alpha]");
      expect(result.content[0].text).not.toContain("Real Article");
    });
  });

  it("returns raw html when requested", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<main><h1>Raw</h1></main>");
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/raw`, format: "html" });
      expect(result.content[0].text).toContain("<main><h1>Raw</h1></main>");
    });
  });

  it("enforces maxChars", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("a".repeat(5000));
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/long`, maxChars: 1200 });
      expect(result.content[0].text.length).toBeLessThanOrEqual(1200);
      expect(result.content[0].text).toContain("[Truncated:");
      expect(result.details.truncated).toBe(true);
    });
  });

  it("rejects responses larger than the configured byte limit by content-length", async () => {
    pipSettings.set("webfetch-websearch.maxBytes", "1MB");
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.setHeader("content-length", String(2 * 1024 * 1024));
      res.end("too big");
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      await expect(exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/big` })).rejects.toThrow(/too large/i);
    });
  });

  it("omits binary response bodies", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([137, 80, 78, 71]));
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/image.png` });
      expect(result.content[0].text).toContain("Binary body omitted");
      expect(result.content[0].text).not.toContain("base64");
    });
  });

  it("blocks private hosts when configured", async () => {
    pipSettings.set("webfetch-websearch.blockPrivateHosts", true);
    const pi = createMockPi();
    extension(pi as any);
    await expect(exec(getRegisteredTool(pi, "webfetch"), { url: "http://127.0.0.1:1" })).rejects.toThrow(/private|local/i);
  });

  it("times out", async () => {
    await withServer((_req, _res) => {
      // Leave the response open until the client timeout aborts.
    }, async (base) => {
      const pi = createMockPi();
      extension(pi as any);
      await expect(exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/slow`, timeout: 0.1 })).rejects.toThrow();
    });
  });

  it("rewrites GitHub repo and blob URLs to raw content URLs", () => {
    expect(rewriteGitHubUrl(new URL("https://github.com/owner/repo"))?.url).toBe("https://raw.githubusercontent.com/owner/repo/HEAD/README.md");
    expect(rewriteGitHubUrl(new URL("https://github.com/owner/repo/blob/main/src/index.ts"))?.url).toBe("https://raw.githubusercontent.com/owner/repo/main/src/index.ts");
    expect(rewriteGitHubUrl(new URL("https://github.com/owner/repo/issues/1"))).toBeUndefined();
  });

  it("registers the websearch tool", () => {
    const pi = createMockPi();
    extension(pi as any);
    expect(getRegisteredTool(pi, "websearch")).toBeTruthy();
  });

  it("parses plain and SSE MCP responses", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "search results" }] } });
    expect(parseMcpResponse(payload)).toBe("search results");
    expect(parseMcpResponse(`event: message\ndata: [DONE]\ndata: ${payload}\n\n`)).toBe("search results");
  });

  it("calls Exa websearch and returns bounded output", async () => {
    await withServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const payload = JSON.parse(body);
        expect(payload.params.name).toBe("web_search_exa");
        expect(payload.params.arguments.query).toBe("pi coding agent");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "result ".repeat(1000) }] } }));
      });
    }, async (base) => {
      process.env.PIP_WEBSEARCH_EXA_URL = `${base}/mcp`;
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "websearch"), { query: "pi coding agent", provider: "exa", contextMaxCharacters: 1200 });
      expect(result.details.provider).toBe("exa");
      expect(result.content[0].text.length).toBeLessThanOrEqual(1200);
      expect(result.content[0].text).toContain("[Truncated:");
    });
  });

  it("auto websearch falls back from Parallel to Exa", async () => {
    await withServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const payload = JSON.parse(body);
        if (payload.params.name === "web_search") {
          res.statusCode = 500;
          res.end("parallel down");
          return;
        }
        res.setHeader("content-type", "text/event-stream");
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "exa fallback result" }] } })}\n\n`);
      });
    }, async (base) => {
      process.env.PIP_WEBSEARCH_PARALLEL_URL = `${base}/parallel`;
      process.env.PIP_WEBSEARCH_EXA_URL = `${base}/exa`;
      const pi = createMockPi();
      extension(pi as any);
      const result = await exec(getRegisteredTool(pi, "websearch"), { query: "fallback test" });
      expect(result.details.provider).toBe("exa");
      expect(result.details.fallbackUsed).toBe(true);
      expect(result.content[0].text).toBe("exa fallback result");
    });
  });
});
