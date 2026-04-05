"""Saloon — privacy-focused voice/video communication server."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from src.core.config import settings
from src.core.exceptions import (
    AlreadyInChannelError,
    ChannelFullError,
    ChannelLimitReachedError,
    ChannelNameTakenError,
    ChannelNotFoundError,
    InvalidPasswordError,
    PasswordRequiredError,
    RateLimitedError,
    SaloonError,
    UsernameGenerationError,
)
from src.core.middleware import RateLimitMiddleware, SecurityHeadersMiddleware
from src.core.state import (
    active_usernames,
    active_users,
    gc_rate_limiters,
    gc_stale_users,
    lobby_clients,
)
from src.routers import channels, users, ws

logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("saloon")


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[type-arg]
    logger.warning("Saloon server starting")
    tasks = [
        asyncio.create_task(gc_rate_limiters()),
        asyncio.create_task(gc_stale_users()),
    ]
    yield
    logger.warning("Saloon server shutting down")
    for task in tasks:
        task.cancel()
    active_usernames.clear()
    active_users.clear()
    for client in list(lobby_clients):
        try:
            await client.close()
        except Exception:
            pass
    lobby_clients.clear()


_STATUS_MAP: dict[type[SaloonError], int] = {
    ChannelNotFoundError: 404,
    ChannelFullError: 403,
    AlreadyInChannelError: 409,
    ChannelNameTakenError: 409,
    PasswordRequiredError: 403,
    InvalidPasswordError: 403,
    ChannelLimitReachedError: 503,
    RateLimitedError: 429,
    UsernameGenerationError: 409,
}


app = FastAPI(
    title="Saloon",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.exception_handler(SaloonError)
async def saloon_error_handler(request: Request, exc: SaloonError) -> JSONResponse:
    return JSONResponse(
        status_code=_STATUS_MAP.get(type(exc), 500),
        content={"detail": str(exc)},
    )


app.add_middleware(RateLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(users.router)
app.include_router(channels.router)
app.include_router(ws.router)


def main() -> None:
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        access_log=False,
    )


if __name__ == "__main__":
    main()
