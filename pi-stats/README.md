# pi-stats

Interactive token, cache, context, and cost inspector for Pi sessions and aggregate usage.

## Command

```text
/stats
```

The **Session** page shows usage by turn, including prompt, output, cache, total-token, context, and cost information. The **Global** page groups persisted usage by model, provider, or day.

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

Assistant usage events are appended under:

```text
~/.pi/agent/pip/usage/
```

Events are stored per session/day and compacted into daily rollups. Writes use per-session event files so concurrent Pi processes do not rewrite one shared usage document.
