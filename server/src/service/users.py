"""User service — username generation and registration."""

from __future__ import annotations

from uuid import uuid4

from ..core.auth import create_token
from ..core.exceptions import RateLimitedError, UsernameGenerationError
from ..core.models import User, UsernameResponse
from ..core.state import active_usernames, active_users, username_limiter
from ..core.username import generate_username


def create_username(prefix: str, client_ip: str) -> UsernameResponse:
    """Generate a unique username for a new user and register them."""
    if not username_limiter.is_allowed(client_ip):
        raise RateLimitedError("Too many username requests. Try again later.")

    username = generate_username(prefix, set(active_usernames.keys()))
    if username is None:
        raise UsernameGenerationError()

    user_id = uuid4().hex
    user = User(id=user_id, username=username)
    active_usernames[username] = user_id
    active_users[user_id] = user

    return UsernameResponse(
        user_id=user_id, username=username, token=create_token(user_id)
    )
