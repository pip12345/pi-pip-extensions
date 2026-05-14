# Agent Notes

## UI conventions

When building menus or shared UI in `pip-common`, default behavior should follow the type of content being rendered:

- Prose/detail text wraps by default: setting descriptions, help text, warnings, explanatory copy.
- Data rows/cells truncate by default: tree rows, message previews, file paths, command output previews, compact status lines.
- Use `wrapAnsi()` for prose.
- Use `truncateToWidth()` only when truncation is intentional.
- `boxLines()` expects callers to pass lines that are already wrapped or intentionally truncated.

Do not put implementation/agent-only conventions in the human-facing top-level README.
