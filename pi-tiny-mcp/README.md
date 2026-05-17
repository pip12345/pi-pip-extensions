# pi-tiny-mcp

Tiny stdio-only MCP adapter for pi/PiP.

No SDK. No HTTP. No SSE. No OAuth. No MCP UI. No dependency refrigerator.

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

Supported fields: `command`, `args`, `cwd`, `env`, `timeoutMs`, `disabled`.

Unsupported fields such as `url`, `headers`, `auth`, and `oauth` fail loudly because this adapter is stdio-only.

## Config files

Read order, later overrides earlier by server name:

1. `~/.config/mcp/mcp.json`
2. `~/.pi/agent/pip/tiny-mcp.json`
3. `.mcp.json`
4. `.pi/tiny-mcp.json`

`/tiny-mcp config` opens the target selected in `/pip-settings`.

Useful commands:

```text
/tiny-mcp status
/tiny-mcp help
/tiny-mcp config pip
/tiny-mcp config global
/tiny-mcp config project
/tiny-mcp reconnect <server>
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

The tool metadata tells the model to search/describe before calling unfamiliar tools, to connect servers when no tools are cached, and to edit explicit config files directly when asked to configure MCP.

## Settings

Configured through `/pip-settings` under **Tiny MCP**:

- enabled
- config target
- metadata cache
- tool timeout
- server stderr
- tool prefix
- result limit
