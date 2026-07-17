import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import extension, { parseMcpResponse } from "./index.ts";
import { isPrivateAddress, resolvePublicAddress } from "./src/http.ts";
import { formatChars, signalWithTimeout } from "./src/limits.ts";
import { formatWebSearchArtifact } from "./src/websearch-format.ts";
import { rewriteGitHubUrl } from "./src/sites/github.ts";
import { createSettingsRegistry, setPipSettingsRegistryForTests } from "../pip-common/index.ts";
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

function exec(tool: any, params: any, ctx: any = {}) {
  return tool.execute("call-test", params, new AbortController().signal, undefined, {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
    ...ctx,
  });
}

function createWebPi(overrides: Record<string, unknown> = {}) {
  const pi = createMockPi();
  setPipSettingsRegistryForTests(pi, createSettingsRegistry({ "webfetch-websearch": { blockPrivateHosts: false, ...overrides } }, { persistPath: false }));
  extension(pi as any);
  return pi;
}

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  delete process.env.PIP_WEBSEARCH_PROVIDER;
  delete process.env.OPENCODE_WEBSEARCH_PROVIDER;
  delete process.env.PIP_WEBSEARCH_EXA_URL;
  delete process.env.PIP_WEBSEARCH_PARALLEL_URL;
});


describe("pi-webfetch-websearch", () => {
  it("formats small character counts without rounding to zero", () => {
    expect(formatChars(167)).toBe("167 chars");
    expect(formatChars(1680)).toBe("1.7K chars");
  });

  it("disposes timeout timers and parent abort listeners", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const managed = signalWithTimeout(parent.signal, 1000);

    managed.dispose();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("formats JSON websearch results as markdown artifacts", () => {
    const raw = JSON.stringify({ search_id: "s1", results: [{ url: "https://example.com", title: "Example", publish_date: "2026-01-01", excerpts: ["First excerpt"] }] });
    const result = formatWebSearchArtifact(raw, "example query");
    expect(result.source).toBe("json-results");
    expect(result.text).toContain("# Web search: example query");
    expect(result.text).toContain("## 1. Example");
    expect(result.text).toContain("URL: https://example.com");
    expect(result.text).toContain("First excerpt");
  });

  it("registers the webfetch tool without exposing output mode selection", () => {
    const pi = createWebPi();
    const tool = getRegisteredTool(pi, "webfetch");
    expect(tool).toBeTruthy();
    expect((tool.parameters as any).properties.mode).toBeUndefined();
  });

  it("rejects invalid protocols", async () => {
    const pi = createWebPi();
    const tool = getRegisteredTool(pi, "webfetch");
    await expect(exec(tool, { url: "file:///tmp/test" })).rejects.toThrow(/http/);
  });

  it("respects the enabled setting", async () => {
    const pi = createWebPi({ enabled: false });
    const result = await exec(getRegisteredTool(pi, "webfetch"), { url: "https://example.com" });
    expect(result.content[0].text).toContain("disabled");
    expect(result.details.disabled).toBe(true);
  });

  it("fetches plain text", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("hello from webfetch");
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/file.txt`, format: "text" });
      expect(result.content[0].text).toBe("hello from webfetch");
      expect(result.details.contentType).toContain("text/plain");
    });
  });

  it("follows validated redirects and reports the final URL", async () => {
    await withServer((req, res) => {
      if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "/target");
        res.end();
        return;
      }
      res.setHeader("content-type", "text/plain");
      res.end("redirect target");
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/redirect`, format: "text" });
      expect(result.content[0].text).toBe("redirect target");
      expect(result.details.finalUrl).toBe(`${base}/target`);
    });
  });

  it("rejects redirects to unsupported protocols", async () => {
    await withServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "file:///tmp/private");
      res.end();
    }, async (base) => {
      const pi = createWebPi();
      await expect(exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/redirect` })).rejects.toThrow(/http/);
    });
  });

  it("extracts text from html without scripts or styles", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><head><style>.x{}</style><script>alert('x')</script></head><body><main>Hello <b>world</b></main></body></html>");
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/page`, format: "text" });
      expect(result.content[0].text).toBe("Hello world");
    });
  });

  it("converts common html to markdown-ish output", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<article><h1>Docs</h1><p>Read <a href='/guide'>the guide</a>.</p><ul><li>One</li><li>Two</li></ul></article>");
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/docs`, format: "markdown" });
      expect(result.content[0].text).toContain("# Docs");
      expect(result.content[0].text).toContain(`[the guide](${base}/guide)`);
      expect(result.content[0].text).toContain("- One");
    });
  });

  it("saves large webfetch output to a session artifact file automatically", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<article><h1>Docs</h1><h2>Install</h2><p>npm install thing</p><h2>Usage</h2><p>${"run it ".repeat(1500)}</p></article>`);
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/docs`, format: "markdown" });
      expect(result.content[0].text).toContain("Saved webfetch result");
      expect(result.content[0].text).toContain("Outline:");
      expect(result.content[0].text).toContain("Install");
      expect(result.content[0].text).not.toContain("npm install thing");
      expect(result.details.mode).toBe("file");
      expect(result.details.artifact.path).toContain(".pi/agent/pip/webfetch-websearch/sessions");
      expect(existsSync(result.details.artifact.path)).toBe(true);
      expect(readFileSync(result.details.artifact.path, "utf8")).toContain("npm install thing");
      expect(pi.entries.at(-1)?.customType).toBe("pip.webfetchWebsearch.artifact");
      rmSync(dirname(dirname(result.details.artifact.path)), { recursive: true, force: true });
    });
  });

  it("returns small webfetch output inline automatically", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("small inline fetch");
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/small`, format: "text" });
      expect(result.content[0].text).toBe("small inline fetch");
      expect(result.details.mode).toBe("inline");
      expect(result.details.artifact).toBeUndefined();
    });
  });

  it("keeps multiple saved artifacts below the per-session limit", async () => {
    await withServer((req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(req.url === "/one" ? "first artifact ".repeat(800) : "second artifact ".repeat(800));
    }, async (base) => {
      const pi = createWebPi();
      const tool = getRegisteredTool(pi, "webfetch");
      const first = await exec(tool, { url: `${base}/one`, format: "text" });
      const second = await exec(tool, { url: `${base}/two`, format: "text" });
      expect(existsSync(first.details.artifact.path)).toBe(true);
      expect(existsSync(second.details.artifact.path)).toBe(true);
      expect(readFileSync(first.details.artifact.path, "utf8")).toContain("first artifact");
      expect(readFileSync(second.details.artifact.path, "utf8")).toContain("second artifact");
      rmSync(dirname(dirname(second.details.artifact.path)), { recursive: true, force: true });
    });
  });

  it("prunes oldest saved artifacts above the per-session limit", async () => {
    await withServer((req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(req.url === "/old" ? "old artifact ".repeat(800) : "new artifact ".repeat(800));
    }, async (base) => {
      const pi = createWebPi({ artifactMaxPerSession: "1" });
      const tool = getRegisteredTool(pi, "webfetch");
      const old = await exec(tool, { url: `${base}/old`, format: "text" });
      const latest = await exec(tool, { url: `${base}/new`, format: "text" });
      const third = await exec(tool, { url: `${base}/newer`, format: "text" });
      expect(existsSync(old.details.artifact.path)).toBe(false);
      expect(existsSync(latest.details.artifact.path)).toBe(false);
      expect(existsSync(third.details.artifact.path)).toBe(true);
      rmSync(dirname(dirname(third.details.artifact.path)), { recursive: true, force: true });
    });
  });

  it("extracts article content over navigation in auto mode", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<body><nav><a href='/a'>Alpha</a><a href='/b'>Beta</a></nav><article><h1>Real Article</h1><p>This is the useful body text.</p></article></body>");
    }, async (base) => {
      const pi = createWebPi();
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
      const pi = createWebPi();
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
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/raw`, format: "html" });
      expect(result.content[0].text).toContain("<main><h1>Raw</h1></main>");
    });
  });

  it("enforces maxChars", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("a".repeat(5000));
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/long`, maxChars: 1200 });
      expect(result.content[0].text.length).toBeLessThanOrEqual(1200);
      expect(result.content[0].text).toContain("[Truncated:");
      expect(result.details.truncated).toBe(true);
    });
  });

  it("rejects responses larger than the configured byte limit by content-length", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.setHeader("content-length", String(2 * 1024 * 1024));
      res.end("too big");
    }, async (base) => {
      const pi = createWebPi({ maxBytes: "1MB" });
      await expect(exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/big` })).rejects.toThrow(/too large/i);
    });
  });

  it("cancels a chunked response as soon as the byte limit is exceeded", async () => {
    let sentChunks = 0;
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      const interval = setInterval(() => {
        sentChunks++;
        res.write(Buffer.alloc(64 * 1024, 97));
        if (sentChunks >= 100) {
          clearInterval(interval);
          res.end();
        }
      }, 1);
      res.on("close", () => clearInterval(interval));
    }, async (base) => {
      const pi = createWebPi({ maxBytes: "1MB" });
      await expect(exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/chunked` })).rejects.toThrow(/too large/i);
      expect(sentChunks).toBeLessThan(100);
    });
  });

  it("omits binary response bodies", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([137, 80, 78, 71]));
    }, async (base) => {
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/image.png` });
      expect(result.content[0].text).toContain("Binary body omitted");
      expect(result.content[0].text).not.toContain("base64");
    });
  });

  it("blocks private hosts when configured", async () => {
    const pi = createWebPi({ blockPrivateHosts: true });
    await expect(exec(getRegisteredTool(pi, "webfetch"), { url: "http://127.0.0.1:1" })).rejects.toThrow(/private|local/i);
  });

  it("recognizes private IPv4, IPv6, and IPv4-mapped IPv6 addresses", () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects DNS names when any resolved address is private", async () => {
    await expect(
      resolvePublicAddress("rebind.example", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ]),
    ).rejects.toThrow(/private|local/i);
  });

  it("cancels while DNS resolution is still pending", async () => {
    const controller = new AbortController();
    const pending = resolvePublicAddress("slow.example", async () => new Promise(() => undefined), controller.signal);
    controller.abort(new Error("cancelled during DNS"));
    await expect(pending).rejects.toThrow("cancelled during DNS");
  });

  it("times out", async () => {
    await withServer((_req, _res) => {
      // Leave the response open until the client timeout aborts.
    }, async (base) => {
      const pi = createWebPi();
      await expect(exec(getRegisteredTool(pi, "webfetch"), { url: `${base}/slow`, timeout: 0.1 })).rejects.toThrow();
    });
  });

  it("rewrites GitHub repo and blob URLs to raw content URLs", () => {
    expect(rewriteGitHubUrl(new URL("https://github.com/owner/repo"))?.url).toBe("https://raw.githubusercontent.com/owner/repo/HEAD/README.md");
    expect(rewriteGitHubUrl(new URL("https://github.com/owner/repo/blob/main/src/index.ts"))?.url).toBe("https://raw.githubusercontent.com/owner/repo/main/src/index.ts");
    expect(rewriteGitHubUrl(new URL("https://github.com/owner/repo/issues/1"))).toBeUndefined();
  });

  it("registers the websearch tool without exposing output mode selection", () => {
    const pi = createWebPi();
    const tool = getRegisteredTool(pi, "websearch");
    expect(tool).toBeTruthy();
    expect((tool.parameters as any).properties.mode).toBeUndefined();
  });

  it("parses plain and SSE MCP responses while rejecting tool-level errors", () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "search results" }] } });
    expect(parseMcpResponse(payload)).toBe("search results");
    expect(parseMcpResponse(`event: message\ndata: [DONE]\ndata: ${payload}\n\n`)).toBe("search results");
    expect(() => parseMcpResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "provider failed" }] } }))).toThrow(/MCP tool failed: provider failed/);
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
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "websearch"), { query: "pi coding agent", provider: "exa", contextMaxCharacters: 1200 });
      expect(result.details.provider).toBe("exa");
      expect(result.content[0].text.length).toBeLessThanOrEqual(1200);
      expect(result.content[0].text).toContain("[Truncated:");
    });
  });

  it("returns compact websearch output inline while saving the formatted artifact", async () => {
    await withServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const providerText = JSON.stringify({ search_id: "s1", results: [{ url: "https://example.com", title: "First result", publish_date: null, excerpts: ["Snippet text"] }] });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: providerText }] } }));
      });
    }, async (base) => {
      process.env.PIP_WEBSEARCH_EXA_URL = `${base}/mcp`;
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "websearch"), { query: "artifact search", provider: "exa" });
      expect(result.content[0].text).toContain("# Web search: artifact search");
      expect(result.content[0].text).toContain("## 1. First result");
      expect(result.content[0].text).toContain("Snippet text");
      expect(result.details.mode).toBe("inline+artifact");
      expect(existsSync(result.details.artifact.path)).toBe(true);
      const saved = readFileSync(result.details.artifact.path, "utf8");
      expect(saved).toContain("# Web search: artifact search");
      expect(saved).toContain("## 1. First result");
      expect(saved).toContain("Snippet text");
      expect(pi.entries.at(-1)?.customType).toBe("pip.webfetchWebsearch.artifact");
      rmSync(dirname(dirname(result.details.artifact.path)), { recursive: true, force: true });
    });
  });

  it("saves large websearch output and returns an artifact summary", async () => {
    await withServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const providerText = JSON.stringify({ search_id: "s2", results: [{ url: "https://example.com/large", title: "Large result", publish_date: null, excerpts: ["Large snippet ".repeat(900)] }] });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: providerText }] } }));
      });
    }, async (base) => {
      process.env.PIP_WEBSEARCH_EXA_URL = `${base}/mcp`;
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "websearch"), { query: "large search", provider: "exa" });
      expect(result.content[0].text).toContain("Saved websearch result");
      expect(result.content[0].text).toContain("Outline:");
      expect(result.content[0].text).toContain("Large result");
      expect(result.content[0].text).not.toContain("Large snippet Large snippet");
      expect(result.details.mode).toBe("file");
      expect(existsSync(result.details.artifact.path)).toBe(true);
      expect(readFileSync(result.details.artifact.path, "utf8")).toContain("Large snippet");
      rmSync(dirname(dirname(result.details.artifact.path)), { recursive: true, force: true });
    });
  });

  it("rejects and cancels an oversized chunked MCP response", async () => {
    let sentChunks = 0;
    await withServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const interval = setInterval(() => {
          sentChunks++;
          res.write(Buffer.alloc(32 * 1024, 97));
          if (sentChunks >= 100) {
            clearInterval(interval);
            res.end();
          }
        }, 1);
        res.on("close", () => clearInterval(interval));
      });
    }, async (base) => {
      process.env.PIP_WEBSEARCH_EXA_URL = `${base}/mcp`;
      const pi = createWebPi();
      await expect(exec(getRegisteredTool(pi, "websearch"), { query: "oversized", provider: "exa", contextMaxCharacters: 1000 })).rejects.toThrow(/too large/i);
      expect(sentChunks).toBeLessThan(100);
    });
  });

  for (const [label, parallelBody] of [
    ["malformed payload", "not json"],
    ["JSON-RPC error", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "provider failed" } })],
    ["missing text content", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "image" }] } })],
    ["tool-level MCP error", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "provider failed" }] } })],
  ] as const) {
    it(`auto websearch falls back after a ${label}`, async () => {
      await withServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const payload = JSON.parse(body);
          res.setHeader("content-type", "application/json");
          if (payload.params.name === "web_search") res.end(parallelBody);
          else res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "exa valid result" }] } }));
        });
      }, async (base) => {
        process.env.PIP_WEBSEARCH_PARALLEL_URL = `${base}/parallel`;
        process.env.PIP_WEBSEARCH_EXA_URL = `${base}/exa`;
        const pi = createWebPi();
        const result = await exec(getRegisteredTool(pi, "websearch"), { query: "fallback malformed" });
        expect(result.details.provider).toBe("exa");
        expect(result.details.fallbackUsed).toBe(true);
        expect(result.content[0].text).toBe("exa valid result");
        rmSync(dirname(dirname(result.details.artifact.path)), { recursive: true, force: true });
      });
    });
  }

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
      const pi = createWebPi();
      const result = await exec(getRegisteredTool(pi, "websearch"), { query: "fallback test" });
      expect(result.details.provider).toBe("exa");
      expect(result.details.fallbackUsed).toBe(true);
      expect(result.content[0].text).toBe("exa fallback result");
      rmSync(dirname(dirname(result.details.artifact.path)), { recursive: true, force: true });
    });
  });
});
