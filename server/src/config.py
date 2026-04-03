"""Centralized configuration using pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SALOON_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # ── Server ─────────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "warning"

    # ── Channels ───────────────────────────────────────────────────────
    max_channels: int = 100
    max_users_per_channel: int = 20

    # ── Rate limits (per IP) ───────────────────────────────────────────
    rate_join_max: int = 10
    rate_join_window: float = 60.0

    rate_username_max: int = 10
    rate_username_window: float = 60.0

    rate_create_channel_max: int = 5
    rate_create_channel_window: float = 60.0

    rate_ws_max: int = 20
    rate_ws_window: float = 60.0

    rate_chat_max: int = 5
    rate_chat_window: float = 5.0

    # ── WebSocket ──────────────────────────────────────────────────────
    max_ws_message_size: int = 65_536  # 64 KB
    max_chat_length: int = 2000

    # ── Argon2id password hashing ──────────────────────────────────────
    argon2_time_cost: int = 3
    argon2_memory_cost: int = 65_536
    argon2_parallelism: int = 4
    argon2_hash_len: int = 32

    # ── Username generation ────────────────────────────────────────────
    username_max_retries: int = 50

    # ── Auth tokens ────────────────────────────────────────────────────
    auth_secret: str = ""  # random per-start if empty
    token_ttl: int = 86400  # 24 hours

    # ── User TTL (seconds without WS before auto-cleanup) ─────────────
    user_ttl: float = 300.0  # 5 minutes

    # ── Rate limiter GC interval (seconds) ─────────────────────────────
    rate_gc_interval: float = 120.0

    # ── coturn (STUN + TURN) ──────────────────────────────────────────
    coturn_host: str = "coturn"  # hostname of the coturn container
    coturn_port: int = 3478
    coturn_tls_port: int = 5349
    turn_username: str = "saloon"
    turn_credential: str = "saloon-secret"
    turn_realm: str = "saloon"

    # ── Trusted proxy header ───────────────────────────────────────────
    trusted_proxy: bool = False


settings = Settings()
