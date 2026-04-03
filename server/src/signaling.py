"""WebSocket signaling and chat handler."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from starlette.websockets import WebSocketDisconnect, WebSocketState

from .models import WSMessage, WSMessageType
from .config import settings
from .rate_limit import RateLimiter

if TYPE_CHECKING:
    from fastapi import WebSocket
    from .channels import ChannelStore

logger = logging.getLogger(__name__)

_chat_limiter = RateLimiter(
    max_calls=settings.rate_chat_max, window_seconds=settings.rate_chat_window
)


async def _send_json(ws, data: dict) -> None:
    """Send JSON to a websocket, silently ignoring closed connections."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_json(data)
    except Exception:
        pass


async def handle_ws(
    ws: "WebSocket",
    channel_id: str,
    user_id: str,
    store: "ChannelStore",
) -> None:
    """Main WebSocket loop for a connected user in a channel."""

    channel = await store.get(channel_id)
    if channel is None:
        await ws.close(code=4004, reason="Channel not found")
        return

    user = channel.users.get(user_id) if channel else None
    if user is None:
        await ws.close(code=4001, reason="Not a member of this channel")
        return

    # Attach websocket to user
    user.websocket = ws

    # Notify existing peers about the new user (use ephemeral peer_id)
    peers = await store.get_peers(channel_id, user_id)
    join_msg = WSMessage(
        type=WSMessageType.PEER_JOINED,
        sender_id=user.peer_id,
        payload={"username": user.username},
    ).model_dump()

    for peer in peers:
        await _send_json(peer.websocket, join_msg)

    # Send peer list to the new user (using peer_ids, not user_ids)
    peer_list = [
        {
            "id": p.peer_id,
            "username": p.username,
            "is_muted": p.is_muted,
            "is_sharing_screen": p.is_sharing_screen,
        }
        for p in peers
    ]
    await _send_json(ws, {"type": "peer_list", "payload": peer_list})

    try:
        while True:
            raw = await ws.receive_text()

            # Reject oversized messages
            if len(raw) > settings.max_ws_message_size:
                await _send_json(
                    ws,
                    WSMessage(
                        type=WSMessageType.ERROR,
                        payload={"message": "Message too large"},
                    ).model_dump(),
                )
                continue

            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                await _send_json(
                    ws,
                    WSMessage(
                        type=WSMessageType.ERROR,
                        payload={"message": "Invalid JSON"},
                    ).model_dump(),
                )
                continue

            msg_type = data.get("type")

            # ── Signaling (relay to target peer) ───────────────────────
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

                # Validate signaling payload structure
                if msg_type in (WSMessageType.OFFER, WSMessageType.ANSWER):
                    sdp = payload.get("sdp")
                    sdp_type = payload.get("type")
                    if not isinstance(sdp, str) or sdp_type not in ("offer", "answer"):
                        continue
                    sanitized_payload = {"sdp": sdp, "type": sdp_type}
                else:  # ICE_CANDIDATE
                    candidate = payload.get("candidate")
                    if not isinstance(candidate, dict):
                        continue
                    sanitized_payload = {"candidate": candidate}

                target_peers = await store.get_peers(channel_id, user_id)
                target = next((p for p in target_peers if p.peer_id == target_id), None)
                if target and target.websocket:
                    await _send_json(
                        target.websocket,
                        {
                            "type": msg_type,
                            "sender_id": user.peer_id,
                            "payload": sanitized_payload,
                        },
                    )

            # ── Chat message (relay to all peers) ──────────────────────
            elif msg_type == WSMessageType.CHAT_MESSAGE:
                content = (
                    data.get("payload", {}).get("content", "")
                    if isinstance(data.get("payload"), dict)
                    else ""
                )
                if not isinstance(content, str):
                    continue
                content = content.strip()
                if not content or len(content) > settings.max_chat_length:
                    await _send_json(
                        ws,
                        WSMessage(
                            type=WSMessageType.ERROR,
                            payload={
                                "message": "Invalid message length (1-2000 chars)"
                            },
                        ).model_dump(),
                    )
                    continue

                if not _chat_limiter.is_allowed(user_id):
                    await _send_json(
                        ws,
                        WSMessage(
                            type=WSMessageType.ERROR,
                            payload={"message": "Rate limited. Slow down."},
                        ).model_dump(),
                    )
                    continue

                chat_msg = {
                    "type": WSMessageType.CHAT_MESSAGE,
                    "sender_id": user.peer_id,
                    "payload": {"content": content, "username": user.username},
                }
                current_peers = await store.get_peers(channel_id, user_id)
                for peer in current_peers:
                    await _send_json(peer.websocket, chat_msg)

            # ── Mute state ─────────────────────────────────────────────
            elif msg_type == WSMessageType.MUTE_STATE:
                is_muted = data.get("payload", {}).get("is_muted", False)
                user.is_muted = bool(is_muted)
                state_msg = {
                    "type": WSMessageType.MUTE_STATE,
                    "sender_id": user.peer_id,
                    "payload": {"is_muted": user.is_muted},
                }
                current_peers = await store.get_peers(channel_id, user_id)
                for peer in current_peers:
                    await _send_json(peer.websocket, state_msg)

            # ── Screen share state ─────────────────────────────────────
            elif msg_type == WSMessageType.SCREEN_SHARE_STATE:
                is_sharing = data.get("payload", {}).get("is_sharing_screen", False)
                user.is_sharing_screen = bool(is_sharing)
                state_msg = {
                    "type": WSMessageType.SCREEN_SHARE_STATE,
                    "sender_id": user.peer_id,
                    "payload": {"is_sharing_screen": user.is_sharing_screen},
                }
                current_peers = await store.get_peers(channel_id, user_id)
                for peer in current_peers:
                    await _send_json(peer.websocket, state_msg)

            # ── Intentional leave (fast path — no HTTP round-trip needed) ─
            elif msg_type == WSMessageType.LEAVE:
                # Keep the user registered in _active_users so they can
                # return to the lobby without re-authenticating.
                user.keep_alive = True
                # Notify remaining peers immediately, before store cleanup.
                peer_id = user.peer_id
                remaining = await store.get_peers(channel_id, user_id)
                if peer_id and remaining:
                    leave_msg = WSMessage(
                        type=WSMessageType.PEER_LEFT, sender_id=peer_id
                    ).model_dump()
                    for peer in remaining:
                        await _send_json(peer.websocket, leave_msg)
                # Clear websocket ref so the finally-block doesn't
                # re-run the leave logic when the client closes the WS.
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
        # Capture peer_id before cleanup clears it
        peer_id = user.peer_id
        _chat_limiter.cleanup(user_id)

        # Only clean up if this websocket is still the active one for the user.
        # If the user already left via REST and possibly re-joined, their
        # websocket reference will have changed (or be None).
        if user.websocket is not ws:
            return

        user.websocket = None

        deleted = await store.leave(channel_id, user_id)

        # If channel still exists, notify remaining peers
        if not deleted:
            remaining = await store.get_peers(channel_id, user_id)
            leave_msg = WSMessage(
                type=WSMessageType.PEER_LEFT,
                sender_id=peer_id,
            ).model_dump()
            for peer in remaining:
                await _send_json(peer.websocket, leave_msg)
