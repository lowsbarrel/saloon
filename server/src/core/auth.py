"""HMAC-based token authentication."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from .config import settings

_SECRET: bytes = (
    settings.auth_secret.encode() if settings.auth_secret else secrets.token_bytes(32)
)
_SEP = "."


def create_token(user_id: str, ttl: int | None = None) -> str:
    """Create a signed token for *user_id* valid for *ttl* seconds."""
    if ttl is None:
        ttl = settings.token_ttl
    expires = int(time.time()) + ttl
    payload = f"{user_id}{_SEP}{expires}"
    return f"{payload}{_SEP}{_sign(payload)}"


def verify_token(token: str) -> str | None:
    """Return the user_id if the token is valid and unexpired, else None."""
    parts = token.split(_SEP)
    if len(parts) != 3:
        return None
    user_id, expires_str, sig = parts
    if not expires_str.isdigit():
        return None
    payload = f"{user_id}{_SEP}{expires_str}"
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    if int(expires_str) < int(time.time()):
        return None
    return user_id


def _sign(payload: str) -> str:
    return hmac.new(_SECRET, payload.encode(), hashlib.sha256).hexdigest()
