"""User routes — health check, username registration, and session validation."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..core.deps import get_client_ip, require_user
from ..core.models import User, UsernameRequest, UsernameResponse
from ..service.users import create_username

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/username", response_model=UsernameResponse)
async def register_username(req: UsernameRequest, request: Request) -> UsernameResponse:
    return create_username(req.prefix, get_client_ip(request))


@router.get("/users/check")
async def check_user(user: User = Depends(require_user)) -> dict[str, object]:
    return {"valid": True, "user_id": user.id, "username": user.username}
