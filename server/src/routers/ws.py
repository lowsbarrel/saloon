"""WebSocket routes — lobby channel list feed and per-channel signaling."""

from __future__ import annotations

from fastapi import APIRouter, WebSocket

from ..core.auth import verify_token
from ..core.state import active_users
from ..service import ws as ws_service

router = APIRouter()


@router.websocket("/ws/lobby")
async def lobby_websocket(ws: WebSocket, token: str = "") -> None:
    user_id = verify_token(token) if token else None
    if not user_id or user_id not in active_users:
        await ws.close(code=4001, reason="Invalid or expired token")
        return
    await ws_service.handle_lobby(ws, user_id)


@router.websocket("/ws/{channel_id}")
async def channel_websocket(ws: WebSocket, channel_id: str, token: str = "") -> None:
    user_id = verify_token(token) if token else None
    if not user_id or user_id not in active_users:
        await ws.close(code=4001, reason="Invalid or expired token")
        return
    await ws_service.handle_channel(ws, channel_id, user_id)
