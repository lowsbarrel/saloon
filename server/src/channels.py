"""In-memory channel store and operations."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING
from uuid import uuid4

from .config import settings
from .crypto import hash_password, verify_password
from .models import Channel, ChannelInfo, CreateChannelRequest, User

if TYPE_CHECKING:
    pass


class ChannelStore:
    """Thread-safe (asyncio) in-memory channel manager."""

    def __init__(self) -> None:
        self._channels: dict[str, Channel] = {}
        self._lock = asyncio.Lock()

    # ── Queries ────────────────────────────────────────────────────────

    async def list_public(self) -> list[ChannelInfo]:
        async with self._lock:
            return [
                ch.to_info(include_users=True)
                for ch in self._channels.values()
                if not ch.is_private
            ]

    async def get(self, channel_id: str) -> Channel | None:
        async with self._lock:
            return self._channels.get(channel_id)

    async def exists(self, channel_id: str) -> bool:
        async with self._lock:
            return channel_id in self._channels

    # ── Mutations ──────────────────────────────────────────────────────

    async def create(self, req: CreateChannelRequest) -> ChannelInfo | str:
        pw_hash = (
            hash_password(req.password) if req.is_private and req.password else None
        )
        channel = Channel(
            name=req.name, is_private=req.is_private, password_hash=pw_hash
        )
        async with self._lock:
            if len(self._channels) >= settings.max_channels:
                return "Server channel limit reached"
            self._channels[channel.id] = channel
        return channel.to_info()

    async def join(
        self,
        channel_id: str,
        user: User,
        password: str | None = None,
    ) -> ChannelInfo | str:
        """Add user to channel. Returns ChannelInfo on success or error string."""
        async with self._lock:
            channel = self._channels.get(channel_id)
            if channel is None:
                return "Channel not found"

            if channel.is_private:
                if password is None:
                    return "Password required"
                if channel.password_hash is None or not verify_password(
                    password, channel.password_hash
                ):
                    return "Invalid password"

            if user.id in channel.users:
                return "Already in channel"

            if len(channel.users) >= settings.max_users_per_channel:
                return "Channel is full"

            user.peer_id = uuid4().hex[:16]
            channel.users[user.id] = user
            return channel.to_info()

    async def leave(self, channel_id: str, user_id: str) -> bool:
        """Remove user from channel. Deletes channel if empty.

        Returns True if the channel was deleted.
        """
        async with self._lock:
            channel = self._channels.get(channel_id)
            if channel is None:
                return False

            user = channel.users.pop(user_id, None)
            if user:
                user.peer_id = None

            if len(channel.users) == 0:
                del self._channels[channel_id]
                return True
            return False

    async def remove_user_from_all(self, user_id: str) -> list[str]:
        """Remove a user from every channel (disconnect cleanup).

        Returns list of channel IDs that were deleted.
        """
        deleted: list[str] = []
        async with self._lock:
            empty_channels: list[str] = []
            for ch in self._channels.values():
                user = ch.users.pop(user_id, None)
                if user:
                    user.peer_id = None
                if len(ch.users) == 0:
                    empty_channels.append(ch.id)
            for cid in empty_channels:
                del self._channels[cid]
                deleted.append(cid)
        return deleted

    async def get_peers(self, channel_id: str, exclude_user_id: str) -> list[User]:
        """Get all users in a channel except the given one."""
        async with self._lock:
            channel = self._channels.get(channel_id)
            if channel is None:
                return []
            return [u for u in channel.users.values() if u.id != exclude_user_id]

    async def get_user_channel(self, user_id: str) -> Channel | None:
        """Find which channel a user is in."""
        async with self._lock:
            for ch in self._channels.values():
                if user_id in ch.users:
                    return ch
        return None
