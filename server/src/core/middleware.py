"""HTTP middleware."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from .deps import resolve_client_ip
from .state import global_limiter


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = (
            "microphone=(self), camera=(self), display-capture=(self)"
        )
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Global per-IP rate limiter for all HTTP endpoints."""

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.method == "OPTIONS" or request.url.path == "/health":
            return await call_next(request)
        ip = resolve_client_ip(request)
        if not global_limiter.is_allowed(ip):
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Try again later."},
            )
        return await call_next(request)
