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
  registerCodexImageGeneration,
  renderCodexImageCall,
  renderCodexImageResult,
  resolveReferenceImages,
} from "./image-gen.ts";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const webpBytes = Buffer.from("RIFF0000WEBP", "ascii");

function codexToken(accountId = "account-123") {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function imageSse(imageBase64: string, revisedPrompt = "A revised image prompt") {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "response-1" } })}`,
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "image-1",
        status: "completed",
        result: imageBase64,
        revised_prompt: revisedPrompt,
      },
    })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "response-1", usage: { input_tokens: 12 } } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex image tool contract", () => {
  it("requires an explicit output path and does not expose save modes", () => {
    const pi = createMockPi();
    registerCodexImageGeneration(pi as any);

    const tool = getRegisteredTool(pi, CODEX_IMAGE_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool.parameters.required).toEqual(["prompt", "path"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["prompt", "path", "referencedImagePaths"]);
    expect(tool.promptGuidelines.join(" ")).toContain("exact path");
  });

  it("infers the requested output format from the path", () => {
    expect(imageOutputFormatForPath("asset.PNG")).toBe("png");
    expect(imageOutputFormatForPath("asset.jpg")).toBe("jpeg");
    expect(imageOutputFormatForPath("asset.jpeg")).toBe("jpeg");
    expect(imageOutputFormatForPath("asset.webp")).toBe("webp");
    expect(() => imageOutputFormatForPath("asset.gif")).toThrow("must end in");
  });
});

describe("Codex image request", () => {
  it("forces generation without references and editing with references", () => {
    const generation = buildCodexImageRequest("draw a cat", "png", "session-1", []);
    expect(generation).toMatchObject({
      model: "gpt-5.5",
      store: false,
      stream: true,
      prompt_cache_key: "session-1",
      tool_choice: { type: "image_generation" },
      tools: [{ type: "image_generation", action: "generate", output_format: "png" }],
    });

    const edit = buildCodexImageRequest("add a scarf", "webp", "session-1", [
      { mimeType: "image/png", data: pngBytes.toString("base64") },
    ]);
    expect(edit.tools).toEqual([{ type: "image_generation", action: "edit", output_format: "webp" }]);
    expect(edit.input[0].content[1]).toEqual({
      type: "input_image",
      image_url: `data:image/png;base64,${pngBytes.toString("base64")}`,
    });
  });

  it("extracts the ChatGPT account ID from Codex OAuth credentials", () => {
    expect(extractChatGptAccountId(codexToken())).toBe("account-123");
    expect(() => extractChatGptAccountId("not-a-token")).toThrow("valid OAuth token");
  });
});

describe("Codex image files", () => {
  it("loads supported local reference images and normalizes @ paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-codex-image-refs-"));
    try {
      await writeFile(join(cwd, "one.png"), pngBytes);
      await writeFile(join(cwd, "two.jpg"), jpegBytes);
      const images = await resolveReferenceImages(["@one.png", "two.jpg"], cwd);
      expect(images).toEqual([
        { mimeType: "image/png", data: pngBytes.toString("base64") },
        { mimeType: "image/jpeg", data: jpegBytes.toString("base64") },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("strictly validates returned base64 and image signatures", () => {
    expect(decodeGeneratedImage(pngBytes.toString("base64"), "png")).toEqual(pngBytes);
    expect(decodeGeneratedImage(jpegBytes.toString("base64"), "jpeg")).toEqual(jpegBytes);
    expect(decodeGeneratedImage(webpBytes.toString("base64"), "webp")).toEqual(webpBytes);
    expect(() => decodeGeneratedImage("not base64", "png")).toThrow("invalid base64");
    expect(() => decodeGeneratedImage(jpegBytes.toString("base64"), "png")).toThrow("does not match");
  });
});

describe("Codex image rendering", () => {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const args = {
    prompt: "Refine the poster with a small controlled incision and crisp stylized droplets while preserving the typography.",
    path: "assets/blue-ball-day-professional-v2.png",
    referencedImagePaths: ["assets/blue-ball-day-professional.png"],
  };

  it("keeps the collapsed call compact and shows the original prompt when expanded", () => {
    const collapsed = renderCodexImageCall(args, theme, { expanded: false }).render(80).join("\n");
    expect(collapsed).toContain("Codex image  edit · assets/blue-ball-day-professional-v2.png · 1 reference");
    expect(collapsed).not.toContain("Refine the poster");

    const expandedLines = renderCodexImageCall(args, theme, { expanded: true }).render(36);
    const expanded = expandedLines.join("\n");
    expect(expanded).toContain("Prompt");
    expect(expanded).toContain("Refine the poster");
    expect(expandedLines.every((line) => line.length <= 36)).toBe(true);
  });

  it("renders concise progress and success while reserving the revised prompt for expanded output", () => {
    const partial = renderCodexImageResult(
      { content: [{ type: "text", text: "Requesting Codex image edit for assets/output.png..." }] },
      { expanded: false, isPartial: true },
      theme,
      { args },
    ).render(80).join("\n");
    expect(partial).toBe("Editing image…");
    expect(partial).not.toContain("Requesting Codex");

    const result = {
      content: [{ type: "text", text: "Wrote generated image with a long revised prompt" }],
      details: {
        path: "/workspace/assets/blue-ball-day-professional-v2.png",
        outputFormat: "png",
        revisedPrompt: "A revised poster prompt with restrained graphic blood and exact readable typography.",
      },
    };
    const collapsed = renderCodexImageResult(result, { expanded: false, isPartial: false }, theme, { args }).render(80).join("\n");
    expect(collapsed).toBe("✓ Saved · PNG");
    expect(collapsed).not.toContain("Revised prompt");

    const expandedLines = renderCodexImageResult(result, { expanded: true, isPartial: false }, theme, { args }).render(40);
    const expanded = expandedLines.join("\n");
    expect(expanded).toContain("/workspace/assets/blue-ball-day-profess");
    expect(expanded).toContain("Revised prompt");
    expect(expanded.replace(/\s+/g, " ")).toContain("restrained graphic blood");
    expect(expandedLines.every((line) => line.length <= 40)).toBe(true);
  });

  it("shows only the first error line", () => {
    const rendered = renderCodexImageResult(
      { content: [{ type: "text", text: "Codex request failed\nprovider details" }] },
      { expanded: true, isPartial: false },
      theme,
      { args, isError: true },
    ).render(80).join("\n");
    expect(rendered).toBe("✗ Codex request failed");
  });
});

describe("Codex image generation execution", () => {
  it("uses Codex OAuth, writes only the requested path, and returns an inline preview", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-codex-image-output-"));
    try {
      let requestUrl: string | URL | Request | undefined;
      let requestInit: RequestInit | undefined;
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requestUrl = url;
        requestInit = init;
        return new Response(imageSse(pngBytes.toString("base64")), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }));

      const pi = createMockPi();
      registerCodexImageGeneration(pi as any);
      const tool = getRegisteredTool(pi, CODEX_IMAGE_TOOL_NAME);
      const ctx = createMockCtx({ cwd });
      ctx.sessionManager = { ...ctx.sessionManager, getSessionId: () => "session-123" };
      ctx.modelRegistry = {
        getProviderAuth: async () => ({
          auth: {
            apiKey: codexToken(),
            baseUrl: "https://chatgpt.example/backend-api/",
            headers: { "x-provider-header": "present" },
          },
          source: "OAuth",
        }),
      };

      const updates: any[] = [];
      const result = await tool.execute(
        "tool-call-1",
        { prompt: "draw a cat", path: "assets/cat.png" },
        undefined,
        (update: any) => updates.push(update),
        ctx,
      );

      expect(requestUrl).toBe("https://chatgpt.example/backend-api/codex/responses");
      const headers = new Headers(requestInit?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${codexToken()}`);
      expect(headers.get("chatgpt-account-id")).toBe("account-123");
      expect(headers.get("x-provider-header")).toBe("present");
      expect(JSON.parse(String(requestInit?.body))).toMatchObject({
        model: "gpt-5.5",
        prompt_cache_key: "session-123",
        tools: [{ type: "image_generation", action: "generate", output_format: "png" }],
      });

      expect(await readFile(join(cwd, "assets", "cat.png"))).toEqual(pngBytes);
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining(`Wrote generated image to ${join(cwd, "assets", "cat.png")}`) },
        { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
      ]);
      expect(result.details).toMatchObject({
        path: join(cwd, "assets", "cat.png"),
        outputFormat: "png",
        revisedPrompt: "A revised image prompt",
        responseId: "response-1",
      });
      expect(updates[0].content[0].text).toContain("assets/cat.png");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails before requesting when Codex credentials are missing", async () => {
    const pi = createMockPi();
    registerCodexImageGeneration(pi as any);
    const tool = getRegisteredTool(pi, CODEX_IMAGE_TOOL_NAME);
    const ctx = createMockCtx();
    ctx.modelRegistry = { getProviderAuth: async () => undefined };

    await expect(tool.execute("tool-call-1", { prompt: "draw", path: "out.png" }, undefined, undefined, ctx)).rejects.toThrow(
      "Missing openai-codex credentials",
    );
  });
});
