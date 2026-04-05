"""Pydantic models for request/response validation and internal state."""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from fastapi import WebSocket
from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator


def slugify_channel_name(value: str) -> str:
    normalized = value.strip().lower()
    normalized = re.sub(r"[_\s]+", "-", normalized)
    normalized = re.sub(r"[^a-z0-9-]", "", normalized)
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-")
    if not normalized:
        raise ValueError("Channel name must contain letters or numbers")
    return normalized


class WSMessageType(str, Enum):
    OFFER = "offer"
    ANSWER = "answer"
    ICE_CANDIDATE = "ice_candidate"
    PEER_JOINED = "peer_joined"
    PEER_LEFT = "peer_left"
    CHAT_MESSAGE = "chat_message"
    ENCRYPTED_CHAT = "encrypted_chat"
    CHAT_HISTORY = "chat_history"
    PUBLIC_KEY = "public_key"
    PEER_PUBLIC_KEY = "peer_public_key"
    MUTE_STATE = "mute_state"
    SCREEN_SHARE_STATE = "screen_share_state"
    CAMERA_STATE = "camera_state"
    ERROR = "error"
    LEAVE = "leave"


class CreateChannelRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    is_private: bool = False
    password: str | None = Field(default=None, max_length=128)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Channel name cannot be empty")
        if not re.match(r"^[\w\s\-]+$", v):
            raise ValueError("Channel name contains invalid characters")
        slugify_channel_name(v)
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str | None, info: ValidationInfo) -> str | None:
        is_private = info.data.get("is_private", False)
        if is_private and (v is None or len(v) < 8):
            raise ValueError("Private channels require a password (min 8 chars)")
        if not is_private:
            return None
        return v


class JoinChannelRequest(BaseModel):
    password: str | None = Field(default=None, max_length=128)


class UsernameRequest(BaseModel):
    prefix: str = Field(..., min_length=3, max_length=16)

    @field_validator("prefix")
    @classmethod
    def validate_prefix(cls, v: str) -> str:
        v = v.strip().lower()
        if not re.match(r"^[a-z0-9]+$", v):
            raise ValueError("Prefix must be lowercase alphanumeric only")
        return v


class ChatMessagePayload(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)

    @field_validator("content")
    @classmethod
    def validate_content(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Message cannot be empty")
        return v


class UserInfo(BaseModel):
    id: str
    username: str
    is_muted: bool = False
    is_sharing_screen: bool = False
    is_camera_on: bool = False


class IceServerConfig(BaseModel):
    urls: str | list[str]
    username: str | None = None
    credential: str | None = None


class ChannelInfo(BaseModel):
    id: str
    name: str
    is_private: bool
    user_count: int
    users: list[UserInfo] = []


class UsernameResponse(BaseModel):
    user_id: str
    username: str
    token: str


class IceServersResponse(BaseModel):
    ice_servers: list[IceServerConfig]


class WSMessage(BaseModel):
    type: WSMessageType
    sender_id: str | None = None
    target_id: str | None = None
    payload: dict[str, Any] | str | None = None


class User(BaseModel):
    """Mutable in-memory user state. websocket is excluded from serialization."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    id: str
    username: str
    is_muted: bool = False
    is_sharing_screen: bool = False
    is_camera_on: bool = False
    public_key: str | None = None
    websocket: WebSocket | None = Field(default=None, exclude=True)
    peer_id: str | None = None
    keep_alive: bool = False
    created_at: float = Field(default_factory=time.time)

    def to_info(self) -> UserInfo:
        return UserInfo(
            id=self.peer_id or self.id,
            username=self.username,
            is_muted=self.is_muted,
            is_sharing_screen=self.is_sharing_screen,
            is_camera_on=self.is_camera_on,
        )


class Channel(BaseModel):
    """Mutable in-memory channel state."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    id: str
    name: str
    is_private: bool = False
    password_hash: str | None = None
    users: dict[str, User] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def peers_of(self, exclude_user_id: str) -> list[User]:
        """Return a snapshot of users in this channel excluding the given user."""
        return [u for u in self.users.values() if u.id != exclude_user_id]

    def to_info(self, include_users: bool = True) -> ChannelInfo:
        return ChannelInfo(
            id=self.id,
            name=self.name,
            is_private=self.is_private,
            user_count=len(self.users),
            users=[u.to_info() for u in self.users.values()]
            if include_users and not self.is_private
            else [],
        )
