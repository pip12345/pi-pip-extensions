# pi-stats

Interactive token, cache, context, and cost inspector for Pi sessions and aggregate usage.

## Prompt performance

Pip Footer shows the latest completed reply's result, such as `42.4s · 48 t/s`, beside the token and cache counts above the editor. It updates when Pi finishes the full reply, including tool calls, retries, and continuations. The previous result stays visible while the next reply is running. No timing lines are added to the transcript.

Elapsed time includes tools, waiting, thinking, and compaction. Token speed uses the combined provider-reported output tokens divided by model-request time, excluding tool execution and pauses between requests. It is not text-only decoding speed. Speed is omitted if output usage is unavailable or zero. Interrupted and failed replies are labeled `aborted` or `error`.

`/stats` shows **Time** and **t/s** per user prompt. Prompt details also show model-request time. Timings are saved with the session, stay out of model context, and follow the active branch when resuming or navigating the tree. Prompts without recorded timings show `-`.

## Command

```text
/stats
```

The **Session** page shows usage by prompt plus explicit compaction, branch-summary, and background-usage overhead rows. Background usage includes cache warming and preserves Pi's model attribution. Summary columns separate fresh input (uncached input plus cache writes), output, and reused cached input (cache reads); selected-row details expose the provider's raw input, cache-read, and cache-write buckets. Context, total-token, and cost information remain separate. Standard billed tool usage is included in its owning prompt row. The **Global** page groups persisted usage calls by model, provider, or day; tool and summary calls without model attribution appear under `pi/tools/summaries`.

Controls:

- `Tab` switches between Session and Global
- `j`/`k` or arrow keys move selection
- Page Up/Down jump to the start or end
- `1`/`2`/`3`/`4` select today, 7 days, 30 days, or all time
- `g` groups global usage by model, provider, or day
- `/` searches global rows
- `r` toggles compact/raw number formatting
- `q` or Esc closes the inspector

The command requires Pi's interactive TUI.

## Storage

Assistant, billed tool, compaction, and branch-summary usage events are appended under:

```text
~/.pi/agent/pip/usage/
```

New persisted background usage is collected at session/run boundaries and when `/stats` opens. Idle warming therefore reaches Global on the next boundary or command; Session reads the persisted entries directly. Existing background entries are not backfilled into Global on resume.

Events are stored per session/day and compacted into daily rollups. Writes use per-session event files so concurrent Pi processes do not rewrite one shared usage document.
