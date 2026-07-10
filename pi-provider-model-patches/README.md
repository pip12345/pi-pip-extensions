# pi-provider-model-patches

Persistent, opt-in model catalog patches for providers Pi already knows how to use.

The extension changes only model metadata. It reuses the target provider's existing Pi authentication, endpoint, headers, compatibility behavior, and streaming implementation. It cannot bypass provider rollout, plan limits, or organization policy.

## Bundled presets

The package currently owns this preset:

- **GitHub Copilot · GPT-5.6**
  - `github-copilot/gpt-5.6-sol`
  - `github-copilot/gpt-5.6-terra`
  - `github-copilot/gpt-5.6-luna`

Bundled presets update with the package. They are not copied into user configuration.

Every patch defaults to **off**. Configure persistent toggles under **Provider Model Patches** in:

```text
/pip-settings
```

Settings changed there apply after `/reload` or the next Pi launch. For immediate persistent changes:

```text
/model-patch status
/model-patch on github-copilot
/model-patch off github-copilot
/model-patch on github-copilot-gpt-5-6
/model-patch reload
```

The footer shows `patches: default` when Pi's unmodified catalogs are active, or lists patched providers.

## Optional user patches

The extension reads, but never creates or rewrites:

```text
~/.pi/agent/pip/model-patches.json
```

Example:

```json
{
  "patches": [
    {
      "id": "my-provider-next-model",
      "label": "My Provider · Next Model",
      "provider": "my-provider",
      "templateModel": "current-model",
      "models": [
        {
          "id": "next-model",
          "metadataFrom": "openai/next-model"
        }
      ]
    }
  ]
}
```

- `provider` is the existing target provider.
- `templateModel` supplies the target endpoint, headers, API type, and compatibility behavior.
- `metadataFrom` supplies capability, context, pricing, and reasoning metadata from another model already known to Pi.
- A model can set its own `templateModel` when one patch needs multiple target API types.
- `metadata` can provide fallback values or override copied metadata. When `metadataFrom` is unavailable, full metadata is required: `name`, `api`, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens`.

No API keys or OAuth configuration belong in this file. The target provider must already be authenticated through Pi. Source and target template API types must match.

## Limits

Pi's extension API replaces a provider catalog as a whole. Another extension dynamically overriding the same provider may conflict when either extension unregisters it. Also, adding a catalog entry does not make an unavailable upstream model usable; provider-side model filtering still wins.
