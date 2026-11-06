# pi-claude-agent

A separate `claude-agent` model provider that runs the real Claude Code executable through Anthropic's Agent SDK. Pi still runs tools, permission checks, Secrets Guard, subagents, and compaction. The existing `anthropic` provider is unchanged.

## Requirements

- Pi `0.99.1` or newer and Node.js `22.19` or newer.
- Claude Code `2.1.248` or newer, installed and signed in on the **same machine as Pi**. In a container, a host-only installation is not sufficient.
- This package's npm dependencies. Pi installs these for managed git/npm packages. For a local checkout of the aggregate repository, run `npm ci --ignore-scripts` at its root.

The extension uses `claude` from `PATH`. Set `PI_CLAUDE_PATH` before starting Pi to select another executable. It never falls back to the SDK's bundled executable.

## Connect

Sign in outside Pi:

```bash
claude auth login
```

Restart Pi or run `/reload`, then:

```text
/model
```

Choose a model under `claude-agent`. `/claude-agent status` shows setup instructions. Pi's normal model-catalog refresh discovers models, context windows, and effort levels from Claude Code. Models stay hidden when Claude Code is missing or reports no configured authentication, even if a catalog was cached previously. Authentication is checked through `claude auth status` when Pi resolves the provider, not through a background polling loop. The extension does not read saved credentials or add a subscription OAuth flow to Pi's `/login`.

**Subscription permission:** OpenCode's integration author reports Anthropic approval for OpenCode. That does not establish approval for Pi. Anthropic's [SDK policy](https://platform.claude.com/docs/en/agent-sdk/overview) requires prior approval for third-party products offering Claude subscription login or rate limits. Use an authorized authentication method. This extension makes no claim of Anthropic approval.

## Behavior and limits

- Claude receives Claude Code's base prompt plus Pi's current instructions. Claude Code's own tools, project settings, hooks, skills, memory, and automatic compaction are disabled.
- Pi executes every offered tool normally. Claude's MCP handlers wait for Pi's results, including blocked calls and errors. Claude cannot silently fall back to its built-in tools.
- Uninterrupted chat and tool steps share a process. Changed prompts, tools, models, or effort restart it. Edited histories and compacted conversations are reconstructed from Pi's transcript, without replaying old tools. Reload, shutdown, or five minutes idle also discard native context. Rebuilding can consume more tokens than resuming a native Claude session.
- Claude supports text and image input and image tool results. Pi's available thinking levels follow the capabilities reported by Claude Code. Models that require thinking do not advertise an off setting.
- Subscription token counts are recorded with zero estimated API cost. Direct Anthropic API-key logins use known catalog prices. Other backends, custom gateways, and unknown model prices show zero, which means **no estimate**, not free usage. Open `/model` after changing the Claude Code login to update the catalog and cost estimates. Live billing is authoritative.
- Claude Code owns HTTP requests and its own retries. Pi's normal outer retry policy still applies to failed provider steps. The bridge discards failed native context before retrying.
- HTTP response/header observation is unavailable. `provider_stream_event` exposes SDK events. `before_provider_request` observes a logical SDK request, not Anthropic's private HTTP payload. Replacing that request or injecting a custom `fetch` is rejected. Use transcript hooks or CLI environment settings instead.
- Shell connection settings such as `ANTHROPIC_BASE_URL` remain available to Claude Code. An explicit Pi model endpoint, API key, or custom request header is passed to the CLI, rather than used to make HTTP calls in Pi.
- Claude Code-specific `/usage`, teams, auto mode, and memory are not exposed.

The bridge design is adapted from OpenCode's MIT-licensed Claude Agent provider. See `THIRD_PARTY_NOTICES`.
