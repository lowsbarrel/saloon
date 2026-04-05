"""WebSocket service — lobby and channel connection lifecycle."""

from __future__ import annotations

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from ..core.config import settings
from ..core.deps import resolve_client_ip
from ..core.state import (
    active_usernames,
    active_users,
    broadcast_lobby,
    lobby_clients,
    lobby_ip_count,
    store,
    ws_connection_limiter,
    ws_ip_limiter,
)
from .signaling import handle_ws


async def handle_lobby(ws: WebSocket, user_id: str) -> None:
    """Manage a lobby WebSocket: push initial channel list and keep the connection alive."""
    ip = resolve_client_ip(ws)
    if not ws_ip_limiter.is_allowed(ip):
        await ws.close(code=4029, reason="Too many connections")
        return
    if lobby_ip_count(ip) >= settings.max_lobby_connections_per_ip:
        await ws.close(code=4029, reason="Too many lobby connections")
        return
    await ws.accept()
    lobby_clients[ws] = ip
    try:
        data = [ch.model_dump() for ch in await store.list_public()]
        await ws.send_json({"type": "channels", "payload": data})
        while True:
            await ws.receive_text()
            if user_id not in active_users:
                break
    except WebSocketDisconnect:
        pass
    finally:
        lobby_clients.pop(ws, None)


async def handle_channel(ws: WebSocket, channel_id: str, user_id: str) -> None:
    """Manage a channel WebSocket: rate-limit, run signaling loop, and clean up on disconnect."""
    ip = resolve_client_ip(ws)
    if not ws_connection_limiter.is_allowed(user_id) or not ws_ip_limiter.is_allowed(
        ip
    ):
        await ws.close(code=4029, reason="Too many connections")
        return

    await ws.accept()
    try:
        await handle_ws(ws, channel_id, user_id, store)
    except WebSocketDisconnect:
        pass
    finally:
        user = active_users.get(user_id)
        if user and user.keep_alive:
            user.keep_alive = False
        else:
            user = active_users.pop(user_id, None)
            if user:
                active_usernames.pop(user.username, None)
        await broadcast_lobby()
