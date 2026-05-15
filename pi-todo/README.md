# pi-todo

Minimal session-scoped todo tools for pi.

## Tools

- `todo_write` - batch replace the todo list
- `todo_update` - batch update existing todos by `id` or text match
- `todo_read` - read the current todo list

Todos are flat and use three states: `pending`, `active`, and `done`. Prefer batch writes/updates to avoid tool-call spam.

## Command

```text
/todo
/todo add <text>
/todo edit <id> <text>
/todo done <id>
/todo active <id>
/todo pending <id>
/todo delete <id>
/todo clear-done
/todo clear
```

Plain `/todo` opens a small inspector. Use `j/k`, arrows, `space` to cycle status, `d` to delete, `c` to clear done, and `q`/Esc to close.

## Storage

State is saved as custom entries in the pi session tree (`pip.todo.state`), so branch navigation restores the todo state for that branch.

## Settings

Configure in `/pip-settings` under **Todo**:

- Enabled
- Compact rows: `2`, `3`, `4`, or `6`
- Show completed: `smart`, `always`, or `never`
- Hide when all done
- Done style: `strike+dim`, `dim`, or `plain`
- Placement: above or below editor
