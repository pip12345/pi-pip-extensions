# pi-response-colors

Renders paired color tags in assistant responses without requiring models to emit terminal escape sequences.

Supported tags:

```text
[red]error or caution[/red]
[yellow]important information or a next action[/yellow]
[green]success[/green]
[cyan]neutral information[/cyan]
[magenta]risk or tradeoff[/magenta]
```

The extension adds concise tag guidance to the system prompt in interactive mode. During rendering it converts balanced tags to standard terminal foreground colors. ANSI is never added to the saved assistant message.

Markdown emphasis can appear inside a colored span:

```text
[red]**Do not deploy this build.**[/red]
```

Tags in inline code and fenced code blocks are left unchanged. Escaped, unknown, mismatched, and unclosed tags are also rendered literally. Color tags are retained in session content and therefore remain visible in copied, exported, print-mode, or JSON text.

The extension patches Pi's exported `AssistantMessageComponent` because Pi does not currently expose an assistant-response rendering hook. If that internal rendering path changes, the extension should fail without modifying stored messages.
