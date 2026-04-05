# Deploying Saloon

Saloon consists of two services:

- **saloon** — FastAPI server (HTTP + WebSocket signaling)
- **coturn** — STUN/TURN relay server (UDP/TCP, required for WebRTC)

Pre-built server images are published to GHCR on every release:

```bash
docker pull ghcr.io/lowsbarrel/saloon/server:latest
```

---

## Local Development

### Prerequisites

- Docker & Docker Compose

### Steps

1. **Create your `.env` file:**

   ```bash
   cd server/.docker
   cp .env.example .env
   ```

   The defaults work out of the box for local dev. No changes needed.

2. **Start both services:**

   ```bash
   docker compose up --build
   ```

   This uses `compose.yml` which mounts `coturn/turnserver.dev.conf` and
   exposes a small relay port range (49152–49252).

3. **Verify:**

   - API: `http://localhost:8000/health`
   - STUN/TURN: coturn listens on `localhost:3478`

4. **Connect the app:**

   Point the Tauri/SvelteKit app at `http://localhost:8000`.

---

## Production Deployment

### Architecture Overview

```text
Client (Tauri app)
  │
  ├── HTTPS ──▶ Reverse Proxy (Caddy / Cloudflare Tunnel)
  │                  │
  │                  ▼
  │              saloon:8000  (API + WebSocket)
  │
  └── UDP/TCP ──▶ coturn:3478 + relay ports  (STUN/TURN)
```

The API server **must** sit behind a reverse proxy that terminates TLS.
coturn handles its own TLS (TURNS) and is exposed directly.

### 1. Generate secrets

```bash
# TURN shared secret (must match in .env AND turnserver.prod.conf)
TURN_SECRET=$(openssl rand -hex 32)

# Auth token signing secret
AUTH_SECRET=$(openssl rand -hex 32)

echo "TURN_SECRET=$TURN_SECRET"
echo "AUTH_SECRET=$AUTH_SECRET"
```

### 2. Configure coturn

Edit `coturn/turnserver.prod.conf`:

```conf
# Set your server's public IP
external-ip=YOUR_PUBLIC_IP

# Set the TURN shared secret (same value as SALOON_TURN_SECRET in .env)
static-auth-secret=YOUR_TURN_SECRET_HERE

# TLS (optional but recommended) — provide cert paths
cert=/etc/coturn/certs/turn.pem
pkey=/etc/coturn/certs/turn.key
```

If using TURNS with TLS, mount your certificates into the coturn container
by adding a volume in a `compose.override.yml`:

```yaml
services:
  coturn:
    volumes:
      - /etc/letsencrypt/live/turn.example.com:/etc/coturn/certs:ro
```

### 3. Configure the `.env` file

```bash
cd server/.docker
cp .env.example .env
```

Set the following values:

```env
SALOON_AUTH_SECRET=<AUTH_SECRET from step 1>
SALOON_TURN_SECRET=<TURN_SECRET from step 1>
SALOON_COTURN_HOST=<your public IP or turn.example.com>
SALOON_TRUSTED_PROXY=true
SALOON_LOG_LEVEL=warning
```

### 4. Start with the production override

```bash
docker compose -f compose.yml -f compose.prod.yml up -d --build
```

This switches coturn to `network_mode: host` for direct UDP access
(no Docker NAT overhead) and uses `turnserver.prod.conf` with all
private IP ranges blocked.

### 5. Firewall rules

Open these ports on your server:

| Port | Protocol | Service |
| ---- | -------- | ------- |
| 80, 443 | TCP | Reverse proxy (Caddy / Cloudflare Tunnel) |
| 3478 | UDP + TCP | STUN/TURN |
| 5349 | TCP | TURNS (TLS) — if enabled |
| 49152–65535 | UDP | TURN relay range |

**Do NOT expose port 8000 directly.** All API traffic should go through
the reverse proxy.

### 6. Reverse proxy setup

The API server listens on `127.0.0.1:8000` and must be fronted by a
reverse proxy that handles TLS and forwards `X-Forwarded-For`.

#### Option A: Caddy (automatic HTTPS)

```text
# /etc/caddy/Caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Caddy auto-provisions TLS certificates via Let's Encrypt. That's it.

#### Option B: Cloudflare Tunnel

If you don't want to expose any ports at all for the API:

```bash
cloudflared tunnel create saloon
cloudflared tunnel route dns saloon api.example.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: saloon
ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:8000
  - service: http_status:404
```

```bash
cloudflared tunnel run saloon
```

> **Note:** Cloudflare Tunnel only covers HTTP/WebSocket traffic (the API).
> coturn still needs direct port access for UDP — it cannot go through
> a Cloudflare Tunnel.

### 7. Connect the app

Point the Tauri/SvelteKit app at `https://api.example.com`.

---

## Cloud Provider Notes

### VPS (Hetzner, Vultr, DigitalOcean, etc.)

The simplest path. Follow the production steps above on any VPS with
Docker installed. You get full control over ports and networking.

**Minimum requirements:** 1 vCPU, 1 GB RAM, any Linux distro.

### Container Platforms (Bunny Magic Containers, Fly.io, Railway, etc.)

These platforms run containers for you but have different networking
constraints:

- **API container** — works on any platform that supports HTTP + WebSocket.
  Use a CDN/HTTP endpoint with sticky sessions enabled.
- **coturn container** — needs **direct UDP port exposure** (STUN/TURN).
  Use an Anycast/TCP+UDP endpoint if the platform supports it, otherwise
  host coturn on a separate VPS.

Set `SALOON_COTURN_HOST` to the public IP/hostname where coturn is reachable.

### Scaling Considerations

Saloon uses **in-memory state** (channels, users, rate limiters). Running
multiple API instances means users on different instances won't share
channels. To scale horizontally, you'd need to move state to a shared
store like Redis. For moderate traffic, a single instance is fine.

---

## CORS

The server allows all origins by default (`SALOON_CORS_ORIGINS=["*"]`).
For production, restrict this to your client domains:

```env
SALOON_CORS_ORIGINS=["https://saloon.lowsbarrel.com", "https://yourdomain.com"]
```

This is required for the web client (GitHub Pages) to communicate with
your server. Desktop (Tauri) clients are not affected by CORS.
