# pi-tiny-mcp

Tiny stdio/HTTP MCP adapter for pi/PiP.

No SDK. No OAuth. No MCP UI. No dependency refrigerator.

## Install in this workspace

`pi-tiny-mcp` is a `pi-*` package and depends only on `pip-common` plus pi peer deps.

## Configure servers

Preferred project config:

```json
{
  "mcpServers": {
    "ghidra": {
      "command": "python",
      "args": ["bridge_mcp_ghidra.py", "--transport", "stdio"],
      "cwd": "/path/to/ghidra-mcp",
      "env": {
        "GHIDRA_MCP_URL": "http://127.0.0.1:8089",
        "PYTHONIOENCODING": "utf-8"
      }
    }
  }
}
```

Supported stdio fields: `type`, `command`, `args`, `cwd`, `env`, `timeoutMs`, `disabled`.

HTTP/HTTPS Streamable HTTP servers are configured with `url`:

```json
{
  "mcpServers": {
    "logic2": {
      "type": "http",
      "url": "http://127.0.0.1:10530"
    }
  }
}
```

Supported HTTP fields: `type`, `url`, `headers`, `timeoutMs`, `disabled`. `type` may be `http`, `streamable-http`, or `sse`; URL configs try Streamable HTTP with legacy HTTP+SSE fallback, while `sse` starts legacy directly.

`url` and `headers` values support `${VAR}` and `${VAR:-default}` environment expansion.

Unsupported auth fields such as `auth` and `oauth` fail loudly. Use static `headers` when a server only needs header-based auth.

## Config files

Read order, later overrides earlier by server name:

1. `~/.config/mcp/mcp.json`
2. `~/.pi/agent/pip/tiny-mcp.json`
3. `.mcp.json`
4. `.pi/tiny-mcp.json`

Project files (`.mcp.json` and `.pi/tiny-mcp.json`) are ignored unless Pi reports the project as trusted. Untrusted project commands are never loaded or auto-connected.

`/tiny-mcp config` opens the PiP-owned config by default. Pass `pip`, `global`, or `project` explicitly to choose another target.

Useful commands:

```text
/tiny-mcp status
/tiny-mcp help
/tiny-mcp config pip
/tiny-mcp config global
/tiny-mcp config project
/tiny-mcp connect [server]
/tiny-mcp disconnect [server]
```

## Tool

Registers one proxy tool:

```text
tiny-mcp({})
tiny-mcp({ connect: "ghidra" })
tiny-mcp({ search: "decompile" })
tiny-mcp({ describe: "ghidra_decompile_function" })
tiny-mcp({ tool: "ghidra_decompile_function", args: "{\"address\":\"0x401000\"}" })
```

`args` is a JSON string.

For quick testing, add a memory-only server without writing config files:

```text
tiny-mcp({ action: "add", server: "scratch", config: "{\"type\":\"http\",\"url\":\"http://127.0.0.1:3000/mcp\"}", connect: true })
```

The `config` value is a JSON string containing one MCP server object. Runtime servers live only in the current pi process and disappear on restart/reset.

The tool metadata tells the model to search/describe before calling unfamiliar tools, to connect servers before discovery when needed, and to edit explicit config files directly when asked to configure MCP. Oversized output is saved under the managed PiP artifact directory and returned with its path; MCP failures are reported as tool errors. HTTP JSON/SSE messages and stdio JSON lines are capped at 5 MB before parsing, while retained stderr lines are independently bounded.

## Settings

Configured through `/pip-settings` under **Tiny MCP**:

- enabled

Operational policy is fixed: 30-second default requests, tailed server stderr, server-prefixed tool names, no metadata cache, and 20,000 characters of inline result text. Per-server `timeoutMs` still overrides the default.
