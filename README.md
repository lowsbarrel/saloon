# Saloon

A privacy-focused, lightweight, decentralized voice/video communication platform. Think Discord without the tracking, accounts, or bloat.

**Web app:** [saloon.lowsbarrel.com](https://saloon.lowsbarrel.com) · **Downloads:** [GitHub Releases](https://github.com/lowsbarrel/saloon/releases/latest) · **Docker:** `ghcr.io/lowsbarrel/saloon/server`

## What it does

- **Voice chat** — Peer-to-peer audio via WebRTC (full mesh, Opus codec)
- **Webcam** — Toggle camera on/off, switch between video devices, per-user volume control
- **Screen sharing** — Share any screen or window with system audio, separate volume control
- **Text chat** — End-to-end encrypted via pairwise X25519 + XSalsa20-Poly1305 (tweetnacl). The server only relays opaque ciphertext
- **Ephemeral** — No accounts, no databases, no logs. Everything lives in memory and disappears when you leave
- **Self-hostable** — Anyone can run a server. Users connect by entering the server URL
- **Auto-updates** — Desktop app checks for updates on launch (Tauri updater with signed artifacts)
- **Cross-platform** — Native desktop (macOS, Linux, Windows) and web browser

## Architecture

| Layer | Technology |
| ----- | ---------- |
| Server | Python — FastAPI, WebSockets, WebRTC signaling |
| Client | Tauri (Rust) + SvelteKit + TypeScript |
| Media | WebRTC peer-to-peer (DTLS-SRTP) |
| Chat encryption | tweetnacl — pairwise X25519 ECDH + XSalsa20-Poly1305 |
| NAT traversal | coturn (STUN/TURN) |

The server is a **signaling relay only** — it negotiates WebRTC connections and forwards encrypted chat ciphertext. It never sees media streams or plaintext messages. Audio and video flow directly between peers (or through the TURN relay when direct connections aren't possible).

## Project structure

```text
saloon/
├── app/                    # Tauri + SvelteKit desktop & web client
│   ├── src/
│   │   ├── lib/            # Stores, API client, WebRTC, signaling, E2EE crypto
│   │   └── routes/         # SvelteKit pages (connect, username, lobby, channel)
│   └── src-tauri/          # Rust shell (updater, process plugins)
├── server/                 # Python FastAPI server
│   ├── main.py             # Entry point
│   ├── src/                # Channels, signaling, users, rate limiting
│   └── .docker/            # Dockerfile, compose.yml, coturn config, DEPLOY.md
├── .github/workflows/      # CI + Release (Tauri builds, Docker, GitHub Pages)
└── docs/
    └── PROJECT_IDEA.md     # Original design document
```

## Prerequisites

- **Server**: Python 3.13+, [uv](https://docs.astral.sh/uv/)
- **Client**: Node.js, [pnpm](https://pnpm.io/), Rust toolchain, [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

## Getting started

### Server

```bash
cd server
cp .env.example .env       # adjust settings if needed
uv sync
uv run python main.py
```

The server starts on `http://0.0.0.0:8000` by default. Configuration is via `SALOON_*` environment variables — see `.env.example` for all options.

### Server (Docker)

```bash
cd server/.docker
cp .env.example .env
docker compose up --build
```

### Client

```bash
cd app
pnpm install
pnpm tauri dev
```

## How it works

1. **Connect** — Enter a server URL
2. **Choose a username** — Pick a prefix, the server appends a random verb + noun (e.g. `cosmicrunswind`)
3. **Lobby** — Browse public channels or create/join private ones by unique name (password-protected)
4. **Channel** — Voice chat is always on (toggle mute). Toggle camera, share your screen, and use text chat. Right-click any user or video tile to adjust their volume. Leave to go back to the lobby

All media (audio, video, screen) flows peer-to-peer via WebRTC. The server only relays signaling messages and encrypted chat ciphertext. Usernames are session-scoped. Channel names are normalized to lowercase URL-safe slugs and must be unique. Private channels auto-delete when the last user leaves.

## Security

- **E2EE chat** — Each peer generates an X25519 keypair on channel join. Messages are encrypted pairwise with XSalsa20-Poly1305 (nacl.box). The server never sees plaintext.
- **Chat history** — When a new peer joins, the lowest-ID peer re-encrypts recent messages for the newcomer. History is capped at 50 messages.
- **Media encryption** — WebRTC DTLS-SRTP (mandatory, built-in). Peer-to-peer, server has no access.
- **Private channels** — Passwords hashed with Argon2id. Raw passwords never stored.
- **CSP** — Tauri CSP restricts connections to `localhost` (dev) and `https:`/`wss:` (production).
- **Rate limiting** — Server-side rate limiting with TTL-based garbage collection.
- **WS idle timeout** — Idle WebSocket connections are closed after 5 minutes.

## Releases

Releases are automated via GitHub Actions when a version tag is pushed:

1. **Server** — Docker image pushed to `ghcr.io/lowsbarrel/saloon/server`
2. **Desktop** — Signed Tauri builds for macOS (ARM + Intel), Linux (.deb, .AppImage), Windows (.exe, .msi)
3. **Web** — Static SvelteKit build deployed to GitHub Pages at [saloon.lowsbarrel.com](https://saloon.lowsbarrel.com)
4. **Updater** — `latest.json` manifest for Tauri auto-update

To create a release:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## Deployment

For Docker-based deployment (dev and production) with coturn, see [`server/.docker/DEPLOY.md`](server/.docker/DEPLOY.md).

## License

[AGPL-3.0](LICENSE)
