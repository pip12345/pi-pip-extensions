# pi-pip-extensions

One aggregate Pi package containing separately filterable extension features. Each `pi-*` feature also remains available as a standalone package.

## Dependencies

The extensions use Pi's built-in packages, Node.js built-ins, and the bundled `pip-common` runtime. Git package installation runs `npm install` automatically; local checkouts must run `npm install` once to link the workspace packages.

## Install

Recommended: install this repo as a git Pi package:

```bash
pi install git:github.com/pip12345/pi-pip-extensions
```

Pi reads the top-level package manifest and loads `pip-common/index.ts` plus each `pi-*/index.ts`. `pip-common` registers shared commands such as `/pip-settings` and exposes helper APIs used by the other extensions.

When the remote git branch moves, Pi warns at startup that package updates are available. Update with:

```bash
pi update --extensions
```

Then restart Pi or run `/reload`.

For local development, install the workspace links and point Pi directly at this folder in `settings.json`:

```bash
npm install
```

Then configure:

```json
{
  "extensions": [
    "."
  ]
}
```

Relative paths are resolved from the settings file location. Use `.` when the settings file lives in this project root; use `./pi-pip-extensions` when it lives in the parent directory.

Standalone feature tarballs bundle and load `pip-common` before their own entrypoint. Maintainers generate those tarballs with:

```bash
npm run pack:workspaces -- --pack-destination <directory>
```

## What gets loaded

Pi reads the top-level `pi.extensions` manifest. `pip-common` loads first for shared commands/settings, then each `pi-*` folder loads as its own extension.

This collection includes:

- `pi-context` - interactive context usage and prompt inspector
- `pi-secrets-guard` - Secrets Guard: blocks common secret paths and project `.secretignore` rules; legacy `.gitignore` blocking is optional
- `pi-provider-model-patches` - persistent opt-in patches for stale provider model catalogs; includes Copilot GPT-5.6, off by default
- `pi-pip-footer` - richer footer with token/context/model/quota info
- `pi-prompt-profiles` - switchable prompt profile overlays
- `pi-provider-proxy` - map Pi provider `baseUrl`s to externally managed relay URLs
- `pi-question` - structured question tool for the assistant
- `pi-tool-ui` - unified compact rendering for built-in and Pip tools
- `pi-stats` - session and usage stats
- `pi-subagents` - quiet subagent task runner
- `pi-tiny-mcp` - tiny stdio/HTTP MCP bridge
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

`pi-secrets-guard` appears as **Secrets Guard** in `/pip-settings`. It blocks common secret paths by default and reads project `.secretignore` files using gitignore-style patterns; `!pattern` negates earlier `.secretignore` rules. Legacy `.gitignore` blocking is available but off by default.