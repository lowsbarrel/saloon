"""WebSocket signaling and chat handler."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

from starlette.websockets import WebSocketDisconnect, WebSocketState

from ..core.models import WSMessage, WSMessageType
from ..core.config import settings
from ..core.state import chat_limiter

if TYPE_CHECKING:
    from fastapi import WebSocket
    from ..core.channels import ChannelStore

logger = logging.getLogger(__name__)


async def send_json(ws: WebSocket | None, data: dict[str, Any]) -> None:
    """Send JSON to a websocket, silently ignoring None or closed connections."""
    if ws is None:
        return
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_json(data)
    except Exception:
        pass


async def handle_ws(
    ws: WebSocket,
    channel_id: str,
    user_id: str,
    store: ChannelStore,
) -> None:
    """Main WebSocket loop for a connected user in a channel."""

    channel = await store.get(channel_id)
    if channel is None:
        await ws.close(code=4004, reason="Channel not found")
        return

    user = channel.users.get(user_id)
    if user is None:
        await ws.close(code=4001, reason="Not a member of this channel")
        return

    user.websocket = ws

    peers = channel.peers_of(user_id)
    join_msg = WSMessage(
        type=WSMessageType.PEER_JOINED,
        sender_id=user.peer_id,
        payload={"username": user.username, "public_key": user.public_key},
    ).model_dump()
    for peer in peers:
        await send_json(peer.websocket, join_msg)

    peer_list = [
        {
            "id": p.peer_id,
            "username": p.username,
            "is_muted": p.is_muted,
            "is_sharing_screen": p.is_sharing_screen,
            "is_camera_on": p.is_camera_on,
            "public_key": p.public_key,
        }
        for p in peers
    ]
    await send_json(ws, {"type": "peer_list", "payload": peer_list})

    try:
        while True:
            try:
                raw = await asyncio.wait_for(
                    ws.receive_text(), timeout=settings.ws_idle_timeout
                )
            except TimeoutError:
                await ws.close(code=4008, reason="Idle timeout")
                break

            if len(raw) > settings.max_ws_message_size:
                await send_json(
                    ws,
                    WSMessage(
                        type=WSMessageType.ERROR,
                        payload={"message": "Message too large"},
                    ).model_dump(),
                )
                continue

            try:
                data: dict[str, Any] = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                await send_json(
                    ws,
                    WSMessage(
                        type=WSMessageType.ERROR,
                        payload={"message": "Invalid JSON"},
                    ).model_dump(),
                )
                continue

            msg_type = data.get("type")

            if msg_type in (
                WSMessageType.OFFER,
                WSMessageType.ANSWER,
                WSMessageType.ICE_CANDIDATE,
            ):
                target_id = data.get("target_id")
                if not target_id or not isinstance(target_id, str):
                    continue

                payload = data.get("payload")
                if not isinstance(payload, dict):
                    continue

                if msg_type in (WSMessageType.OFFER, WSMessageType.ANSWER):
                    sdp = payload.get("sdp")
                    sdp_type = payload.get("type")
                    if not isinstance(sdp, str) or sdp_type not in ("offer", "answer"):
                        continue
                    sanitized_payload: dict[str, Any] = {"sdp": sdp, "type": sdp_type}
                else:
                    candidate = payload.get("candidate")
                    if not isinstance(candidate, dict):
                        continue
                    sanitized_payload = {"candidate": candidate}

                target = next(
                    (p for p in channel.peers_of(user_id) if p.peer_id == target_id),
                    None,
                )
                if target:
                    await send_json(
                        target.websocket,
                        {
                            "type": msg_type,
                            "sender_id": user.peer_id,
                            "payload": sanitized_payload,
                        },
                    )

            elif msg_type == WSMessageType.PUBLIC_KEY:
                raw_payload = data.get("payload")
                key = (
                    raw_payload.get("key", "") if isinstance(raw_payload, dict) else ""
                )
                if not isinstance(key, str) or not key:
                    continue
                user.public_key = key
                # Broadcast to all peers so they can encrypt for us
                pk_msg = {
                    "type": WSMessageType.PEER_PUBLIC_KEY,
                    "sender_id": user.peer_id,
                    "payload": {"key": key},
                }
                for peer in channel.peers_of(user_id):
                    await send_json(peer.websocket, pk_msg)

            elif msg_type == WSMessageType.ENCRYPTED_CHAT:
                if not chat_limiter.is_allowed(user_id):
                    await send_json(
                        ws,
                        WSMessage(
                            type=WSMessageType.ERROR,
                            payload={"message": "Rate limited. Slow down."},
                        ).model_dump(),
                    )
                    continue

                target_id = data.get("target_id")
                payload = data.get("payload")
                if (
                    not isinstance(target_id, str)
                    or not isinstance(payload, dict)
                    or not isinstance(payload.get("ciphertext"), str)
                ):
                    continue

                target = next(
                    (p for p in channel.peers_of(user_id) if p.peer_id == target_id),
                    None,
                )
                if target:
                    await send_json(
                        target.websocket,
                        {
                            "type": WSMessageType.ENCRYPTED_CHAT,
                            "sender_id": user.peer_id,
                            "payload": payload,
                        },
                    )

            elif msg_type == WSMessageType.CHAT_HISTORY:
                target_id = data.get("target_id")
                payload = data.get("payload")
                if (
                    not isinstance(target_id, str)
                    or not isinstance(payload, dict)
                    or not isinstance(payload.get("ciphertext"), str)
                ):
                    continue

                target = next(
                    (p for p in channel.peers_of(user_id) if p.peer_id == target_id),
                    None,
                )
                if target:
                    await send_json(
                        target.websocket,
                        {
                            "type": WSMessageType.CHAT_HISTORY,
                            "sender_id": user.peer_id,
                            "payload": payload,
                        },
                    )

            elif msg_type == WSMessageType.MUTE_STATE:
                raw_payload = data.get("payload")
                user.is_muted = bool(
                    raw_payload.get("is_muted", False)
                    if isinstance(raw_payload, dict)
                    else False
                )
                state_msg = {
                    "type": WSMessageType.MUTE_STATE,
                    "sender_id": user.peer_id,
                    "payload": {"is_muted": user.is_muted},
                }
                for peer in channel.peers_of(user_id):
                    await send_json(peer.websocket, state_msg)

            elif msg_type == WSMessageType.SCREEN_SHARE_STATE:
                raw_payload = data.get("payload")
                user.is_sharing_screen = bool(
                    raw_payload.get("is_sharing_screen", False)
                    if isinstance(raw_payload, dict)
                    else False
                )
                state_msg = {
                    "type": WSMessageType.SCREEN_SHARE_STATE,
                    "sender_id": user.peer_id,
                    "payload": {"is_sharing_screen": user.is_sharing_screen},
                }
                for peer in channel.peers_of(user_id):
                    await send_json(peer.websocket, state_msg)

            elif msg_type == WSMessageType.CAMERA_STATE:
                raw_payload = data.get("payload")
                user.is_camera_on = bool(
                    raw_payload.get("is_camera_on", False)
                    if isinstance(raw_payload, dict)
                    else False
                )
                state_msg = {
                    "type": WSMessageType.CAMERA_STATE,
                    "sender_id": user.peer_id,
                    "payload": {"is_camera_on": user.is_camera_on},
                }
                for peer in channel.peers_of(user_id):
                    await send_json(peer.websocket, state_msg)

            elif msg_type == WSMessageType.LEAVE:
                user.keep_alive = True
                peer_id = user.peer_id
                remaining = channel.peers_of(user_id)
                if peer_id and remaining:
                    leave_msg = WSMessage(
                        type=WSMessageType.PEER_LEFT, sender_id=peer_id
                    ).model_dump()
                    for peer in remaining:
                        await send_json(peer.websocket, leave_msg)
                user.websocket = None
                await store.leave(channel_id, user_id)
                break

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception(
            "WebSocket error for user %s in channel %s", user_id, channel_id
        )
    finally:
        peer_id = user.peer_id
        chat_limiter.cleanup(user_id)

        if user.websocket is not ws:
            return

        user.websocket = None
        deleted = await store.leave(channel_id, user_id)

        if not deleted:
            leave_msg = WSMessage(
                type=WSMessageType.PEER_LEFT,
                sender_id=peer_id,
            ).model_dump()
            for peer in channel.peers_of(user_id):
                await send_json(peer.websocket, leave_msg)
