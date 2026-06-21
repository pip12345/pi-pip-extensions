# pi-provider-proxy

Provider relay map for Pi.

This extension has two explicit maps:

```text
Pi provider id -> provider API baseUrl reachable from the Pi process
Pi provider id -> provider auth relay URL reachable from the Pi process
```

It does **not** start SSH, run Caddy/nginx, store credentials, replace provider auth, or implement provider protocols. Pi still uses the real provider implementation, real model list, and normal `/login` or API-key auth. This extension only changes where Pi sends provider API traffic and, optionally, Pi-side OAuth token/device HTTP traffic.

Default state is disabled.

## The links

Keep the pieces separate:

```text
1. Relay routes
   /openai/*          -> https://api.openai.com/*
   /chatgpt/*         -> https://chatgpt.com/*
   /anthropic/*       -> https://api.anthropic.com/*
   /openai-auth/*     -> https://auth.openai.com/*
   /anthropic-auth/*  -> https://platform.claude.com/*

2. Transport
   ssh -L local:9898 -> server:9898

3. Pi API map
   openai        -> <relay>/openai/v1
   openai-codex -> <relay>/chatgpt/backend-api
   anthropic     -> <relay>/anthropic

4. Pi auth map, only when /login or token refresh is blocked
   openai-codex -> <relay>/openai-auth
   anthropic     -> <relay>/anthropic-auth
```

Each link should be testable with plain tools. If a link is broken, fix that link; the extension will not hide it.

## Relay address visible from Pi

`<relay>` means the HTTP base URL reachable from the Pi process, not necessarily from your shell.

```text
Pi native / same network namespace:  http://127.0.0.1:9898
Pi in Docker, tunnel on host:        http://172.17.0.1:9898
```

Use the Docker host gateway only when Pi is inside Docker and the SSH tunnel is running on the host.

## Provider API baseUrls

Configure these values in Pi for the relay contract above:

```text
openai        <relay>/openai/v1
openai-codex <relay>/chatgpt/backend-api
anthropic     <relay>/anthropic
```

Example for Pi inside Docker with the tunnel on the host:

```text
/proxy add openai http://172.17.0.1:9898/openai/v1
/proxy add openai-codex http://172.17.0.1:9898/chatgpt/backend-api
/proxy add anthropic http://172.17.0.1:9898/anthropic
/proxy on
```

If your relay exposes different prefixes, configure the actual provider `baseUrl` visible through that relay. The extension validates URLs and canonicalizes trailing slashes before storing/registering them.

## Provider auth relay URLs

API-key providers do not need auth relay URLs. `/login` just stores a key locally.

OAuth/subscription providers may need auth relay URLs because Pi must exchange and refresh tokens. Configure these only if `/login` or token refresh cannot reach the provider auth host directly:

```text
openai-codex <relay>/openai-auth
anthropic     <relay>/anthropic-auth
```

Example:

```text
/proxy auth add openai-codex http://172.17.0.1:9898/openai-auth
/proxy auth add anthropic http://172.17.0.1:9898/anthropic-auth
/proxy on
```

Important: auth relay URLs are for Pi-side token/device HTTP calls. Browser login pages may still open provider web URLs such as `auth.openai.com` or `claude.ai`. Browser-page reverse proxying is a separate problem and may hit cookie/Cloudflare/origin issues.

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

  handle /openai-auth/* {
    uri strip_prefix /openai-auth
    reverse_proxy https://auth.openai.com {
      header_up Host auth.openai.com
      flush_interval -1
    }
  }

  handle /anthropic-auth/* {
    uri strip_prefix /anthropic-auth
    reverse_proxy https://platform.claude.com {
      header_up Host platform.claude.com
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

Then test provider paths where possible:

```bash
curl -i http://172.17.0.1:9898/openai/v1/models
curl -i http://172.17.0.1:9898/openai-auth/oauth/token
```

Without auth or with the wrong method, provider routes may return `401`, `404`, or `405`; that still proves routing if the response is from the upstream provider. HTML from Cloudflare means you reached a Cloudflare-protected upstream page, not a JSON API response.

### 4. Map Pi providers

```text
/proxy add openai-codex http://172.17.0.1:9898/chatgpt/backend-api
/proxy auth add openai-codex http://172.17.0.1:9898/openai-auth
/proxy on
/proxy status
```

## Commands

```text
/proxy                              Show status, commands, and SSH tunnel hint
/proxy status                       Show current provider API/auth relay maps
/proxy setup                        Add or update provider API baseUrls interactively
/proxy add <provider> <url>         Add or update one provider API baseUrl
/proxy remove <provider>            Remove one provider API baseUrl
/proxy auth add <provider> <url>    Add or update one provider auth relay URL
/proxy auth remove <provider>       Remove one provider auth relay URL
/proxy on                           Enable configured maps
/proxy off                          Disable configured maps and restore providers
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
  },
  "auth": {
    "openai-codex": "http://172.17.0.1:9898/openai-auth",
    "anthropic": "http://172.17.0.1:9898/anthropic-auth"
  }
}
```

Default state:

```json
{
  "enabled": false,
  "providers": {},
  "auth": {}
}
```
