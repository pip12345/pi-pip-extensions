import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { firstResultText, themeBold, themeFg, truncateToWidth, wrapAnsi } from "../pip-common/index.ts";

export const CODEX_IMAGE_TOOL_NAME = "codex_generate_image";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_ROUTING_MODEL = "gpt-5.5";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_REFERENCE_IMAGES = 5;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const IMAGE_TOOL_PARAMETERS = Type.Object({
  prompt: Type.String({
    description: "A specific description of the image to generate or the changes to make to referenced images.",
  }),
  path: Type.String({
    description: "Output path, relative to the current workspace or absolute. The extension must be .png, .jpg, .jpeg, or .webp.",
  }),
  referencedImagePaths: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: MAX_REFERENCE_IMAGES,
      description: "Up to five local PNG, JPEG, or WebP images to edit, combine, or use as references.",
    }),
  ),
});

export type CodexImageToolParams = Static<typeof IMAGE_TOOL_PARAMETERS>;

interface InputImage {
  data: string;
  mimeType: string;
}

interface GeneratedImage {
  id: string;
  result: string;
  revisedPrompt?: string;
}

interface ParsedImageResponse {
  image?: GeneratedImage;
  responseId?: string;
  text: string[];
  usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function mimeTypeFromBytes(bytes: Buffer, path: string): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  throw new Error(`Referenced image is not a supported PNG, JPEG, or WebP file: ${path}`);
}

export function imageOutputFormatForPath(path: string): OutputFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg";
  if (extension === ".webp") return "webp";
  throw new Error("Image output path must end in .png, .jpg, .jpeg, or .webp.");
}

function mimeTypeForFormat(format: OutputFormat): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

export async function resolveReferenceImages(paths: readonly string[], cwd: string): Promise<InputImage[]> {
  if (paths.length > MAX_REFERENCE_IMAGES) throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images are supported.`);
  return Promise.all(
    paths.map(async (path) => {
      const absolutePath = resolve(cwd, stripAtPrefix(path));
      let bytes: Buffer;
      try {
        bytes = await readFile(absolutePath);
      } catch (error) {
        throw new Error(`Unable to read referenced image at ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { data: bytes.toString("base64"), mimeType: mimeTypeFromBytes(bytes, absolutePath) };
    }),
  );
}

export function buildCodexImageRequest(
  prompt: string,
  outputFormat: OutputFormat,
  sessionId: string,
  inputImages: readonly InputImage[],
) {
  return {
    model: DEFAULT_ROUTING_MODEL,
    store: false,
    stream: true,
    prompt_cache_key: sessionId,
    instructions: "Call the image_generation tool exactly once. Generate or edit the requested bitmap image; do not answer with text instead.",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...inputImages.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.data}`,
          })),
        ],
      },
    ],
    tools: [
      {
        type: "image_generation",
        action: inputImages.length > 0 ? "edit" : "generate",
        output_format: outputFormat,
      },
    ],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    text: { verbosity: "low" },
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("OpenAI Codex credentials are not a valid OAuth token. Run /login again.");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(parsed)) throw new Error("payload is not an object");
    return parsed;
  } catch (error) {
    throw new Error(`Unable to decode OpenAI Codex credentials: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function extractChatGptAccountId(token: string): string {
  const claims = decodeJwtPayload(token)[CHATGPT_AUTH_CLAIM];
  const accountId = isRecord(claims) ? claims.chatgpt_account_id : undefined;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("OpenAI Codex credentials do not contain a ChatGPT account ID. Run /login again.");
  }
  return accountId;
}

export function decodeGeneratedImage(value: string, outputFormat: OutputFormat): Buffer {
  const base64 = value.trim();
  if (!base64 || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Codex returned invalid base64 image data.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== base64) throw new Error("Codex returned invalid base64 image data.");
  if (mimeTypeFromBytes(bytes, "generated image") !== mimeTypeForFormat(outputFormat)) {
    throw new Error(`Codex returned image data that does not match the requested ${outputFormat} output.`);
  }
  return bytes;
}

function responseImage(item: unknown): GeneratedImage | undefined {
  if (!isRecord(item) || item.type !== "image_generation_call" || typeof item.result !== "string" || item.result.length === 0) {
    return undefined;
  }
  return {
    id: typeof item.id === "string" ? item.id : "image_generation",
    result: item.result,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
  };
}

function processResponseOutput(output: unknown, parsed: ParsedImageResponse): void {
  if (!Array.isArray(output)) return;
  for (const item of output) {
    const image = responseImage(item);
    if (image) parsed.image = image;
  }
}

function handleSseEvent(event: unknown, parsed: ParsedImageResponse): void {
  if (!isRecord(event) || typeof event.type !== "string") return;
  if (event.type === "error") {
    const message = typeof event.message === "string" ? event.message : typeof event.code === "string" ? event.code : JSON.stringify(event);
    throw new Error(`Codex image generation error: ${message}`);
  }
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    const error = response && isRecord(response.error) ? response.error : undefined;
    throw new Error(error && typeof error.message === "string" ? error.message : "Codex image generation failed.");
  }
  if (event.type === "response.created" && isRecord(event.response) && typeof event.response.id === "string") {
    parsed.responseId = event.response.id;
    return;
  }
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    parsed.text.push(event.delta);
    return;
  }
  if (event.type === "response.output_item.done") {
    const image = responseImage(event.item);
    if (image) parsed.image = image;
    return;
  }
  if (event.type === "response.completed" && isRecord(event.response)) {
    if (typeof event.response.id === "string") parsed.responseId = event.response.id;
    if (event.response.usage !== undefined) parsed.usage = event.response.usage;
    processResponseOutput(event.response.output, parsed);
  }
}

function sseData(block: string): string | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  return data && data !== "[DONE]" ? data : undefined;
}

export async function parseCodexImageResponse(response: Response, signal?: AbortSignal): Promise<ParsedImageResponse> {
  if (!response.body) throw new Error("Codex image generation response did not include a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parsed: ParsedImageResponse = { text: [] };
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Image generation was cancelled.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const data = sseData(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (data) handleSseEvent(JSON.parse(data) as unknown, parsed);
        separator = buffer.indexOf("\n\n");
      }
    }
    buffer = (buffer + decoder.decode()).replaceAll("\r\n", "\n");
    const data = sseData(buffer);
    if (data) handleSseEvent(JSON.parse(data) as unknown, parsed);
  } finally {
    reader.releaseLock();
  }

  return parsed;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), MAX_RETRY_DELAY_MS));
  }
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Image generation was cancelled."));
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => finish(new Error("Image generation was cancelled."));
    function finish(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolveDelay();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function requestCodexImage(
  body: unknown,
  token: string,
  accountId: string,
  baseUrl: string,
  providerHeaders: Record<string, string | null | undefined>,
  signal?: AbortSignal,
): Promise<ParsedImageResponse> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(providerHeaders)) {
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (signal?.aborted) throw new Error("Image generation was cancelled.");
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, "")}/codex/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error("Image generation was cancelled.");
      if (attempt > MAX_RETRIES) throw error;
      await delay(retryDelayMs(attempt, null), signal);
      continue;
    }
    if (response.ok) return parseCodexImageResponse(response, signal);

    const errorText = (await response.text()).slice(0, 4000);
    if (attempt > MAX_RETRIES || !retryableStatus(response.status)) {
      throw new Error(`Codex image generation request failed (${response.status}): ${errorText}`);
    }
    await delay(retryDelayMs(attempt, response.headers.get("retry-after")), signal);
  }
  throw new Error("Codex image generation request failed after retries.");
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId?.() ?? "pi-codex-image";
}

function imageOperation(args: Partial<CodexImageToolParams> | undefined): "edit" | "generate" {
  return Array.isArray(args?.referencedImagePaths) && args.referencedImagePaths.length > 0 ? "edit" : "generate";
}

function referenceCount(args: Partial<CodexImageToolParams> | undefined): number {
  return Array.isArray(args?.referencedImagePaths) ? args.referencedImagePaths.length : 0;
}

function renderLines(lines: (width: number) => string[]) {
  return {
    render(width: number): string[] {
      return lines(Math.max(1, width));
    },
    invalidate() {},
  };
}

function wrappedSection(theme: any, label: string, text: unknown, width: number): string[] {
  if (typeof text !== "string" || !text.trim()) return [];
  return [themeFg(theme, "dim", label), ...wrapAnsi(themeFg(theme, "toolOutput", text.trim()), width)];
}

export function renderCodexImageCall(args: Partial<CodexImageToolParams>, theme: any, context?: any) {
  return renderLines((width) => {
    const count = referenceCount(args);
    const path = typeof args.path === "string" ? stripAtPrefix(args.path) : "";
    const details = [
      imageOperation(args),
      path,
      count > 0 ? `${count} reference${count === 1 ? "" : "s"}` : undefined,
    ].filter(Boolean).join(" · ");
    const header = themeFg(theme, "toolTitle", themeBold(theme, "Codex image"))
      + (details ? themeFg(theme, "muted", `  ${details}`) : "");
    const lines = [truncateToWidth(header, width)];
    if (context?.expanded) lines.push(...wrappedSection(theme, "Prompt", args.prompt, width));
    return lines;
  });
}

export function renderCodexImageResult(result: any, options: any, theme: any, context?: any) {
  return renderLines((width) => {
    if (context?.isError) {
      const message = firstResultText(result).trim().split(/\r?\n/, 1)[0] || "Codex image generation failed.";
      return wrapAnsi(themeFg(theme, "error", `✗ ${message}`), width);
    }

    const operation = imageOperation(context?.args);
    if (options?.isPartial) {
      return [truncateToWidth(themeFg(theme, "warning", operation === "edit" ? "Editing image…" : "Generating image…"), width)];
    }

    const format = typeof result?.details?.outputFormat === "string" ? result.details.outputFormat.toUpperCase() : undefined;
    const summary = `✓ Saved${format ? ` · ${format}` : ""}`;
    const lines = [truncateToWidth(themeFg(theme, "success", summary), width)];
    if (!options?.expanded) return lines;

    const absolutePath = result?.details?.path;
    if (typeof absolutePath === "string" && absolutePath) {
      lines.push(truncateToWidth(themeFg(theme, "muted", absolutePath), width));
    }
    lines.push(...wrappedSection(theme, "Revised prompt", result?.details?.revisedPrompt, width));
    return lines;
  });
}

export function registerCodexImageGeneration(pi: ExtensionAPI): void {
  pi.registerTool({
    name: CODEX_IMAGE_TOOL_NAME,
    label: "Codex Image",
    description:
      "Generate a new raster image or edit/composite up to five local reference images with Codex image generation. Writes exactly one explicit PNG, JPEG, or WebP output path and returns an inline preview.",
    promptSnippet: "Generate or edit a raster image with Codex and write it to an explicit workspace path.",
    promptGuidelines: [
      "Use codex_generate_image when the user asks to generate a raster image or make a generative edit to existing raster images.",
      "Always choose the codex_generate_image output path deliberately; it writes to that exact path and may overwrite an existing file like write.",
    ],
    parameters: IMAGE_TOOL_PARAMETERS,
    executionMode: "parallel",
    renderCall: renderCodexImageCall,
    renderResult: renderCodexImageResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = stripAtPrefix(params.path);
      const absolutePath = resolve(ctx.cwd, requestedPath);
      const outputFormat = imageOutputFormatForPath(absolutePath);
      const inputImages = await resolveReferenceImages(params.referencedImagePaths ?? [], ctx.cwd);
      const auth = await ctx.modelRegistry.getProviderAuth(OPENAI_CODEX_PROVIDER);
      const token = auth?.auth.apiKey;
      if (!token) throw new Error(`Missing ${OPENAI_CODEX_PROVIDER} credentials. Run /login and select OpenAI Codex.`);
      const accountId = extractChatGptAccountId(token);
      const body = buildCodexImageRequest(params.prompt, outputFormat, sessionId(ctx), inputImages);
      const operation = inputImages.length > 0 ? "edit" : "generation";

      onUpdate?.({
        content: [{ type: "text", text: `Requesting Codex image ${operation} for ${requestedPath}...` }],
        details: { path: absolutePath, outputFormat, inputImageCount: inputImages.length },
      });

      const parsed = await requestCodexImage(
        body,
        token,
        accountId,
        auth.auth.baseUrl ?? DEFAULT_CODEX_BASE_URL,
        auth.auth.headers ?? {},
        signal,
      );
      if (!parsed.image) {
        const responseText = parsed.text.join("").trim();
        throw new Error(responseText ? `Codex did not return an image: ${responseText}` : "Codex did not return an image.");
      }
      const bytes = decodeGeneratedImage(parsed.image.result, outputFormat);
      await withFileMutationQueue(absolutePath, async () => {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, bytes);
      });

      const summary = parsed.image.revisedPrompt
        ? `Wrote generated image to ${absolutePath}. Revised prompt: ${parsed.image.revisedPrompt}`
        : `Wrote generated image to ${absolutePath}.`;
      return {
        content: [
          { type: "text", text: summary },
          { type: "image", data: parsed.image.result, mimeType: mimeTypeForFormat(outputFormat) },
        ],
        details: {
          path: absolutePath,
          outputFormat,
          inputImageCount: inputImages.length,
          responseId: parsed.responseId,
          imageGenerationId: parsed.image.id,
          revisedPrompt: parsed.image.revisedPrompt,
          usage: parsed.usage,
        },
      };
    },
  });
}
