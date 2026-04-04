"""Channel routes — listing, creation, joining, leaving, and ICE servers."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from ..core.deps import get_client_ip, require_user
from ..core.models import (
    ChannelInfo,
    CreateChannelRequest,
    IceServersResponse,
    JoinChannelRequest,
    User,
)
from ..service import channels as channel_service

router = APIRouter()


@router.get("/ice-servers", response_model=IceServersResponse)
async def get_ice_servers(user: User = Depends(require_user)) -> IceServersResponse:
    return await channel_service.get_ice_servers(user.id)


@router.get("/channels", response_model=list[ChannelInfo])
async def list_channels(_: User = Depends(require_user)) -> list[ChannelInfo]:
    return await channel_service.list_channels()


@router.post(
    "/channels", response_model=ChannelInfo, status_code=status.HTTP_201_CREATED
)
async def create_channel(
    req: CreateChannelRequest,
    request: Request,
    _: User = Depends(require_user),
) -> ChannelInfo:
    return await channel_service.create_channel(req, get_client_ip(request))


@router.post("/channels/{channel_id}/join", response_model=ChannelInfo)
async def join_channel(
    channel_id: str,
    req: JoinChannelRequest,
    request: Request,
    user: User = Depends(require_user),
) -> ChannelInfo:
    return await channel_service.join_channel(
        channel_id, req, user, get_client_ip(request)
    )


@router.post("/channels/{channel_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_channel(
    channel_id: str,
    user: User = Depends(require_user),
) -> None:
    await channel_service.leave_channel(channel_id, user)
