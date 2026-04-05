"""Domain exceptions — transport-agnostic error types for the service layer."""

from __future__ import annotations


class SaloonError(Exception):
    """Base class for all domain errors."""


class ChannelNotFoundError(SaloonError):
    def __init__(self) -> None:
        super().__init__("Channel not found")


class ChannelFullError(SaloonError):
    def __init__(self) -> None:
        super().__init__("Channel is full")


class AlreadyInChannelError(SaloonError):
    def __init__(self) -> None:
        super().__init__("Already in channel")


class PasswordRequiredError(SaloonError):
    def __init__(self) -> None:
        super().__init__("Password required")


class InvalidPasswordError(SaloonError):
    def __init__(self) -> None:
        super().__init__("Invalid password")


class ChannelLimitReachedError(SaloonError):
    def __init__(self) -> None:
        super().__init__("Server channel limit reached")


class ChannelNameTakenError(SaloonError):
    def __init__(self) -> None:
        super().__init__("Channel name is already in use")


class RateLimitedError(SaloonError):
    def __init__(self, detail: str = "Too many requests. Try again later.") -> None:
        super().__init__(detail)


class UsernameGenerationError(SaloonError):
    def __init__(self) -> None:
        super().__init__(
            "Could not generate a unique username. Try a different prefix."
        )
