"""Simple in-memory rate limiter."""

from __future__ import annotations

import time
from collections import defaultdict


class RateLimiter:
    """Sliding window rate limiter.

    Tracks timestamps of events per key and rejects if the count within
    the window exceeds the limit.
    """

    def __init__(self, max_calls: int, window_seconds: float):
        self._max_calls = max_calls
        self._window = window_seconds
        self._calls: dict[str, list[float]] = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        now = time.monotonic()
        timestamps = self._calls[key]

        # Purge expired entries
        cutoff = now - self._window
        self._calls[key] = [t for t in timestamps if t > cutoff]
        timestamps = self._calls[key]

        if len(timestamps) >= self._max_calls:
            return False

        timestamps.append(now)
        return True

    def cleanup(self, key: str) -> None:
        """Remove all tracking data for a key."""
        self._calls.pop(key, None)
