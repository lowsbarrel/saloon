"""Pydantic models for request/response validation."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator
import re


# ── Enums ──────────────────────────────────────────────────────────────────


class WSMessageType(str, Enum):
    # Signaling
    OFFER = "offer"
    ANSWER = "answer"
    ICE_CANDIDATE = "ice_candidate"
    PEER_JOINED = "peer_joined"
    PEER_LEFT = "peer_left"

    # Chat
    CHAT_MESSAGE = "chat_message"

    # Media state
    MUTE_STATE = "mute_state"
    SCREEN_SHARE_STATE = "screen_share_state"

    # Errors
    ERROR = "error"

    # Client-initiated leave (faster than REST for peer notification)
    LEAVE = "leave"


# ── Request models ─────────────────────────────────────────────────────────


class CreateChannelRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    is_private: bool = False
    password: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Channel name cannot be empty")
        if not re.match(r"^[\w\s\-]+$", v):
            raise ValueError("Channel name contains invalid characters")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str | None, info) -> str | None:
        is_private = info.data.get("is_private", False)
        if is_private and (v is None or len(v) < 8):
            raise ValueError("Private channels require a password (min 8 chars)")
        if not is_private:
            return None
        return v


class JoinChannelRequest(BaseModel):
    password: str | None = None


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


# ── Response / internal models ─────────────────────────────────────────────


class UserInfo(BaseModel):
    id: str
    username: str
    is_muted: bool = False
    is_sharing_screen: bool = False


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
    ice_servers: list[dict]


class WSMessage(BaseModel):
    type: WSMessageType
    sender_id: str | None = None
    target_id: str | None = None
    payload: dict | str | None = None


# ── Internal state objects (not Pydantic — mutable) ───────────────────────


class User:
    __slots__ = (
        "id",
        "username",
        "is_muted",
        "is_sharing_screen",
        "websocket",
        "peer_id",
        "keep_alive",
        "created_at",
    )

    def __init__(self, *, id: str, username: str, websocket=None):
        self.id = id
        self.username = username
        self.is_muted = False
        self.is_sharing_screen = False
        self.websocket = websocket
        self.peer_id: str | None = None
        self.keep_alive: bool = False
        self.created_at: float = __import__("time").time()

    def to_info(self) -> UserInfo:
        return UserInfo(
            id=self.peer_id or self.id,
            username=self.username,
            is_muted=self.is_muted,
            is_sharing_screen=self.is_sharing_screen,
        )


class Channel:
    __slots__ = ("id", "name", "is_private", "password_hash", "users", "created_at")

    def __init__(
        self, *, name: str, is_private: bool = False, password_hash: str | None = None
    ):
        self.id = uuid4().hex
        self.name = name
        self.is_private = is_private
        self.password_hash = password_hash
        self.users: dict[str, User] = {}
        self.created_at = datetime.now(timezone.utc)

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
