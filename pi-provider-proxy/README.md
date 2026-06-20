# pi-provider-proxy

Provider relay map for Pi.

This extension has one job:

```text
Pi provider id -> provider baseUrl reachable from the Pi process
```

It does **not** start SSH, run Caddy/nginx, store credentials, replace provider auth, or implement provider protocols. Pi still uses the real provider implementation, real model list, and normal `/login` or API-key auth. Only `baseUrl` changes.

## The three links

Keep the pieces separate:

```text
1. Relay routes   /openai/*    -> https://api.openai.com/*
                  /chatgpt/*   -> https://chatgpt.com/*
                  /anthropic/* -> https://api.anthropic.com/*

2. Transport      ssh -L local:9898 -> server:9898

3. Pi map         openai        -> <relay>/openai/v1
                  openai-codex -> <relay>/chatgpt/backend-api
                  anthropic     -> <relay>/anthropic
```

Each link should be testable with plain tools. If a link is broken, fix that link; the extension will not hide it.

## Relay address visible from Pi

`<relay>` means the HTTP base URL reachable from the Pi process, not necessarily from your shell.

```text
Pi native / same network namespace:  http://127.0.0.1:9898
Pi in Docker, tunnel on host:        http://172.17.0.1:9898
```

Use the Docker host gateway only when Pi is inside Docker and the SSH tunnel is running on the host.

## Provider baseUrls

Configure these values in Pi for the relay contract above:

```text
openai        <relay>/openai/v1
openai-codex <relay>/chatgpt/backend-api
anthropic     <relay>/anthropic
```

If your relay exposes different prefixes, configure the actual provider `baseUrl` visible through that relay. The extension stores and registers exactly what you set.

Example for Pi inside Docker with the tunnel on the host:

```text
/proxy add openai http://172.17.0.1:9898/openai/v1
/proxy add openai-codex http://172.17.0.1:9898/chatgpt/backend-api
/proxy add anthropic http://172.17.0.1:9898/anthropic
/proxy on
```

## Setup flow

### 1. Run a relay on the server

One possible Caddy shape:

```caddyfile
:9898 {
  handle /health {
    respond "ok" 200
  }

  handle /openai/* {
    uri strip_prefix /openai
    reverse_proxy https://api.openai.com {
      header_up Host api.openai.com
      flush_interval -1
    }
  }

  handle /chatgpt/* {
    uri strip_prefix /chatgpt
    reverse_proxy https://chatgpt.com {
      header_up Host chatgpt.com
      flush_interval -1
    }
  }

  handle /anthropic/* {
    uri strip_prefix /anthropic
    reverse_proxy https://api.anthropic.com {
      header_up Host api.anthropic.com
      flush_interval -1
    }
  }
}
```

Bind the relay privately on the server if you are using SSH forwarding, for example Docker publishing:

```yaml
ports:
  - "127.0.0.1:9898:9898"
```

### 2. Start the SSH transport externally

```bash
ssh -N -L 127.0.0.1:9898:127.0.0.1:9898 user@server
```

This extension does not manage that process.

### 3. Test from Pi's network namespace

Native Pi:

```bash
curl -i http://127.0.0.1:9898/health
```

Pi inside Docker, tunnel on host:

```bash
curl -i http://172.17.0.1:9898/health
```

Then test a provider path where possible:

```bash
curl -i http://172.17.0.1:9898/openai/v1/models
```

Without auth, provider routes may return `401`; that still proves routing. HTML from Cloudflare means you reached a Cloudflare-protected upstream page, not a JSON API response.

### 4. Map Pi providers

```text
/proxy add openai-codex http://172.17.0.1:9898/chatgpt/backend-api
/proxy on
/proxy status
```

## Commands

```text
/proxy                         Show status, commands, and SSH tunnel hint
/proxy status                  Show current provider overrides
/proxy setup                   Add or update one or more provider baseUrls interactively
/proxy add <provider> <url>    Add or update one provider override
/proxy remove <provider>       Remove one provider override
/proxy on                      Enable configured overrides
/proxy off                     Disable configured overrides and restore providers
```

## Config

Saved under:

```text
~/.pi/agent/pip/provider-proxy.json
```

Shape:

```json
{
  "enabled": true,
  "providers": {
    "openai": "http://172.17.0.1:9898/openai/v1",
    "openai-codex": "http://172.17.0.1:9898/chatgpt/backend-api",
    "anthropic": "http://172.17.0.1:9898/anthropic"
  }
}
```

Default state is disabled:

```json
{
  "enabled": false,
  "providers": {}
}
```
