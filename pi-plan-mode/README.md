# pi-plan-mode

Minimal read-only plan mode for pi.

## Command

```text
/plan
/plan on
/plan off
/plan status
```

Plan mode blocks file edits/writes and non-readonly bash commands while adding a short planning reminder to the system prompt. It does not create plan files, track execution, or change the active tool list.

## Tool policy

Always allowed in plan mode:

- `read`, `grep`, `find`, `ls`
- `webfetch`, `websearch` when installed
- `todo_read` when installed

Always blocked in plan mode:

- `edit`, `write`
- `todo_write`, `todo_update` when installed

Unknown tools are allowed by default and can be blocked in `/pip-settings`.

## Settings

Configure in `/pip-settings` under **Plan Mode**:

- Enabled
- Bash: `readonly` or `block`
- Unknown tools: `allow` or `block`
- Indicator

When active, the indicator is shown above the editor. If `pi-pip-footer`'s token counter is enabled, plan mode appears above the token counter.
