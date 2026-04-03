"""HMAC-based token authentication.

Tokens are signed with a server-side secret and carry a user_id + expiry.
They replace raw user_id exposure in query parameters and headers.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from .config import settings

# Generate a random secret at startup (rotates on restart — acceptable for
# an in-memory server where all state is ephemeral anyway).
_SECRET: bytes = (
    settings.auth_secret.encode() if settings.auth_secret else secrets.token_bytes(32)
)

# Token format:  user_id.expires_ts.signature
_SEP = "."


def create_token(user_id: str, ttl: int | None = None) -> str:
    """Create a signed token for *user_id* valid for *ttl* seconds."""
    if ttl is None:
        ttl = settings.token_ttl
    expires = int(time.time()) + ttl
    payload = f"{user_id}{_SEP}{expires}"
    sig = _sign(payload)
    return f"{payload}{_SEP}{sig}"


def verify_token(token: str) -> str | None:
    """Return the user_id if the token is valid, else None."""
    parts = token.split(_SEP)
    if len(parts) != 3:
        return None

    user_id, expires_str, sig = parts

    # Validate expiry is numeric
    if not expires_str.isdigit():
        return None

    # Check signature
    payload = f"{user_id}{_SEP}{expires_str}"
    if not hmac.compare_digest(sig, _sign(payload)):
        return None

    # Check expiry
    if int(expires_str) < int(time.time()):
        return None

    return user_id


def _sign(payload: str) -> str:
    return hmac.new(_SECRET, payload.encode(), hashlib.sha256).hexdigest()
