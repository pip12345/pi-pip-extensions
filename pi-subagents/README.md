# pi-subagents

Minimal quiet subagent task runs for pi.

A subagent is a child task run with isolated context. The caller must put all needed context in the prompt. Subagents are persisted locally to their parent session and anchored to the parent branch entry that created them.

## Tool

```text
subagent({ agent, prompt, background?, keep?, name? })
subagent({ id, prompt })                 # continue kept runs only
subagent({ action: "agents" })
subagent({ action: "get_agent", agent })
subagent({ action: "status"|"read", id })
subagent({ action: "steer", id, message })
subagent({ action: "background", id? })
subagent({ action: "cancel"|"keep"|"forget", id })
```

Ephemeral subagents cannot be continued after completion, but running ephemerals restored after restart are marked interrupted and can be continued. Use `keep:true` or `action:"keep"` for reusable completed runs, or enable **Always keep** in `/pip-settings`. `action:"forget"` toggles a kept run back to ephemeral without changing its branch anchor.

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

Defaults: filename stem for name, parent/current model when `model` is omitted, and `tools: all` when tools is omitted.

## Settings

Configure in `/pip-settings` under **Subagents**:

- Enabled
- Ephemeral TTL
- Max recent
- Max running
- Inject background results
- Always keep
