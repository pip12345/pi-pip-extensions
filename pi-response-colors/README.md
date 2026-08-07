# pi-response-colors

Renders paired color tags in assistant responses without requiring models to emit terminal escape sequences. Requires Pi 0.84.0 or newer.

Supported tags:

```text
[red]...[/red]
[yellow]...[/yellow]
[green]...[/green]
[cyan]...[/cyan]
[magenta]...[/magenta]
```

The extension explains the available tag syntax to the model in interactive mode; prompt profiles decide when colors are useful. During rendering it converts balanced tags to standard terminal foreground colors. ANSI is never added to the saved assistant message.

Markdown emphasis can appear inside a colored span:

```text
[red]**Do not deploy this build.**[/red]
```

Tags in inline code and fenced code blocks are left unchanged. Escaped, unknown, mismatched, and unclosed tags are also rendered literally. Color tags are retained in session content and therefore remain visible in copied, exported, print-mode, or JSON text.

The extension uses Pi's display-only Markdown transformer, so it applies to live and restored assistant messages without modifying stored content.
