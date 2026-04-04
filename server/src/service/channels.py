"""Channel service — CRUD, ICE server configuration, and peer notifications."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

from ..core.config import settings
from ..core.exceptions import RateLimitedError
from ..core.models import (
    ChannelInfo,
    CreateChannelRequest,
    IceServerConfig,
    IceServersResponse,
    JoinChannelRequest,
    User,
    WSMessage,
    WSMessageType,
)
from ..core.state import broadcast_lobby, create_channel_limiter, join_limiter, store
from .signaling import send_json


def _ephemeral_turn_credentials(user_id: str) -> tuple[str, str]:
    """Generate time-limited TURN credentials using coturn's HMAC shared-secret scheme.

    username = "<expiry_timestamp>:<user_id>"
    credential = Base64(HMAC-SHA1(secret, username))
    """
    expiry = int(time.time()) + settings.turn_credential_ttl
    username = f"{expiry}:{user_id}"
    mac = hmac.new(
        settings.turn_secret.encode(), username.encode(), hashlib.sha1
    ).digest()
    credential = base64.b64encode(mac).decode()
    return username, credential


async def get_ice_servers(user_id: str) -> IceServersResponse:
    host = settings.coturn_host
    port = settings.coturn_port
    username, credential = _ephemeral_turn_credentials(user_id)
    return IceServersResponse(
        ice_servers=[
            IceServerConfig(urls=f"stun:{host}:{port}"),
            IceServerConfig(
                urls=[
                    f"turn:{host}:{port}?transport=udp",
                    f"turn:{host}:{port}?transport=tcp",
                ],
                username=username,
                credential=credential,
            ),
        ]
    )


async def list_channels() -> list[ChannelInfo]:
    return await store.list_public()


async def create_channel(req: CreateChannelRequest, client_ip: str) -> ChannelInfo:
    if not create_channel_limiter.is_allowed(client_ip):
        raise RateLimitedError("Too many channel creations. Try again later.")
    result = await store.create(req)
    await broadcast_lobby()
    return result


async def join_channel(
    channel_id: str, req: JoinChannelRequest, user: User, client_ip: str
) -> ChannelInfo:
    if not join_limiter.is_allowed(client_ip):
        raise RateLimitedError("Too many join attempts")
    result = await store.join(channel_id, user, req.password)
    await broadcast_lobby()
    return result


async def leave_channel(channel_id: str, user: User) -> None:
    peer_id = user.peer_id
    channel = await store.get(channel_id)
    if channel and peer_id:
        leave_msg = WSMessage(
            type=WSMessageType.PEER_LEFT, sender_id=peer_id
        ).model_dump()
        for peer in channel.peers_of(user.id):
            await send_json(peer.websocket, leave_msg)
    user.keep_alive = True
    user.websocket = None
    await store.leave(channel_id, user.id)
    await broadcast_lobby()
