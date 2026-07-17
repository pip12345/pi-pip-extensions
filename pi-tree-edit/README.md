# pi-tree-edit

Transactional conversation tree editor for Pi sessions.

## Command

```text
/tree-edit
```

The editor loads the current session into an in-memory draft. Edits are not written until you quit and choose **Save and quit**. Saving creates a retained backup under `~/.pi/agent/pip/backup/tree-edit`, atomically replaces the session, and persists the selected current location across reopen/restart.

By default, the view uses the `no-tools` filter: the normal tree view without tool results. Press `f` to cycle the same filters as Pi's `/tree`.

## Keys

- `j` / `↓` - move down
- `k` / `↑` - move up
- `PageDown` / `PageUp` - page
- `Ctrl+←` / `Ctrl+→` - collapse / expand selected branch
- `f` - cycle filter (`default`, `no-tools` default, `user-only`, `labeled-only`, `all`)
- `v` - start range at cursor; press `v` again to cancel
- `y` - copy from range start to cursor, or selected entry if no range; clears range after copy
- `c` - cut from range start to cursor, or selected entry if no range; clears range after cut
- `C` - compact messages before selected user/assistant message
- `p` - paste clipboard after selected entry; with an active range, replace the range
- `P` - paste clipboard as a new branch from selected entry; disabled while a range is active
- `d` - delete selected range, or selected entry if no range
- `D` - delete selected branch
- `t` - prune tool output in the selected range, or selected tool call/result if no range
- `u` - undo last draft change
- `U` - redo last undone draft change
- `e` - edit selected message text
- `L` - set or clear selected entry label
- `b` - set current location to selected entry
- `q` / `Esc` - exit prompt

There is intentionally no save shortcut. All persistence happens through the exit prompt.
