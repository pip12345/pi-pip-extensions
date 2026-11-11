import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { firstResultText, themeBold, themeFg, truncateToWidth, wrapAnsi } from "../pip-common/index.ts";

export const CODEX_IMAGE_TOOL_NAME = "codex_generate_image";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
// This is the native Codex client's image alias, not a guarantee of the serving model's version.
const CODEX_IMAGE_MODEL = "gpt-image-2";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_REFERENCE_IMAGES = 5;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const IMAGE_TOOL_PARAMETERS = Type.Object({
  prompt: Type.String({
    description: "A specific description of the image to generate or the changes to make to referenced images.",
  }),
  path: Type.String({
    description: "PNG output path, relative to the current workspace or absolute. The extension must be .png.",
  }),
  quality: Type.Optional(Type.Union([
    Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto"),
  ], { description: "Requested rendering quality. The backend may override it; results report returned quality separately. Omit to leave the backend default unchanged. This is not an image-model or complexity selector." })),
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

interface ParsedImageResponse {
  image: { id?: string; result: string; revisedPrompt?: string };
  quality?: string;
  size?: string;
  background?: string;
  usage?: unknown;
}

interface DecodedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function mimeTypeFromBytes(bytes: Buffer, path: string): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  throw new Error(`Referenced image is not a supported PNG, JPEG, or WebP file: ${path}`);
}

export function imageOutputFormatForPath(path: string): "png" {
  if (extname(path).toLowerCase() === ".png") return "png";
  throw new Error("Image output path must end in .png. Native Codex image generation only supports PNG output.");
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
  inputImages: readonly InputImage[],
  quality?: CodexImageToolParams["quality"],
) {
  return {
    model: CODEX_IMAGE_MODEL,
    prompt,
    output_format: "png",
    n: 1,
    ...(quality === undefined ? {} : { quality }),
    ...(inputImages.length === 0 ? {} : {
      images: inputImages.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
    }),
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

export function decodeGeneratedImage(value: string): DecodedImage {
  const base64 = value.trim();
  if (!base64 || base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) {
    throw new Error("Codex returned invalid base64 image data.");
  }
  const bytes = Buffer.from(base64, "base64");
  // Require canonical base64 because Node's decoder accepts malformed padding and discarded characters.
  if (bytes.length === 0 || bytes.toString("base64") !== base64) throw new Error("Codex returned invalid base64 image data.");
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Codex returned image data that does not match the requested PNG output.");
  }
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Codex returned an invalid PNG header.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new Error("Codex returned invalid PNG dimensions.");
  }
  return { bytes, width, height };
}

export async function parseCodexImageResponse(response: Response, signal?: AbortSignal): Promise<ParsedImageResponse> {
  if (signal?.aborted) throw new Error("Image generation was cancelled.");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (signal?.aborted) throw new Error("Image generation was cancelled.");
    throw new Error("Codex returned an invalid image response JSON body.");
  }
  if (signal?.aborted) throw new Error("Image generation was cancelled.");
  if (!isRecord(value)) throw new Error("Codex returned an invalid image response.");
  const error = value.error ?? value.detail;
  if (error !== undefined && error !== null) {
    const message = isRecord(error) && typeof error.message === "string" ? error.message
      : typeof error === "string" ? error : JSON.stringify(error);
    throw new Error(`Codex image generation failed: ${message}`);
  }
  if (!Array.isArray(value.data) || value.data.length === 0) throw new Error("Codex did not return an image.");
  if (value.data.length !== 1) throw new Error("Codex returned multiple images; expected exactly one.");
  const item = value.data[0];
  if (!isRecord(item) || typeof item.b64_json !== "string" || !item.b64_json.trim()) {
    throw new Error("Codex did not return base64 image data.");
  }
  if (value.output_format != null && value.output_format !== "png") {
    throw new Error("Codex reported an output format other than PNG.");
  }
  return {
    image: {
      id: typeof item.generation_id === "string" ? item.generation_id : undefined,
      result: item.b64_json.trim(),
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
    },
    quality: typeof value.quality === "string" ? value.quality : undefined,
    size: typeof value.size === "string" ? value.size : undefined,
    background: typeof value.background === "string" ? value.background : undefined,
    usage: value.usage,
  };
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

function codexRequestHeaders(
  token: string,
  accountId: string,
  providerHeaders: Record<string, string | null | undefined>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(providerHeaders)) {
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("x-codex-image-turn-id", randomUUID());
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

async function requestCodex(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (signal?.aborted) throw new Error("Image generation was cancelled.");
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      if (signal?.aborted) throw new Error("Image generation was cancelled.");
      if (attempt > MAX_RETRIES) throw error;
      await delay(retryDelayMs(attempt, null), signal);
      continue;
    }
    if (response.ok) return response;

    let errorText: string;
    try {
      errorText = (await response.text()).slice(0, 4000);
    } catch (error) {
      if (signal?.aborted) throw new Error("Image generation was cancelled.");
      throw error;
    }
    if (signal?.aborted) throw new Error("Image generation was cancelled.");
    if (attempt > MAX_RETRIES || !retryableStatus(response.status)) {
      throw new Error(`Codex image generation request failed (${response.status}): ${errorText}`);
    }
    await delay(retryDelayMs(attempt, response.headers.get("retry-after")), signal);
  }
  throw new Error("Codex image generation request failed after retries.");
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
      args.quality ? `${args.quality} quality` : undefined,
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
    if (options?.isPartial) {
      const editing = imageOperation(context?.args) === "edit";
      return [truncateToWidth(themeFg(theme, "warning", editing ? "Editing image…" : "Generating image…"), width)];
    }
    const format = typeof result?.details?.outputFormat === "string" ? result.details.outputFormat.toUpperCase() : undefined;
    const dimensions = typeof result?.details?.width === "number" && typeof result?.details?.height === "number"
      ? `${result.details.width}×${result.details.height}` : undefined;
    const quality = typeof result?.details?.quality === "string" ? `${result.details.quality} quality` : undefined;
    const summary = ["✓ Saved", format, dimensions, quality].filter(Boolean).join(" · ");
    const lines = [truncateToWidth(themeFg(theme, "success", summary), width)];
    if (!options?.expanded) return lines;

    const absolutePath = result?.details?.path;
    if (typeof absolutePath === "string" && absolutePath) {
      lines.push(truncateToWidth(themeFg(theme, "muted", absolutePath), width));
    }
    const requestedQuality = result?.details?.requestedQuality;
    if (typeof requestedQuality === "string" && requestedQuality !== result?.details?.quality) {
      lines.push(...wrappedSection(theme, "Requested quality", requestedQuality, width));
    }
    const usage = result?.details?.usage;
    if (isRecord(usage)) {
      const counts = [["input_tokens", "input"], ["output_tokens", "output"], ["total_tokens", "total"]]
        .filter(([key]) => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
        .map(([key, label]) => `${usage[key]} ${label}`);
      if (counts.length) lines.push(...wrappedSection(theme, "Usage (tokens)", counts.join(" · "), width));
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
      "Generate a new PNG image or edit/composite up to five local PNG, JPEG, or WebP reference images with native Codex image generation. Writes exactly one explicit .png output path and returns an inline preview, actual dimensions, reported quality, and usage.",
    promptSnippet: "Generate or edit a PNG image with Codex and write it to an explicit workspace path.",
    promptGuidelines: [
      "Use codex_generate_image when the user asks to generate a raster image or make a generative edit to existing raster images.",
      "Always choose the codex_generate_image output path deliberately; it writes to that exact path and may overwrite an existing file like write.",
      "Choose a .png output path. JPEG and WebP are supported only as reference inputs.",
    ],
    parameters: IMAGE_TOOL_PARAMETERS,
    executionMode: "parallel",
    renderCall: renderCodexImageCall,
    renderResult: renderCodexImageResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Image generation was cancelled.");
      const requestedPath = stripAtPrefix(params.path);
      const absolutePath = resolve(ctx.cwd, requestedPath);
      const outputFormat = imageOutputFormatForPath(absolutePath);
      const inputImages = await resolveReferenceImages(params.referencedImagePaths ?? [], ctx.cwd);
      const auth = await ctx.modelRegistry.getProviderAuth(OPENAI_CODEX_PROVIDER);
      const token = auth?.auth.apiKey;
      if (!token) throw new Error(`Missing ${OPENAI_CODEX_PROVIDER} credentials. Run /login and select OpenAI Codex.`);
      const accountId = extractChatGptAccountId(token);
      const baseUrl = (auth.auth.baseUrl ?? DEFAULT_CODEX_BASE_URL).replace(/\/$/, "");
      const headers = codexRequestHeaders(token, accountId, auth.auth.headers ?? {});
      const editing = inputImages.length > 0;
      onUpdate?.({
        content: [{ type: "text", text: `Requesting Codex image ${editing ? "edit" : "generation"} for ${requestedPath}...` }],
        details: { path: absolutePath, outputFormat, inputImageCount: inputImages.length, requestedQuality: params.quality },
      });
      const response = await requestCodex(
        `${baseUrl}/codex/images/${editing ? "edits" : "generations"}`,
        { method: "POST", headers, body: JSON.stringify(buildCodexImageRequest(params.prompt, inputImages, params.quality)) },
        signal,
      );
      const parsed = await parseCodexImageResponse(response, signal);
      const image = decodeGeneratedImage(parsed.image.result);
      await withFileMutationQueue(absolutePath, async () => {
        if (signal?.aborted) throw new Error("Image generation was cancelled.");
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, image.bytes);
      });
      const summary = `Wrote generated image to ${absolutePath} (${image.width}×${image.height}${parsed.quality ? `, ${parsed.quality} quality` : ""}).`
        + (parsed.image.revisedPrompt ? ` Revised prompt: ${parsed.image.revisedPrompt}` : "");
      return {
        content: [
          { type: "text", text: summary },
          { type: "image", data: parsed.image.result, mimeType: "image/png" },
        ],
        details: {
          path: absolutePath,
          outputFormat,
          width: image.width,
          height: image.height,
          inputImageCount: inputImages.length,
          requestedQuality: params.quality,
          quality: parsed.quality,
          size: parsed.size,
          background: parsed.background,
          requestId: response.headers.get("x-codex-imagegen-request-id") ?? undefined,
          imageGenerationId: parsed.image.id,
          revisedPrompt: parsed.image.revisedPrompt,
          usage: parsed.usage,
        },
      };
    },
  });
}
