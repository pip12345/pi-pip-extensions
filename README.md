# pi-pip-extensions

A loose local collection of Pi extensions.


You can point Pi at this folder and it will load the extensions inside it.

## Dependencies
No external dependencies. The collection only uses Pi's built-in extension packages, Node.js built-ins, and its own shared `pip-common` helpers.

## Install

Recommended: install this repo as a git Pi package:

```bash
pi install git:github.com/pip12345/pi-pip-extensions
```

Pi reads the top-level package manifest and loads each `pi-*/index.ts` as its own extension. `pip-common` is the shared helper package used by those extensions; it is not loaded as an extension from the top-level manifest.

When the remote git branch moves, Pi warns at startup that package updates are available. Update with:

```bash
pi update --extensions
```

Then restart Pi or run `/reload`.

For local development, you can point Pi directly at this folder in `settings.json`:

```json
{
  "extensions": [
    "./pi-pip-extensions"
  ]
}
```

Relative paths are resolved from the settings file location. So if your settings file lives in this project root, `./pi-pip-extensions` is correct.

## What gets loaded

Pi scans this folder one level deep. Each `pi-*` folder is its own extension.

This collection includes:

- `pi-pip-footer` - richer footer with token/context/model/quota info
- `pi-plan-mode` - read-only planning mode
- `pi-prompt-profiles` - switchable prompt profile overlays
- `pi-question` - structured question tool for the assistant
- `pi-quiet-tools` - quieter rendering for noisy built-in tools
- `pi-stats` - session and usage stats
- `pi-subagents` - quiet subagent task runner
- `pi-tiny-mcp` - tiny stdio MCP bridge
- `pi-todo` - todo tools and `/todo`
- `pi-tree-edit` - session tree editor
- `pi-undo-redo` - undo/redo recent prompts
- `pi-webfetch-websearch` - bounded web fetch/search tools
- `pip-common` - shared settings and helper code, including `/pip-settings`

## Configure

After loading the collection, use:

```text
/pip-settings
```

That opens settings for the extensions that expose options.

Settings are saved under:

```text
~/.pi/agent/pip/pip-settings.json
```