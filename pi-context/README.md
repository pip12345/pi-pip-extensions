# pi-context

Interactive inspector for Pi's effective context and assembled system prompt.

## Command

```text
/context
```

The context view shows observed usage, a size estimate for the compaction-aware conversation Pi sends to the model, prompt source categories, free space, and the model's maximum output capacity. The output-cap value is not Pi's separate compaction reserve, which is not exposed to extensions.

Press `p` to inspect the assembled system prompt and its source sections. Use `Tab`/`h`/`l` to change sections, arrow or page keys to scroll, `b` to return, and `q` to close.

The inspector is read-only and requires Pi's interactive TUI.
