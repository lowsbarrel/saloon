"""Saloon — privacy-focused voice/video communication server."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from uuid import uuid4

import uvicorn
from fastapi import (
    FastAPI,
    Request,
    WebSocket,
    WebSocketDisconnect,
    HTTPException,
    status,
)
from fastapi.middleware.cors import CORSMiddleware

from src.models import (
    CreateChannelRequest,
    JoinChannelRequest,
    UsernameRequest,
    UsernameResponse,
    ChannelInfo,
    User,
)
from src.channels import ChannelStore
from src.config import settings
from src.users import generate_username
from src.signaling import handle_ws, _send_json
from src.models import WSMessage, WSMessageType
from src.rate_limit import RateLimiter

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


# ── App lifecycle ──────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.warning("Saloon server starting")
    yield
    logger.warning("Saloon server shutting down")
    _active_usernames.clear()
    _active_users.clear()


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


# ── Health ─────────────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Username ───────────────────────────────────────────────────────────────


@app.post("/username", response_model=UsernameResponse)
async def create_username(req: UsernameRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
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

    return UsernameResponse(user_id=user_id, username=username)


# ── User validation ────────────────────────────────────────────────────────


@app.get("/users/{user_id}/check")
async def check_user(user_id: str):
    if user_id not in _active_users:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    return {"valid": True}


# ── Channels ───────────────────────────────────────────────────────────────


@app.get("/channels", response_model=list[ChannelInfo])
async def list_channels():
    return await store.list_public()


@app.post("/channels", response_model=ChannelInfo, status_code=status.HTTP_201_CREATED)
async def create_channel(req: CreateChannelRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
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
    return result


@app.post("/channels/{channel_id}/join", response_model=ChannelInfo)
async def join_channel(channel_id: str, req: JoinChannelRequest, request: Request):
    user = _active_users.get(req.user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user"
        )

    client_ip = request.client.host if request.client else "unknown"
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

    return result


@app.post("/channels/{channel_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_channel(channel_id: str, user_id: str):
    user = _active_users.get(user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user"
        )

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


# ── WebSocket ──────────────────────────────────────────────────────────────


@app.websocket("/ws/{channel_id}")
async def websocket_endpoint(ws: WebSocket, channel_id: str, user_id: str = ""):
    if not user_id or user_id not in _active_users:
        await ws.close(code=4001, reason="Invalid user")
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
