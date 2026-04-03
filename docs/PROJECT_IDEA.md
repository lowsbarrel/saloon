# Saloon — Project Outline

A privacy-focused, lightweight, decentralized voice/video communication platform. Discord alternative with screen sharing, bidirectional audio, and a channel system.

---

## Architecture

### Stack

| Layer | Technology |
| ----- | ---------- |
| Backend | Python — FastAPI, WebSockets, WebRTC signaling |
| Frontend | Tauri (Rust shell) + SvelteKit + TypeScript |
| Media | WebRTC (peer-to-peer audio/video/screen) |
| Encryption | End-to-end encryption (E2EE) via NaCl/libsodium |

### Design Principles

- **Privacy first** — Zero logs, zero persistence, ephemeral everything. All messages encrypted with the highest standards. Nothing touches disk on the server.
- **Lightweight** — Minimal resource usage on both client and server. No bloated Electron — Tauri keeps the binary small.
- **Easy to use** — Simple UI, no account registration, no email, no phone number.
- **Decentralized** — Anyone can host a server. Users choose which server to connect to by entering its URL.

---

## Server (FastAPI)

### Responsibilities

1. **Signaling** — WebSocket-based signaling server for WebRTC peer connection negotiation (SDP offers/answers, ICE candidates).
2. **Channel management** — Create, list, join, leave channels. Track connected users per channel.
3. **Chat relay** — Relay encrypted chat messages between users in a channel via WebSocket.
4. **Username generation** — Generate unique usernames from user-chosen prefix + random verb + random noun.

### Endpoints

#### REST

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/channels` | List all public channels with user previews |
| `POST` | `/channels` | Create a new channel (public or private) |
| `POST` | `/channels/{id}/join` | Join a channel (password required for private) |
| `POST` | `/channels/{id}/leave` | Leave a channel |
| `POST` | `/username` | Generate a unique username from a prefix |

#### WebSocket

| Path                       | Description                                |
| -------------------------- | ------------------------------------------ |
| `ws://.../ws/{channel_id}` | Per-channel WebSocket for signaling + chat |

### Data Model (In-Memory Only)

```text
Channel:
  id: str (UUID)
  name: str
  is_private: bool
  password_hash: str | None  (argon2 hash, only for private channels)
  users: dict[str, User]
  created_at: datetime

User:
  id: str (UUID, session-scoped)
  username: str  (prefix + verb + noun)
  channel_id: str | None
  websocket: WebSocket
```

**No database. No files. Everything lives in memory and dies when the server stops or the last user leaves a private channel.**

### Zero-Log Policy

- No request logging.
- No IP address storage.
- No message persistence — messages are relayed and forgotten.
- No analytics, no telemetry.

### Private Channel Lifecycle

1. User creates a private channel with a password.
2. Password is hashed (argon2) and stored in-memory.
3. Other users join by providing the correct password.
4. When the last user leaves, the channel is immediately deleted from memory.

---

## Client (Tauri + SvelteKit)

### Views / Pages

1. **Connect** — Input field for server URL. Connect button. Validates URL is reachable.
2. **Set Username** — Input prefix (alphanumeric, 3–16 chars). Server returns full generated username (prefix + verb + noun). Display it. Option to re-roll.
3. **Lobby** — List of public channels with user count and user list preview. Button to create a channel. Button to join a private channel by ID + password.
4. **Channel (Voice/Video Room)** — The main experience:
   - Audio controls (mute self, per-user volume sliders)
   - Screen sharing controls (pick screen/window, start/stop, share audio)
   - User list with status indicators (muted, sharing screen)
   - Chat panel (text messages within the channel)
   - Leave button

### UI Flow

```text
[Connect to Server] → [Choose Username] → [Lobby]
                                              ├── Create Channel (public/private)
                                              ├── Join Public Channel
                                              └── Join Private Channel (enter password)
                                                    ↓
                                              [Channel Room]
                                                ├── Voice chat (always on, toggle mute)
                                                ├── Screen share (optional)
                                                ├── Text chat
                                                └── Leave → back to [Lobby]
```

---

## WebRTC Media

### Audio

- Bidirectional audio via WebRTC peer connections.
- Mesh topology for small channels (each peer connects to every other peer).
- Opus codec for low-latency audio.
- Each user can:
  - **Mute/unmute** themselves (stops sending audio track).
  - **Adjust volume** of any other user locally (gain node on received audio track).

### Screen Sharing

- Uses `getDisplayMedia()` API via Tauri's webview.
- User picks which screen or window to share.
- Supports all resolutions and frame rates (no artificial caps — let WebRTC adapt).
- Audio sharing included (system audio capture via `getDisplayMedia({ audio: true })`).
- Only one screen share active per user at a time.
- Other users receive the screen share as a video track — displayed in the channel view.
- User can **stop sharing** at any time.

### Signaling Flow

```text
User A joins channel
  → Server assigns peer list
  → For each existing peer:
      A creates RTCPeerConnection
      A creates offer → sends via WebSocket → Server relays to peer
      Peer creates answer → sends via WebSocket → Server relays to A
      ICE candidates exchanged via WebSocket
  → Media flows P2P (server not in the media path)
```

---

## Encryption

### Transport

- All WebSocket connections over WSS (TLS).
- All REST calls over HTTPS.
- WebRTC DTLS-SRTP for media encryption (built into WebRTC, mandatory).

### Chat Messages (E2EE)

- On channel join, a shared symmetric key is derived using a key exchange (X25519 Diffie-Hellman between peers).
- Messages encrypted with XChaCha20-Poly1305 before sending.
- Server only relays opaque ciphertext — cannot read messages.
- Key rotation on user join/leave to maintain forward secrecy.

### Private Channel Passwords

- Passwords hashed server-side with Argon2id before comparison.
- Raw passwords never stored, never logged.

---

## Username System

### Generation

1. User chooses a **prefix** (3–16 alphanumeric characters, lowercase).
2. Server appends a random **verb** + random **noun** from curated word lists.
3. Result: `{prefix}{verb}{noun}` — e.g., `lowsbarrelislame`, `cosmicrunswind`.
4. Server checks uniqueness among currently connected users.
5. If collision, re-roll verb+noun (up to N retries).

### Rules

- Username is session-scoped — lost on disconnect.
- Changing prefix generates an entirely new username.
- No persistence — no "claiming" a username.

---

## Chat System

### Features

- Real-time text chat per channel via WebSocket.
- Messages are E2EE (see Encryption section).
- Messages are ephemeral — not stored server-side.

### Input Validation (Server-Side)

| Rule | Constraint |
| ---- | ---------- |
| Max length | 2000 characters |
| Min length | 1 character (no empty messages) |
| Content | Strip leading/trailing whitespace. Reject if empty after strip. |
| Rate limit | Max 5 messages per 5 seconds per user |
| Encoding | UTF-8 only. Reject invalid byte sequences. |
| HTML/Script | No rendering of HTML — plain text only. Client escapes all output. |

### Input Validation (Client-Side)

- Mirror server-side constraints for instant feedback.
- Prevent sending while rate-limited.
- Escape all rendered message text to prevent XSS.

---

## Security Considerations

| Threat | Mitigation |
| ------ | ---------- |
| Eavesdropping | DTLS-SRTP for media, WSS for signaling, E2EE for chat |
| Man-in-the-middle | TLS certificate validation, DTLS fingerprint verification |
| XSS | No HTML rendering in chat, strict output escaping |
| Injection | Input validation on all user-supplied data |
| Brute-force (private channels) | Argon2id hashing, rate limiting on join attempts |
| DoS | WebSocket connection limits, message rate limiting |
| Data retention | Zero persistence — all data in-memory, ephemeral |
| Server compromise | E2EE means server never has plaintext messages or media |

---

## Project Structure

```text
saloon/
├── app/saloon/                # Tauri + SvelteKit desktop client
│   ├── src/
│   │   ├── app.html
│   │   ├── routes/            # SvelteKit pages
│   │   │   ├── +layout.ts
│   │   │   ├── +page.svelte          # Connect page
│   │   │   ├── username/+page.svelte # Username selection
│   │   │   ├── lobby/+page.svelte    # Channel browser
│   │   │   └── channel/[id]/+page.svelte  # Voice/video room
│   │   └── lib/
│   │       ├── stores/        # Svelte stores (connection state, user, channel)
│   │       ├── webrtc/        # WebRTC peer management, signaling client
│   │       ├── crypto/        # E2EE key exchange, message encryption
│   │       ├── api/           # REST + WebSocket client helpers
│   │       └── components/    # Reusable UI components
│   ├── src-tauri/             # Rust backend for Tauri
│   │   └── src/
│   ├── static/
│   ├── svelte.config.js
│   ├── vite.config.js
│   └── package.json
├── server/                    # Python FastAPI server
│   ├── main.py                # Entry point
│   ├── channels.py            # Channel CRUD, in-memory store
│   ├── users.py               # Username generation, user management
│   ├── signaling.py           # WebSocket signaling for WebRTC
│   ├── chat.py                # Chat message relay + validation
│   ├── crypto.py              # Password hashing (argon2)
│   ├── models.py              # Pydantic models
│   ├── wordlists.py           # Verb/noun lists for username generation
│   ├── rate_limit.py          # Rate limiting utilities
│   ├── pyproject.toml
│   └── README.md
└── docs/
    └── PROJECT_IDEA.md        # This file
```

---

## Dependencies

### Server

| Package | Purpose |
| ------- | ------- |
| `fastapi` | HTTP + WebSocket framework |
| `uvicorn` | ASGI server |
| `argon2-cffi` | Password hashing |
| `pydantic` | Data validation / models |

### Client

| Package | Purpose |
| ------- | ------- |
| `@tauri-apps/api` | Tauri runtime bindings |
| `svelte` / `sveltekit` | UI framework + routing |
| `tweetnacl` / `libsodium-wrappers` | E2EE (X25519, XChaCha20-Poly1305) |

---

## MVP Milestones

1. **Server foundation** — FastAPI app, in-memory channel store, REST endpoints for channel CRUD, WebSocket connection handling.
2. **Client foundation** — Tauri app boots, connect page, username page, lobby page with channel list.
3. **Signaling** — WebSocket signaling for WebRTC peer negotiation. Peers can establish connections.
4. **Audio** — Bidirectional audio via WebRTC. Mute/unmute. Per-user volume control.
5. **Screen sharing** — Screen/window picker, share with audio, stop sharing.
6. **Chat** — Encrypted text chat per channel with input validation.
7. **Private channels** — Password-protected channels, auto-delete on empty.
8. **Polish** — UI/UX refinement, error handling, connection recovery.
