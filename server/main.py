"""Saloon — privacy-focused voice/video communication server."""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from uuid import uuid4

import uvicorn
from fastapi import (
    FastAPI,
    Header,
    Request,
    WebSocket,
    WebSocketDisconnect,
    HTTPException,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from src.models import (
    CreateChannelRequest,
    JoinChannelRequest,
    UsernameRequest,
    UsernameResponse,
    ChannelInfo,
    IceServersResponse,
    User,
)
from src.channels import ChannelStore
from src.config import settings
from src.users import generate_username
from src.signaling import handle_ws, _send_json
from src.models import WSMessage, WSMessageType
from src.rate_limit import RateLimiter
from src.auth import create_token, verify_token

# ── Logging — minimal, no PII ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("saloon")

# ── Global state ───────────────────────────────────────────────────────────
store = ChannelStore()
# Track active usernames for uniqueness: username -> user_id
_active_usernames: dict[str, str] = {}
_active_users: dict[str, User] = {}  # user_id -> User
# Lobby WebSocket clients for real-time channel list updates
_lobby_clients: set[WebSocket] = set()

# Rate limiters (keyed on client IP)
_join_limiter = RateLimiter(
    max_calls=settings.rate_join_max, window_seconds=settings.rate_join_window
)
_username_limiter = RateLimiter(
    max_calls=settings.rate_username_max, window_seconds=settings.rate_username_window
)
_create_channel_limiter = RateLimiter(
    max_calls=settings.rate_create_channel_max,
    window_seconds=settings.rate_create_channel_window,
)
_ws_connection_limiter = RateLimiter(
    max_calls=settings.rate_ws_max, window_seconds=settings.rate_ws_window
)

_all_limiters = [
    _join_limiter,
    _username_limiter,
    _create_channel_limiter,
    _ws_connection_limiter,
]


# ── Helpers ────────────────────────────────────────────────────────────────


def _get_client_ip(request: Request) -> str:
    """Extract client IP, respecting X-Forwarded-For when behind a trusted proxy."""
    if settings.trusted_proxy:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # First IP in the chain is the real client
            return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Cannot determine client address",
    )


def _require_user(authorization: str) -> User:
    """Validate Authorization header and return the User, or raise 401."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid authorization",
        )
    token = authorization[7:]
    user_id = verify_token(token)
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    user = _active_users.get(user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown user",
        )
    return user


# ── Lobby broadcast ────────────────────────────────────────────────────────


async def _broadcast_lobby():
    """Push updated channel list to all connected lobby WebSocket clients."""
    if not _lobby_clients:
        return
    data = [ch.model_dump() for ch in await store.list_public()]
    msg = {"type": "channels", "payload": data}
    dead: list[WebSocket] = []
    for ws in list(_lobby_clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _lobby_clients.discard(ws)


# ── Background cleanup tasks ──────────────────────────────────────────────

_cleanup_tasks: list[asyncio.Task] = []


async def _gc_rate_limiters():
    """Periodically garbage-collect stale rate limiter entries."""
    while True:
        await asyncio.sleep(settings.rate_gc_interval)
        for limiter in _all_limiters:
            limiter.gc()


async def _gc_stale_users():
    """Remove users who registered but never connected via WebSocket."""
    while True:
        await asyncio.sleep(settings.user_ttl)
        now = time.time()
        stale = [
            uid
            for uid, user in _active_users.items()
            if user.websocket is None
            and user.peer_id is None
            and not user.keep_alive
            and (now - user.created_at) > settings.user_ttl
        ]
        for uid in stale:
            user = _active_users.pop(uid, None)
            if user:
                _active_usernames.pop(user.username, None)


# ── App lifecycle ──────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.warning("Saloon server starting")
    _cleanup_tasks.append(asyncio.create_task(_gc_rate_limiters()))
    _cleanup_tasks.append(asyncio.create_task(_gc_stale_users()))
    yield
    logger.warning("Saloon server shutting down")
    for task in _cleanup_tasks:
        task.cancel()
    _cleanup_tasks.clear()
    _active_usernames.clear()
    _active_users.clear()
    # Close all lobby sockets
    for ws in list(_lobby_clients):
        try:
            await ws.close()
        except Exception:
            pass
    _lobby_clients.clear()


app = FastAPI(
    title="Saloon",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

# CORS — allow Tauri webview origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Security headers ──────────────────────────────────────────────────────


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = (
            "microphone=(self), camera=(self), display-capture=(self)"
        )
        return response


app.add_middleware(SecurityHeadersMiddleware)


# ── Health ─────────────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Username ───────────────────────────────────────────────────────────────


@app.post("/username", response_model=UsernameResponse)
async def create_username(req: UsernameRequest, request: Request):
    client_ip = _get_client_ip(request)
    if not _username_limiter.is_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many username requests. Try again later.",
        )

    existing = set(_active_usernames.keys())
    username = generate_username(req.prefix, existing)

    if username is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Could not generate a unique username. Try a different prefix.",
        )

    user_id = uuid4().hex
    user = User(id=user_id, username=username)
    _active_usernames[username] = user_id
    _active_users[user_id] = user

    token = create_token(user_id)
    return UsernameResponse(user_id=user_id, username=username, token=token)


# ── User validation ────────────────────────────────────────────────────────


@app.get("/users/check")
async def check_user(authorization: str = Header("")):
    user = _require_user(authorization)
    return {"valid": True, "user_id": user.id, "username": user.username}


# ── Channels ───────────────────────────────────────────────────────────────


@app.get("/ice-servers", response_model=IceServersResponse)
async def get_ice_servers(authorization: str = Header("")):
    _require_user(authorization)
    host = settings.coturn_host
    port = settings.coturn_port
    servers: list[dict] = [
        {"urls": f"stun:{host}:{port}"},
        {
            "urls": [
                f"turn:{host}:{port}?transport=udp",
                f"turn:{host}:{port}?transport=tcp",
            ],
            "username": settings.turn_username,
            "credential": settings.turn_credential,
        },
    ]
    return IceServersResponse(ice_servers=servers)


@app.get("/channels", response_model=list[ChannelInfo])
async def list_channels(authorization: str = Header("")):
    _require_user(authorization)
    return await store.list_public()


@app.post("/channels", response_model=ChannelInfo, status_code=status.HTTP_201_CREATED)
async def create_channel(
    req: CreateChannelRequest, request: Request, authorization: str = Header("")
):
    _require_user(authorization)
    client_ip = _get_client_ip(request)
    if not _create_channel_limiter.is_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many channel creations. Try again later.",
        )

    result = await store.create(req)
    if isinstance(result, str):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=result
        )
    await _broadcast_lobby()
    return result


@app.post("/channels/{channel_id}/join", response_model=ChannelInfo)
async def join_channel(
    channel_id: str,
    req: JoinChannelRequest,
    request: Request,
    authorization: str = Header(""),
):
    user = _require_user(authorization)

    client_ip = _get_client_ip(request)
    if not _join_limiter.is_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many join attempts",
        )

    result = await store.join(channel_id, user, req.password)
    if isinstance(result, str):
        code = (
            status.HTTP_404_NOT_FOUND
            if "not found" in result.lower()
            else status.HTTP_403_FORBIDDEN
        )
        raise HTTPException(status_code=code, detail=result)

    await _broadcast_lobby()
    return result


@app.post("/channels/{channel_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_channel(channel_id: str, authorization: str = Header("")):
    user = _require_user(authorization)
    user_id = user.id

    # Capture peer_id before cleanup clears it
    peer_id = user.peer_id

    # Notify remaining peers BEFORE removing the user from the channel
    remaining = await store.get_peers(channel_id, user_id)
    if peer_id and remaining:
        leave_msg = WSMessage(
            type=WSMessageType.PEER_LEFT, sender_id=peer_id
        ).model_dump()
        for peer in remaining:
            await _send_json(peer.websocket, leave_msg)

    # Mark user as intentionally leaving so the WS finally-block
    # won't delete them from _active_users (they may rejoin from lobby).
    user.keep_alive = True
    # Clear websocket so the WS finally-block won't double-leave after a rejoin
    user.websocket = None
    await store.leave(channel_id, user_id)
    await _broadcast_lobby()


# ── Lobby WebSocket ────────────────────────────────────────────────────────


@app.websocket("/ws/lobby")
async def lobby_websocket(ws: WebSocket, token: str = ""):
    user_id = verify_token(token) if token else None
    if not user_id or user_id not in _active_users:
        await ws.close(code=4001, reason="Invalid or expired token")
        return

    await ws.accept()
    _lobby_clients.add(ws)
    try:
        # Push current channel list immediately
        data = [ch.model_dump() for ch in await store.list_public()]
        await ws.send_json({"type": "channels", "payload": data})
        # Keep alive — client may send pings; we just wait for disconnect
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _lobby_clients.discard(ws)


# ── Channel WebSocket ──────────────────────────────────────────────────────


@app.websocket("/ws/{channel_id}")
async def websocket_endpoint(ws: WebSocket, channel_id: str, token: str = ""):
    # Authenticate via query param token (signed HMAC — not a raw user_id)
    user_id = verify_token(token) if token else None
    if not user_id or user_id not in _active_users:
        await ws.close(code=4001, reason="Invalid or expired token")
        return

    if not _ws_connection_limiter.is_allowed(user_id):
        await ws.close(code=4029, reason="Too many connections")
        return

    await ws.accept()

    try:
        await handle_ws(ws, channel_id, user_id, store)
    except WebSocketDisconnect:
        pass
    finally:
        # Cleanup user from all channels on disconnect
        await store.remove_user_from_all(user_id)

        # Only delete the user identity if this was an unexpected disconnect.
        # If the user left intentionally via REST /leave, keep_alive is True
        # and they stay registered so they can rejoin from the lobby.
        user = _active_users.get(user_id)
        if user and user.keep_alive:
            user.keep_alive = False
        else:
            user = _active_users.pop(user_id, None)
            if user:
                _active_usernames.pop(user.username, None)

        # Notify lobby clients about the membership change
        await _broadcast_lobby()


# ── Runner ─────────────────────────────────────────────────────────────────


def main():
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        access_log=False,
    )


if __name__ == "__main__":
    main()
