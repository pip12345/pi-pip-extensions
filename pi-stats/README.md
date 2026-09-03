# pi-stats

Interactive token, cache, context, and cost inspector for Pi sessions and aggregate usage.

## Command

```text
/stats
```

The **Session** page shows usage by prompt plus explicit compaction and branch-summary overhead rows. Summary columns separate fresh input (uncached input plus cache writes), output, and reused cached input (cache reads); selected-row details expose the provider's raw input, cache-read, and cache-write buckets. Context, total-token, and cost information remain separate. Standard billed tool usage is included in its owning prompt row. The **Global** page groups persisted usage calls by model, provider, or day; tool and summary calls without model attribution appear under `pi/tools/summaries`.

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

Events are stored per session/day and compacted into daily rollups. Writes use per-session event files so concurrent Pi processes do not rewrite one shared usage document.
