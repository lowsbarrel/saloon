"""Username generation: prefix + verb + noun."""

from __future__ import annotations

import secrets

from .wordlists import VERBS, NOUNS
from .config import settings


def generate_username(prefix: str, existing_usernames: set[str]) -> str | None:
    """Generate a unique username.

    Returns None if uniqueness cannot be achieved within retry limit.
    """
    for _ in range(settings.username_max_retries):
        verb = secrets.choice(VERBS)
        noun = secrets.choice(NOUNS)
        username = f"{prefix}{verb}{noun}"
        if username not in existing_usernames:
            return username
    return None
