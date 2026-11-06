import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, getRegisteredTool } from "../pip-common/testing.ts";
import {
  CODEX_IMAGE_TOOL_NAME,
  buildCodexImageRequest,
  decodeGeneratedImage,
  extractChatGptAccountId,
  imageOutputFormatForPath,
  parseCodexImageResponse,
  registerCodexImageGeneration,
  renderCodexImageCall,
  renderCodexImageResult,
  resolveReferenceImages,
} from "./image-gen.ts";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4V0AAAAASUVORK5CYII=", "base64");
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const webpBytes = Buffer.from("RIFF0000WEBP", "ascii");
const pngBase64 = pngBytes.toString("base64");

function codexToken(accountId = "account-123") {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `header.${payload}.signature`;
}

function imageResponse(overrides: Record<string, unknown> = {}) {
  return {
    created: 123,
    data: [{ b64_json: pngBase64, generation_id: "image-1" }],
    output_format: "png",
    quality: "low",
    size: "1x1",
    background: "opaque",
    usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 },
    ...overrides,
  };
}

function setup(cwd = tmpdir()) {
  const pi = createMockPi();
  registerCodexImageGeneration(pi as any);
  const ctx = createMockCtx({ cwd });
  ctx.modelRegistry = {
    getProviderAuth: vi.fn(async () => ({ auth: { apiKey: codexToken() }, source: "OAuth" })),
  };
  return { ctx, tool: getRegisteredTool(pi, CODEX_IMAGE_TOOL_NAME) };
}

async function withWorkspace(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-image-"));
  try { await run(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex image tool contract", () => {
  it("requires an explicit PNG path and exposes only quality and reference controls", () => {
    const { tool } = setup();
    expect(tool.parameters.required).toEqual(["prompt", "path"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["prompt", "path", "quality", "referencedImagePaths"]);
    expect(tool.parameters.properties.quality.anyOf.map((entry: any) => entry.const)).toEqual(["low", "medium", "high", "auto"]);
    expect(tool.parameters.properties.referencedImagePaths.maxItems).toBe(5);
    expect(tool.parameters.properties.path.description).toContain(".png");
    expect(tool.promptGuidelines.join(" ")).toContain("exact path");
    expect(tool.promptGuidelines.join(" ")).toContain("reference inputs");
  });

  it("accepts case-insensitive PNG extensions", () => {
    expect(imageOutputFormatForPath("asset.PNG")).toBe("png");
    expect(imageOutputFormatForPath("asset.png")).toBe("png");
  });

  it.each(["asset.jpg", "asset.jpeg", "asset.webp", "asset.gif", "asset.svg", "asset"])("rejects unsupported output paths: %s", path => {
    expect(() => imageOutputFormatForPath(path)).toThrow("must end in .png");
  });
});

describe("native Codex image requests", () => {
  it("builds a standalone generation request without chat routing or an injected quality default", () => {
    expect(buildCodexImageRequest("draw a cat", [])).toEqual({
      model: "gpt-image-2", prompt: "draw a cat", output_format: "png", n: 1,
    });
  });

  it.each(["low", "medium", "high", "auto"] as const)("forwards explicit %s quality", quality => {
    expect(buildCodexImageRequest("draw", [], quality).quality).toBe(quality);
  });

  it("puts all reference images in the native Images edit payload", () => {
    expect(buildCodexImageRequest("add a scarf", [
      { mimeType: "image/png", data: pngBase64 },
      { mimeType: "image/jpeg", data: jpegBytes.toString("base64") },
      { mimeType: "image/webp", data: webpBytes.toString("base64") },
    ], "high")).toEqual({
      model: "gpt-image-2", prompt: "add a scarf", output_format: "png", n: 1, quality: "high",
      images: [
        { image_url: `data:image/png;base64,${pngBase64}` },
        { image_url: `data:image/jpeg;base64,${jpegBytes.toString("base64")}` },
        { image_url: `data:image/webp;base64,${webpBytes.toString("base64")}` },
      ],
    });
  });

  it("extracts the account ID without substituting other credentials", () => {
    expect(extractChatGptAccountId(codexToken())).toBe("account-123");
    expect(() => extractChatGptAccountId("not-a-token")).toThrow("valid OAuth token");
    expect(() => extractChatGptAccountId(codexToken(""))).toThrow("account ID");
  });
});

describe("native Codex image response parsing", () => {
  it("reads base64, generation ID, revised prompt, and server metadata from JSON", async () => {
    const parsed = await parseCodexImageResponse(Response.json(imageResponse({
      data: [{ b64_json: ` ${pngBase64}\n`, generation_id: "native-id", revised_prompt: "Revised" }],
    })));
    expect(parsed).toEqual({
      image: { id: "native-id", result: pngBase64, revisedPrompt: "Revised" },
      quality: "low", size: "1x1", background: "opaque",
      usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 },
    });
  });

  it("does not invent missing IDs or metadata", async () => {
    const parsed = await parseCodexImageResponse(Response.json({ data: [{ b64_json: pngBase64 }] }));
    expect(parsed.image.result).toBe(pngBase64);
    expect(parsed.image.id).toBeUndefined();
    expect(parsed.quality).toBeUndefined();
    expect(parsed.size).toBeUndefined();
    expect(parsed.usage).toBeUndefined();
  });

  it.each([
    { body: null, message: "invalid image response" },
    { body: [], message: "invalid image response" },
    { body: {}, message: "did not return an image" },
    { body: { data: [] }, message: "did not return an image" },
    { body: { data: [null] }, message: "base64 image data" },
    { body: { data: [{ url: "https://example.com/image.png" }] }, message: "base64 image data" },
    { body: { data: [{ b64_json: "  " }] }, message: "base64 image data" },
    { body: { data: [{ b64_json: pngBase64 }, { b64_json: pngBase64 }] }, message: "multiple images" },
    { body: imageResponse({ output_format: "jpeg" }), message: "other than PNG" },
  ])("rejects invalid or unsupported response bodies: $message", async ({ body, message }) => {
    await expect(parseCodexImageResponse(Response.json(body))).rejects.toThrow(message);
  });

  it.each([
    { error: { message: "Image allowance exceeded" } },
    { error: "Image allowance exceeded" },
    { detail: "Image allowance exceeded" },
  ])("rejects HTTP-200 error bodies instead of treating them as success", async body => {
    await expect(parseCodexImageResponse(Response.json(body))).rejects.toThrow("Image allowance exceeded");
  });

  it("does not accept the retired SSE response shape", async () => {
    await expect(parseCodexImageResponse(new Response('data: {"type":"response.completed"}\n\n'))).rejects.toThrow("JSON body");
  });
});

describe("Codex image files", () => {
  it("loads PNG, JPEG, and WebP references by signature and normalizes @ paths", async () => {
    await withWorkspace(async cwd => {
      await writeFile(join(cwd, "one.png"), pngBytes);
      await writeFile(join(cwd, "two.jpg"), jpegBytes);
      await writeFile(join(cwd, "three.webp"), webpBytes);
      expect(await resolveReferenceImages(["@one.png", "two.jpg", "three.webp"], cwd)).toEqual([
        { mimeType: "image/png", data: pngBase64 },
        { mimeType: "image/jpeg", data: jpegBytes.toString("base64") },
        { mimeType: "image/webp", data: webpBytes.toString("base64") },
      ]);
      expect(await resolveReferenceImages(Array(5).fill("one.png"), cwd)).toHaveLength(5);
      await expect(resolveReferenceImages(Array(6).fill("one.png"), cwd)).rejects.toThrow("At most 5");
    });
  });

  it("rejects missing and unsupported reference files", async () => {
    await withWorkspace(async cwd => {
      await writeFile(join(cwd, "bad.png"), "not an image");
      await expect(resolveReferenceImages(["missing.png"], cwd)).rejects.toThrow("Unable to read referenced image");
      await expect(resolveReferenceImages(["bad.png"], cwd)).rejects.toThrow("not a supported PNG, JPEG, or WebP");
    });
  });

  it("validates PNG bytes and obtains actual dimensions from IHDR", () => {
    expect(decodeGeneratedImage(pngBase64)).toEqual({ bytes: pngBytes, width: 1, height: 1 });
    expect(() => decodeGeneratedImage(jpegBytes.toString("base64"))).toThrow("requested PNG");
    expect(() => decodeGeneratedImage(webpBytes.toString("base64"))).toThrow("requested PNG");
  });

  it("validates large image payloads without overflowing the stack", () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    pngBytes.copy(bytes);
    expect(decodeGeneratedImage(bytes.toString("base64")).bytes.equals(bytes)).toBe(true);
  });

  it.each(["", "====", "iVBORw0KGgo", "iVBORw0KGgo===", "iVBORw0KGg==AAAA", "iVBORw0KGgo_", "iVBORw0K Ggo", "iVBORw0KGgp="])("rejects malformed or noncanonical base64: %j", base64 => {
    expect(() => decodeGeneratedImage(base64)).toThrow("invalid base64");
  });

  it("rejects truncated or invalid PNG headers", () => {
    expect(() => decodeGeneratedImage(pngBytes.subarray(0, 8).toString("base64"))).toThrow("invalid PNG header");
    const invalid = Buffer.from(pngBytes);
    invalid.write("IDAT", 12, "ascii");
    expect(() => decodeGeneratedImage(invalid.toString("base64"))).toThrow("invalid PNG header");
  });

  it.each([0, 0x80000000])("rejects invalid PNG dimensions: %s", dimension => {
    const invalid = Buffer.from(pngBytes);
    invalid.writeUInt32BE(dimension, 16);
    expect(() => decodeGeneratedImage(invalid.toString("base64"))).toThrow("invalid PNG dimensions");
  });
});

describe("Codex image rendering", () => {
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const args = { prompt: "Refine the poster while preserving the original typography and composition.", path: "assets/output.png", quality: "high" as const, referencedImagePaths: ["assets/source.png"] };

  it("shows requested quality compactly and wraps the expanded prompt", () => {
    const collapsed = renderCodexImageCall(args, theme).render(100).join("\n");
    expect(collapsed).toContain("edit · assets/output.png · 1 reference · high quality");
    expect(collapsed).not.toContain("Refine");
    const expanded = renderCodexImageCall(args, theme, { expanded: true }).render(30);
    expect(expanded.join("\n")).toContain("Prompt");
    expect(expanded.every(line => line.length <= 30)).toBe(true);
  });

  it("reports actual dimensions and returned quality, with usage in expanded output", () => {
    const result = { details: { path: "/workspace/assets/output.png", outputFormat: "png", width: 1254, height: 1254, requestedQuality: "high", quality: "low", revisedPrompt: "A revised poster prompt.", usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 } } };
    const collapsed = renderCodexImageResult(result, {}, theme, { args }).render(80).join("\n");
    expect(collapsed).toBe("✓ Saved · PNG · 1254×1254 · low quality");
    const lines = renderCodexImageResult(result, { expanded: true }, theme, { args }).render(30);
    const expanded = lines.join("\n");
    expect(expanded).toContain("Requested quality\nhigh");
    expect(expanded).toContain("Usage (tokens)");
    expect(expanded.replace(/\s+/g, " ")).toContain("12 input · 20 output · 32 total");
    expect(expanded).toContain("Revised prompt");
    expect(lines.every(line => line.length <= 30)).toBe(true);
  });

  it("does not present requested quality or absent usage as a returned value", () => {
    const result = { details: { outputFormat: "png", requestedQuality: "high" } };
    expect(renderCodexImageResult(result, {}, theme).render(80).join("\n")).toBe("✓ Saved · PNG");
    const expanded = renderCodexImageResult(result, { expanded: true }, theme).render(80).join("\n");
    expect(expanded).toContain("Requested quality\nhigh");
    expect(expanded).not.toContain("Usage");
  });

  it("renders progress and only the first error line", () => {
    expect(renderCodexImageResult({}, { isPartial: true }, theme, { args }).render(80)).toEqual(["Editing image…"]);
    expect(renderCodexImageResult({}, { isPartial: true }, theme).render(80)).toEqual(["Generating image…"]);
    expect(renderCodexImageResult({ content: [{ type: "text", text: "Codex request failed\nprovider details" }] }, {}, theme, { isError: true }).render(80)).toEqual(["✗ Codex request failed"]);
  });
});

describe("native Codex image execution", () => {
  it("uses only the native generation endpoint, writes exactly the requested path, and reports metadata", async () => {
    await withWorkspace(async cwd => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json(imageResponse({ size: "1024x1024" }), { headers: { "x-codex-imagegen-request-id": "request-1" } }));
      vi.stubGlobal("fetch", fetchMock);
      const { ctx, tool } = setup(cwd);
      ctx.modelRegistry.getProviderAuth = vi.fn(async () => ({ auth: { apiKey: codexToken(), baseUrl: "https://chatgpt.example/backend-api/", headers: { "x-provider-header": "present" } }, source: "OAuth" }));
      const updates: any[] = [];
      const result = await tool.execute("call", { prompt: "draw", path: "@assets/out.png", quality: "high" }, undefined, (update: any) => updates.push(update), ctx);

      expect(ctx.modelRegistry.getProviderAuth).toHaveBeenCalledWith("openai-codex");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://chatgpt.example/backend-api/codex/images/generations");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${codexToken()}`);
      expect(headers.get("chatgpt-account-id")).toBe("account-123");
      expect(headers.get("x-provider-header")).toBe("present");
      expect(headers.get("originator")).toBe("pi");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("openai-beta")).toBeNull();
      expect(headers.get("x-codex-image-turn-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(init.body)).toEqual({ model: "gpt-image-2", prompt: "draw", output_format: "png", n: 1, quality: "high" });
      expect(await readFile(join(cwd, "assets/out.png"))).toEqual(pngBytes);
      expect(result.content[0].text).toContain("1×1, low quality");
      expect(result.content[1]).toEqual({ type: "image", data: pngBase64, mimeType: "image/png" });
      expect(result.details).toMatchObject({ path: join(cwd, "assets/out.png"), outputFormat: "png", width: 1, height: 1, requestedQuality: "high", quality: "low", size: "1024x1024", background: "opaque", requestId: "request-1", imageGenerationId: "image-1", usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 } });
      expect(result.details).not.toHaveProperty("routingModel");
      expect(updates[0].details.requestedQuality).toBe("high");
    });
  });

  it("uses the native edit endpoint with mixed reference formats", async () => {
    await withWorkspace(async cwd => {
      await writeFile(join(cwd, "one.png"), pngBytes);
      await writeFile(join(cwd, "two.jpeg"), jpegBytes);
      await writeFile(join(cwd, "three.webp"), webpBytes);
      const fetchMock = vi.fn().mockResolvedValue(Response.json(imageResponse()));
      vi.stubGlobal("fetch", fetchMock);
      const { ctx, tool } = setup(cwd);
      const result = await tool.execute("edit", { prompt: "change the color", path: "out.png", quality: "medium", referencedImagePaths: ["@one.png", "two.jpeg", "three.webp"] }, undefined, undefined, ctx);
      expect(fetchMock.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/images/edits");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(buildCodexImageRequest("change the color", await resolveReferenceImages(["one.png", "two.jpeg", "three.webp"], cwd), "medium"));
      expect(result.details.inputImageCount).toBe(3);
      expect(await readFile(join(cwd, "out.png"))).toEqual(pngBytes);
    });
  });

  it("overwrites a successful absolute output path without touching other files", async () => {
    await withWorkspace(async cwd => {
      const output = join(cwd, "out.png");
      const untouched = join(cwd, "other.png");
      await writeFile(output, "old image");
      await writeFile(untouched, "unrelated image");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(imageResponse())));
      const { ctx, tool } = setup(cwd);
      await tool.execute("call", { prompt: "draw", path: output }, undefined, undefined, ctx);
      expect(await readFile(output)).toEqual(pngBytes);
      expect(await readFile(untouched, "utf8")).toBe("unrelated image");
    });
  });

  it("uses generation for an empty reference list and leaves missing quality metadata unknown", async () => {
    await withWorkspace(async cwd => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ b64_json: pngBase64 }] }));
      vi.stubGlobal("fetch", fetchMock);
      const { ctx, tool } = setup(cwd);
      const result = await tool.execute("call", { prompt: "draw", path: "out.png", referencedImagePaths: [] }, undefined, undefined, ctx);
      expect(fetchMock.mock.calls[0][0]).toContain("/images/generations");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("quality");
      expect(result.details.quality).toBeUndefined();
      expect(result.details.imageGenerationId).toBeUndefined();
    });
  });

  it.each(["jpg", "jpeg", "webp", "gif"])("rejects %s output before auth or HTTP", async extension => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, tool } = setup();
    await expect(tool.execute("call", { prompt: "draw", path: `out.${extension}` }, undefined, undefined, ctx)).rejects.toThrow("must end in .png");
    expect(ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries transient errors on the same native request without changing routes or turn ID", async () => {
    await withWorkspace(async cwd => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503, headers: { "retry-after": "0" } }))
        .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
        .mockResolvedValueOnce(Response.json(imageResponse()));
      vi.stubGlobal("fetch", fetchMock);
      const { ctx, tool } = setup(cwd);
      await tool.execute("call", { prompt: "draw", path: "out.png" }, undefined, undefined, ctx);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(new Set(fetchMock.mock.calls.map(call => call[0])).size).toBe(1);
      expect(new Set(fetchMock.mock.calls.map(call => new Headers(call[1].headers).get("x-codex-image-turn-id"))).size).toBe(1);
      expect(fetchMock.mock.calls.every(call => call[1].method === "POST")).toBe(true);
    });
  });

  it("bounds transient retries without falling back to another transport", async () => {
    await withWorkspace(async cwd => {
      const fetchMock = vi.fn(async (_url: string) => new Response("unavailable", { status: 503, headers: { "retry-after": "0" } }));
      vi.stubGlobal("fetch", fetchMock);
      const { ctx, tool } = setup(cwd);
      await expect(tool.execute("call", { prompt: "draw", path: "out.png" }, undefined, undefined, ctx)).rejects.toThrow("request failed (503)");
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(new Set(fetchMock.mock.calls.map(call => call[0])).size).toBe(1);
      await expect(readFile(join(cwd, "out.png"))).rejects.toThrow();
    });
  });

  it.each([
    { body: "unauthorized", status: 401, error: "request failed (401)" },
    { body: "invalid quality", status: 400, error: "request failed (400)" },
    { body: "missing endpoint", status: 404, error: "request failed (404)" },
    { body: "not JSON", status: 200, error: "JSON body" },
    { body: JSON.stringify({ error: { message: "Rejected image request" } }), status: 200, error: "Rejected image request" },
    { body: JSON.stringify({ data: [] }), status: 200, error: "did not return an image" },
    { body: JSON.stringify(imageResponse({ data: [{ b64_json: "not base64" }] })), status: 200, error: "invalid base64" },
    { body: JSON.stringify(imageResponse({ data: [{ b64_json: jpegBytes.toString("base64") }] })), status: 200, error: "requested PNG" },
    { body: JSON.stringify(imageResponse({ output_format: "webp" })), status: 200, error: "other than PNG" },
  ])("preserves existing files and does not fall back after failure: $error", async ({ body, status, error }) => {
    await withWorkspace(async cwd => {
      const output = join(cwd, "out.png");
      await writeFile(output, "existing image");
      const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const { ctx, tool } = setup(cwd);
      await expect(tool.execute("call", { prompt: "draw", path: "out.png" }, undefined, undefined, ctx)).rejects.toThrow(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await readFile(output, "utf8")).toBe("existing image");
    });
  });

  it("honors cancellation before auth or network activity", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, tool } = setup();
    await expect(tool.execute("call", { prompt: "draw", path: "out.png" }, controller.signal, undefined, ctx)).rejects.toThrow("cancelled");
    expect(ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a cancelled network request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => { controller.abort(); throw new Error("aborted fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, tool } = setup();
    await expect(tool.execute("call", { prompt: "draw", path: "out.png" }, controller.signal, undefined, ctx)).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports cancellation while reading an HTTP error body", async () => {
    const controller = new AbortController();
    const response = new Response("unavailable", { status: 503 });
    response.text = async () => { controller.abort(); throw new Error("body aborted"); };
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, tool } = setup();
    await expect(tool.execute("call", { prompt: "draw", path: "out.png" }, controller.signal, undefined, ctx)).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves output when cancelled during response parsing", async () => {
    await withWorkspace(async cwd => {
      await writeFile(join(cwd, "out.png"), "existing image");
      const controller = new AbortController();
      const response = Response.json(imageResponse());
      response.json = async () => { controller.abort(); return imageResponse(); };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const { ctx, tool } = setup(cwd);
      await expect(tool.execute("call", { prompt: "draw", path: "out.png" }, controller.signal, undefined, ctx)).rejects.toThrow("cancelled");
      expect(await readFile(join(cwd, "out.png"), "utf8")).toBe("existing image");
    });
  });

  it("fails before requesting when Codex credentials are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, tool } = setup();
    ctx.modelRegistry.getProviderAuth = async () => undefined;
    await expect(tool.execute("call", { prompt: "draw", path: "out.png" }, undefined, undefined, ctx)).rejects.toThrow("Missing openai-codex credentials");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
