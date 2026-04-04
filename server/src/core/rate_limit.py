"""Sliding-window in-memory rate limiter."""

from __future__ import annotations

import time
from collections import defaultdict


class RateLimiter:
    """Sliding window rate limiter.

    Tracks timestamps of events per key and rejects if the count within
    the window exceeds the limit.
    """

    def __init__(self, max_calls: int, window_seconds: float) -> None:
        self._max_calls = max_calls
        self._window = window_seconds
        self._calls: dict[str, list[float]] = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self._window
        self._calls[key] = [t for t in self._calls[key] if t > cutoff]
        if len(self._calls[key]) >= self._max_calls:
            return False
        self._calls[key].append(now)
        return True

    def cleanup(self, key: str) -> None:
        """Remove all tracking data for a key."""
        self._calls.pop(key, None)

    def gc(self) -> int:
        """Purge all keys with no recent activity. Returns number removed."""
        cutoff = time.monotonic() - self._window
        stale = [k for k, ts in self._calls.items() if not ts or ts[-1] <= cutoff]
        for k in stale:
            del self._calls[k]
        return len(stale)
