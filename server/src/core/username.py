"""Username generation: prefix + verb + noun."""

from __future__ import annotations

import secrets

from .config import settings
from .wordlists import NOUNS, VERBS


def generate_username(prefix: str, existing_usernames: set[str]) -> str | None:
    """Generate a unique username, or return None if the retry limit is exceeded."""
    for _ in range(settings.username_max_retries):
        username = f"{prefix}{secrets.choice(VERBS)}{secrets.choice(NOUNS)}"
        if username not in existing_usernames:
            return username
    return None
