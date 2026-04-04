"""Centralized configuration using pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SALOON_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "warning"

    cors_origins: list[str] = ["*"]

    max_channels: int = 100
    max_users_per_channel: int = 20
    max_channel_password_length: int = 128
    max_lobby_connections_per_ip: int = 5

    rate_join_max: int = 10
    rate_join_window: float = 60.0

    rate_username_max: int = 10
    rate_username_window: float = 60.0

    rate_create_channel_max: int = 5
    rate_create_channel_window: float = 60.0

    rate_ws_max: int = 20
    rate_ws_window: float = 60.0

    rate_global_max: int = 60
    rate_global_window: float = 60.0

    rate_ws_ip_max: int = 10
    rate_ws_ip_window: float = 60.0

    rate_chat_max: int = 5
    rate_chat_window: float = 5.0

    max_ws_message_size: int = 65_536
    max_chat_length: int = 2000

    argon2_time_cost: int = 3
    argon2_memory_cost: int = 65_536
    argon2_parallelism: int = 4
    argon2_hash_len: int = 32

    username_max_retries: int = 50

    auth_secret: str = ""
    token_ttl: int = 86400

    user_ttl: float = 300.0
    rate_gc_interval: float = 120.0

    coturn_host: str = "coturn"
    coturn_port: int = 3478
    coturn_tls_port: int = 5349
    turn_secret: str = "saloon-dev-secret"
    turn_credential_ttl: int = 86400
    turn_realm: str = "saloon"

    trusted_proxy: bool = False
    trusted_proxy_ips: list[str] = ["127.0.0.1", "::1"]


settings = Settings()
