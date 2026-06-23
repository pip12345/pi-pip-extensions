# pi-subagents

Minimal quiet subagent task runs for pi.

A subagent is a child task run with isolated context. The caller must put all needed context in the prompt. Subagents are persisted locally to their parent session and anchored to the parent branch entry that created them.

## Tool

```text
subagent({ agent, prompt, model?, background?, keep?, name? })
subagent({ id, prompt })                 # continue retained runs
subagent({ action: "agents" })
subagent({ action: "get_agent", agent })
subagent({ action: "models", query? })          # tool-only; exact model override ids
subagent({ action: "status"|"read", id })
subagent({ action: "steer", id, message })
subagent({ action: "background", id? })
subagent({ action: "cancel"|"keep"|"forget", id })
```

Ephemeral subagents can be continued or steered while they are retained. Their TTL is refreshed whenever they run, receive a message/steer, or emit activity. Use `keep:true` or `action:"keep"` only to disable TTL expiry, or enable **Always keep** in `/pip-settings`. `action:"forget"` toggles a kept run back to ephemeral without changing its branch anchor.

## Commands

```text
/subagent
/subagent view <id-or-name>
/subagent steer <id-or-name> <message>
/subagent status <id-or-name>
/subagent read <id-or-name>
/subagent keep <id-or-name>
/subagent forget <id-or-name>
/subagent cancel <id-or-name>
/subagent background [id-or-name]
/subagent agents [name]
```

`/subagent view` opens a fullscreen manager-backed live viewer for output/tools and inline steering. Use ↑/↓/PgUp/PgDn to scroll, End to follow live output, `s` to steer, and `q`/Esc to close. Steering is wrapped as a mid-run note so the child keeps completing its original delegated task unless explicitly told to abandon it. It does not switch into the child session. `Ctrl+Shift+B` moves all foreground subagents to background. Subagents are visible only while their creation anchor is in the current branch; off-branch ephemerals are pruned, off-branch kept runs are hidden. If a parent session file is deleted from `/resume`, its persisted subagents are lazily cleaned up on the next subagent/session activation.

## Agent files

Preferred paths:

- `~/.pi/agent/agents/*.md`
- `.pi/agents/*.md`

Legacy compatibility:

- `.agents/*.md`

Schema:

```md
---
name: optional-name
description: One-line when-to-use text
model: provider/model-id
tools: read, grep, find, ls, bash
---

System prompt for the subagent.
```

Defaults: filename stem for name, the agent file `model` when set, parent/current model when no agent model is set, and `tools: all` when tools is omitted.

Launch calls can override the agent file/default model without creating a new agent file:

```text
subagent({ agent: "explore", prompt: "...", model: "anthropic/claude-sonnet-4-5" })
subagent({ agent: "explore", prompt: "...", model: "openrouter/anthropic/claude-sonnet-4" })
```

`model` must be `provider/model-id`; provider-specific model IDs may contain additional slashes. Agents can use `subagent({ action: "models", query: "codex" })` to discover exact available override IDs; there is intentionally no `/subagent models` human command because `/model` already owns that UI. The effective model is shown in status/read output and `/subagent view` when known.

## Settings

Configure in `/pip-settings` under **Subagents**:

- Enabled
- Ephemeral TTL
- Max recent
- Max running
- Inject background results
- Always keep
