# pi-codex

Long context and Fast mode for Pi's built-in `openai` and `openai-codex` providers, plus Codex image generation. Requires Pi `0.99.1` or newer.

Pi owns the model catalog, authentication, and transport. This package does not register or replace a provider. Fast mode and long context also apply to the OpenAI provider's new Sign in with ChatGPT path.

## Long context

The package always sets a `1,050,000` token context window when any of these models becomes active on `openai` or `openai-codex`:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-6-astra`
- `gpt-6-sol`
- `gpt-6-luna`
- `gpt-6.1-sol`

OpenAI documents [GPT-6.1 Sol's 1,050,000-token context window](https://developers.openai.com/api/docs/models/gpt-6.1-sol). The model is supplied by Pi's native catalog; this package enables its long context when active.

Pi's native catalog defaults these models to `272,000` tokens so requests stay in OpenAI's short-context pricing tier. This package overrides only the active model's context-window metadata. It preserves the model's auth, transport, compatibility flags, and tiered pricing. Requests with more than 272K total input tokens use the catalog's long-context rates for the entire request.

Pi's pre-session `--list-models` output still shows the raw `272K` value. After a supported model is selected, the active session, footer, context accounting, and compaction threshold use `1.05M`.

## Fast mode

```text
/fast              Toggle Fast mode
/fast on           Enable Fast mode
/fast off          Disable Fast mode
/fast status       Show whether Fast mode applies to the current model
```

When enabled, recognized OpenAI or Codex Responses requests receive:

```json
{ "service_tier": "priority" }
```

GPT-6.1 Sol supports Fast mode alongside the existing supported models, as documented in [Codex speed](https://developers.openai.com/codex/speed). This enables standard Fast mode, not Ultrafast.

OpenAI documents `priority` and `fast` as equivalent Fast mode request values for supported API models. It increases speed by using more credits or higher-priced API processing. Availability and billing depend on the account, model, and authentication method.

The preference is stored in Pi's session branch. It survives resume/fork and follows tree navigation. On unsupported models the footer shows `fast: waiting`; returning to a supported OpenAI or Codex model activates it automatically.

Requests are changed only when the active model and wire payload match Pi's OpenAI or Codex Responses shape, the model supports Fast mode, and no other extension or provider has already supplied a `service_tier`.

## Image generation

The package registers `codex_generate_image`, which uses an `openai-codex` login to generate a PNG image or edit up to five local PNG, JPEG, or WebP reference images:

```json
{
  "prompt": "Draw a pixel-art sword with a blue blade and gold hilt",
  "path": "assets/generated/sword.png",
  "quality": "medium"
}
```

For an edit, add `referencedImagePaths`:

```json
{
  "prompt": "Keep the composition but change the sky to sunset",
  "path": "assets/generated/sunset.png",
  "referencedImagePaths": ["assets/source.png"]
}
```

`path` is required and resolves relative to the current workspace unless it is absolute. Output is PNG-only (`.png`). JPEG, WebP, GIF, and other output extensions are rejected before authentication or HTTP requests. The native endpoint can return PNG even when another format is requested, so the tool does not offer those output formats or perform local conversion. JPEG and WebP remain supported as reference inputs.

The tool creates parent directories, writes exactly the requested path with the same overwrite semantics as Pi's `write` tool, and returns the PNG inline for inspection. It does not create a second copy under Pi's agent directory.

Optional `quality` requests `low`, `medium`, `high`, or `auto` rendering quality. Omit it to leave the backend's default unchanged. The backend may override the request, so compare requested and returned quality rather than assuming they match. This is not image-model selection or reasoning complexity.

The image tool still resolves credentials from `openai-codex`, independently of the active chat provider. Access to the Codex image endpoint with the new `openai` subscription token has not been verified; the tool does not substitute that token.

Requests go directly to Codex's native `/codex/images/generations` or `/codex/images/edits` endpoint, without a chat-model request or model-catalog lookup. The tool sends the native Codex client's `gpt-image-2` alias. The backend chooses the serving image model; that alias is not a guarantee of a particular model version. There is no fallback to Responses, browser automation, or the paid Image API.

Results report actual PNG dimensions from the image header and, when supplied by the backend, quality, size, background, generation/request IDs, usage, and a revised prompt. Requested quality is recorded separately from returned quality. A missing returned quality is left unknown, not copied from the request. The compact result shows dimensions and returned quality; expanded results also show token usage.

Size, background, compression, image-model selectors, and `complexity` controls are not exposed. In particular, this tool does not claim explicit GPT Image 2.6 Sunburst/Flare selection or API-style complexity support.

Transient rate limits and server failures are retried. Cancellation stops the request, and returned base64 data and file signatures are validated before the output path is written.

## Accounting limitation

Pi's extension hook can safely change the final provider payload, but it cannot set Pi AI's internal `serviceTier` stream option. The wire request is correct. If OpenAI reports the completed request as `service_tier: "default"` after accepting Priority, Pi may under-report the Fast multiplier in its local estimated cost even though provider-side usage or billing reflects the request.
