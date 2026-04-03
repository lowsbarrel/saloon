# Saloon

A privacy-focused, lightweight, decentralized voice/video communication platform. Think Discord without the tracking, accounts, or bloat.

## What it does

- **Voice & video** — Peer-to-peer audio/video via WebRTC (mesh topology, Opus codec)
- **Screen sharing** — Share any screen or window, including system audio
- **Encrypted chat** — End-to-end encrypted text messages (X25519 + XChaCha20-Poly1305)
- **Ephemeral** — No accounts, no databases, no logs. Everything lives in memory and disappears when you leave
- **Self-hostable** — Anyone can run a server. Users connect by entering the server URL

## Architecture

| Layer | Technology |
| ----- | ---------- |
| Server | Python -- FastAPI, WebSockets, WebRTC signaling |
| Client | Tauri (Rust) + SvelteKit + TypeScript |
| Media | WebRTC peer-to-peer |
| Encryption | NaCl / libsodium (E2EE), DTLS-SRTP |

The server is a **signaling relay only** — it negotiates WebRTC connections and forwards encrypted chat. It never sees plaintext messages or media streams.

## Project structure

```text
saloon/
├── app/                    # Tauri + SvelteKit desktop client
│   ├── src/
│   │   ├── lib/            # Stores, API client, WebRTC, crypto, components
│   │   └── routes/         # SvelteKit pages (connect, username, lobby, channel)
│   └── src-tauri/          # Rust shell
├── server/                 # Python FastAPI server
│   ├── main.py             # Entry point
│   ├── src/                # Channels, signaling, users, crypto, rate limiting
│   └── .docker/            # Dockerfile + compose.yml
└── docs/
    └── PROJECT_IDEA.md     # Full design document
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
3. **Lobby** — Browse public channels or create/join private ones (password-protected)
4. **Channel** — Voice chat is always on (toggle mute), screen share and text chat are optional. Leave to go back to the lobby

Usernames are session-scoped. Private channels auto-delete when the last user leaves.

## License

MIT
