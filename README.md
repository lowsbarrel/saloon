# Saloon

A privacy-focused, lightweight, decentralized voice/video communication platform. Think Discord without the tracking, accounts, or bloat.

## What it does

- **Voice chat** — Peer-to-peer audio via WebRTC (full mesh, Opus codec)
- **Webcam** — Toggle camera on/off, switch between video devices, per-user volume control
- **Screen sharing** — Share any screen or window with system audio, separate volume control
- **Text chat** — Real-time chat in channels
- **Ephemeral** — No accounts, no databases, no logs. Everything lives in memory and disappears when you leave
- **Self-hostable** — Anyone can run a server. Users connect by entering the server URL

## Architecture

| Layer | Technology |
| ----- | ---------- |
| Server | Python — FastAPI, WebSockets, WebRTC signaling |
| Client | Tauri (Rust) + SvelteKit + TypeScript |
| Media | WebRTC peer-to-peer (DTLS-SRTP) |
| NAT traversal | coturn (STUN/TURN) |

The server is a **signaling relay only** — it negotiates WebRTC connections and forwards chat messages. It never sees media streams. Audio and video flow directly between peers (or through the TURN relay when direct connections aren't possible).

## Project structure

```text
saloon/
├── app/                    # Tauri + SvelteKit desktop client
│   ├── src/
│   │   ├── lib/            # Stores, API client, WebRTC, signaling, components
│   │   └── routes/         # SvelteKit pages (connect, username, lobby, channel)
│   └── src-tauri/          # Rust shell
├── server/                 # Python FastAPI server
│   ├── main.py             # Entry point
│   ├── src/                # Channels, signaling, users, rate limiting
│   └── .docker/            # Dockerfile, compose.yml, coturn config, DEPLOY.md
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

All media (audio, video, screen) flows peer-to-peer via WebRTC. The server only relays signaling messages and chat. Usernames are session-scoped. Channel names are normalized to lowercase URL-safe slugs and must be unique. Private channels auto-delete when the last user leaves.

## Deployment

For Docker-based deployment (dev and production) with coturn, see [`server/.docker/DEPLOY.md`](server/.docker/DEPLOY.md).

## License

[AGPL-3.0](LICENSE)
