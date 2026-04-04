"""FastAPI dependencies."""

from __future__ import annotations

from fastapi import Header, HTTPException, Request, status
from starlette.requests import HTTPConnection

from .auth import verify_token
from .config import settings
from .models import User
from .state import active_users


def resolve_client_ip(conn: HTTPConnection) -> str:
    """Extract client IP from any HTTP connection (Request or WebSocket).

    When *trusted_proxy* is enabled, X-Forwarded-For is only honoured if
    the direct peer IP is in *trusted_proxy_ips*.  This prevents any
    internet client from spoofing their IP via the header.
    """
    if settings.trusted_proxy and conn.client:
        peer_ip = conn.client.host
        if peer_ip in settings.trusted_proxy_ips:
            forwarded = conn.headers.get("x-forwarded-for")
            if forwarded:
                return forwarded.split(",")[0].strip()
    return conn.client.host if conn.client else "unknown"


def get_client_ip(request: Request) -> str:
    """Extract client IP for HTTP endpoints, raising on failure."""
    ip = resolve_client_ip(request)
    if ip == "unknown":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot determine client address",
        )
    return ip


def require_user(authorization: str = Header("")) -> User:
    """Validate Authorization header and return the authenticated User, or raise 401."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid authorization",
        )
    user_id = verify_token(authorization[7:])
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    user = active_users.get(user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown user",
        )
    return user
