# pi-undo-redo

Destructive, tail-only undo/redo for pi sessions.

- `/undo` removes the latest user prompt and its response/tool tail from the current active branch, restores the prompt text into the editor, and stores one redo slot.
- `/redo` restores the exact removed entries, including assistant responses.

Safety: `/undo` refuses unless the target prompt is at the true end of a branch. It will not delete hidden downstream history after `/tree` navigation. Backups are stored under `~/.pi/agent/pip/backup/undo-redo/` and pruned by `/pip-settings` options.

When Pi expands an input (for example, a skill invocation), Undo/Redo stores the changed raw form as bounded metadata inside that session. Normal prompts are not duplicated. The metadata follows branch undo/redo and is deleted with the session; the obsolete global raw-prompt cache is removed on session startup.
