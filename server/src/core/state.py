"""Shared application state, rate limiters, and background tasks."""

from __future__ import annotations

import asyncio
import time

from fastapi import WebSocket

from .channels import ChannelStore
from .config import settings
from .models import User
from .rate_limit import RateLimiter

store = ChannelStore()
active_usernames: dict[str, str] = {}
active_users: dict[str, User] = {}
lobby_clients: dict[WebSocket, str] = {}

join_limiter = RateLimiter(
    max_calls=settings.rate_join_max, window_seconds=settings.rate_join_window
)
username_limiter = RateLimiter(
    max_calls=settings.rate_username_max, window_seconds=settings.rate_username_window
)
create_channel_limiter = RateLimiter(
    max_calls=settings.rate_create_channel_max,
    window_seconds=settings.rate_create_channel_window,
)
ws_connection_limiter = RateLimiter(
    max_calls=settings.rate_ws_max, window_seconds=settings.rate_ws_window
)
global_limiter = RateLimiter(
    max_calls=settings.rate_global_max, window_seconds=settings.rate_global_window
)
ws_ip_limiter = RateLimiter(
    max_calls=settings.rate_ws_ip_max, window_seconds=settings.rate_ws_ip_window
)
chat_limiter = RateLimiter(
    max_calls=settings.rate_chat_max, window_seconds=settings.rate_chat_window
)
all_limiters = [
    join_limiter,
    username_limiter,
    create_channel_limiter,
    ws_connection_limiter,
    global_limiter,
    ws_ip_limiter,
    chat_limiter,
]


def lobby_ip_count(ip: str) -> int:
    """Return how many lobby WS connections exist for the given IP."""
    return sum(1 for v in lobby_clients.values() if v == ip)


async def broadcast_lobby() -> None:
    """Push the updated public channel list to all lobby WebSocket clients in parallel."""
    if not lobby_clients:
        return
    data = [ch.model_dump() for ch in await store.list_public()]
    msg = {"type": "channels", "payload": data}
    clients = list(lobby_clients)
    results = await asyncio.gather(
        *[ws.send_json(msg) for ws in clients],
        return_exceptions=True,
    )
    for ws, result in zip(clients, results):
        if isinstance(result, Exception):
            lobby_clients.pop(ws, None)


async def gc_rate_limiters() -> None:
    while True:
        await asyncio.sleep(settings.rate_gc_interval)
        for limiter in all_limiters:
            limiter.gc()


async def gc_stale_users() -> None:
    while True:
        await asyncio.sleep(settings.user_ttl)
        now = time.time()
        stale = [
            uid
            for uid, user in active_users.items()
            if user.websocket is None
            and user.peer_id is None
            and not user.keep_alive
            and (now - user.created_at) > settings.user_ttl
        ]
        for uid in stale:
            user = active_users.pop(uid, None)
            if user:
                active_usernames.pop(user.username, None)
