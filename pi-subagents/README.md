# pi-subagents

Quiet subagent task runs for pi.

A subagent is a separate agent with its own isolated context. It runs one task and returns its final answer. The caller must put all needed context in the prompt.

Subagents belong to the parent session and live in memory. Starting a new session, resuming another one, reloading, or quitting stops them. `/tree` navigation does not affect them.

## Tools

```text
subagent({ agent, prompt, model?, background? })
subagent_message({ id, message, background? })
subagent_status({ id? })
```

- `subagent` launches a run. A foreground run returns its result. A background run returns its id right away, and the result arrives later as a follow-up message. Aborting a foreground call cancels the run.
- `subagent_message` sends a steering note to a running subagent, which keeps working on its task. A finished subagent instead continues its conversation with the message as the next prompt.
- `subagent_status` shows one run's state and latest result, or lists the session's runs when `id` is omitted.

`model` must be `provider/model-id`. Provider-specific model ids may contain more slashes. An unknown model fails with the list of available models for that provider. Without `model`, the run uses the agent file's model, or the parent's current model when the agent file has none.

## Command

```text
/subagent
/subagent view <id>
```

`/subagent` picks a run and opens its live view. The view shows the prompt, assistant text, tool calls, and the first line of each tool result. Use ↑/↓/PgUp/PgDn to scroll, End to follow live output, `s` to steer, `c` to cancel, and `q`/Esc to close. Steering a finished run continues it in the background, so its reply reaches the parent as a follow-up message.

## What a subagent loads

A subagent starts like a normal pi session in the same working directory. It loads your settings, context files, skills, and the extensions the parent loads, except these packages:

- `pi-subagents`: subagents cannot start their own subagents.
- `pi-stats`: it would count subagent usage a second time.
- `pi-prompt-profiles`: the parent's working style is not the subagent's prompt.
- `pi-question`: subagents have no UI to answer questions.

Pi's built-in MCP, `codemode`, and `tool_search` support is loaded, so configured MCP servers work in subagents. Each subagent connects to the servers while it runs and disconnects when it finishes. Project resources and project MCP servers load only when the parent project is trusted.

## Agent files

Preferred paths:

- `~/.pi/agent/agents/*.md`
- `.pi/agents/*.md`

Legacy compatibility:

- `.agents/*.md`

Project and legacy project agent files are ignored until Pi reports the project as trusted. Builtin and user agent files remain available in untrusted projects.

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

Defaults: filename stem for name, the parent's current model when `model` is not set, and `tools: all` when tools is omitted.

`tools` sets the subagent's active tools after startup. `all` keeps every tool the session activates, including MCP access. `builtins` keeps pi's built-in file and shell tools, and `none` disables tools. A list names exact tools. Include `codemode`, `tool_search`, or `mcp__<server>__<tool>` names in a list to keep MCP access.

## Settings

Configure in `/pip-settings` under **Subagents**:

- Enabled
- Max running
- Inject background results
