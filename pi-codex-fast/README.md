# pi-codex-fast

Session-scoped Fast mode for Pi's built-in `openai-codex` provider.

## Commands

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

## Safety and catalog behavior

The extension does not copy, replace, or maintain a second model catalog. It checks the active model and request at send time, so eligible entries added to Pi's normal `openai-codex` catalog are handled automatically.

Requests are changed only when all of these are true:

- Fast mode is enabled for the session branch.
- The provider is exactly `openai-codex`.
- The API is exactly `openai-codex-responses`.
- The request model matches the active model.
- The payload has the expected streaming Codex Responses shape.
- The model explicitly advertises Fast/Priority support, or belongs to an OpenAI-documented Fast family (currently GPT-5.4, GPT-5.5, or GPT-5.6).
- No extension or provider has already supplied a `service_tier`.

Explicit catalog capability metadata takes precedence, including an explicit unsupported result. Unsupported models such as Codex Spark, non-Codex providers, malformed payloads, and conflicting service tiers are left unchanged.

The preference is stored in Pi's session branch. It survives resume/fork and follows tree navigation. On unsupported or non-Codex models the footer shows `fast: waiting`; returning to a supported Codex model activates it automatically.

## Accounting limitation

Pi's extension hook can safely change the final provider payload, but it cannot set Pi AI's internal `serviceTier` stream option. The wire request is correct. If OpenAI reports the completed request as `service_tier: "default"` after accepting Priority, Pi may under-report the Fast multiplier in its local estimated cost even though provider-side usage or billing reflects the request.
