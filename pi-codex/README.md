# pi-codex

Codex-specific features for Pi's built-in `openai-codex` provider.

GPT-6 Astra uses Pi's native model catalog (available in Pi `0.85.1` and later). This package does not register models or replace the provider.

## Long context

The package always sets a `1,050,000` token context window when any of these models becomes active:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-6-astra`

Pi intentionally defaults these models to `272,000` tokens so requests stay in OpenAI's short-context pricing tier. This package overrides only the active model's context-window metadata. It preserves the model's auth, transport, compatibility flags, and tiered pricing. Requests with more than 272K total input tokens use the catalog's long-context rates for the entire request.

Pi's pre-session `--list-models` output still shows the raw built-in `272K` value, including for Astra. After a supported model is selected, the active session, footer, context accounting, and compaction threshold use `1.05M`.

## Fast mode

```text
/fast              Toggle Fast mode
/fast on           Enable Fast mode
/fast off          Disable Fast mode
/fast status       Show whether Fast mode applies to the current model
```

When enabled, recognized Codex Responses requests receive:

```json
{ "service_tier": "priority" }
```

OpenAI calls this Fast mode for ChatGPT-authenticated Codex use and Priority processing for API-key use. It increases speed by using more credits or higher-priced API processing. Availability and billing depend on the account, model, and authentication method.

The preference is stored in Pi's session branch. It survives resume/fork and follows tree navigation. On unsupported or non-Codex models the footer shows `fast: waiting`; returning to a supported Codex model activates it automatically.

Requests are changed only when the active model and wire payload match Pi's Codex Responses shape, the model supports Fast mode, and no other extension or provider has already supplied a `service_tier`.

## Image generation

The package registers `codex_generate_image`, which uses the existing `openai-codex` login to generate a new image or edit up to five local reference images:

```json
{
  "prompt": "Draw a pixel-art sword with a blue blade and gold hilt",
  "path": "assets/generated/sword.png"
}
```

For an edit, add `referencedImagePaths`:

```json
{
  "prompt": "Keep the composition but change the sky to sunset",
  "path": "assets/generated/sunset.webp",
  "referencedImagePaths": ["assets/source.png"]
}
```

`path` is required and resolves relative to the current workspace unless it is absolute. Its extension selects PNG (`.png`), JPEG (`.jpg` or `.jpeg`), or WebP (`.webp`). The tool creates parent directories, writes exactly that path with the same overwrite semantics as Pi's `write` tool, and returns the image inline for inspection. It does not create a second copy under Pi's agent directory.

The backend chooses its Codex image model and may revise the prompt; the tool reports the revised prompt when available. It intentionally does not expose size, quality, background, compression, or image-model controls because the ChatGPT-authenticated Codex endpoint is not known to honor them reliably.

Transient rate limits and server failures are retried. Cancellation stops the request, and returned base64 data and file signatures are validated before the output path is written.

## Accounting limitation

Pi's extension hook can safely change the final provider payload, but it cannot set Pi AI's internal `serviceTier` stream option. The wire request is correct. If OpenAI reports the completed request as `service_tier: "default"` after accepting Priority, Pi may under-report the Fast multiplier in its local estimated cost even though provider-side usage or billing reflects the request.
