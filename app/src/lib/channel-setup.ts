/**
 * Orchestrates channel setup: PeerManager init, signaling handlers, ICE config.
 * Keeps the channel page component thin.
 */

import type { PeerManager } from '$lib/webrtc/peer-manager';
import type { WSMessage, ChatMessage, PeerState } from '$lib/types';
import {
	signalingClient,
	createPeerManager,
	chatMessages,
	isMuted,
	isSharingScreen,
	isCameraOn,
	peerList,
	e2eeKeyPair,
	peerPublicKeys,
} from '$lib/stores';
import { getIceServers } from '$lib/api';
import { generateKeyPair, exportPublicKey, importPublicKey, decrypt, encrypt } from '$lib/crypto';
import { get } from 'svelte/store';

const MAX_CHAT_MESSAGES = 500;
const MAX_HISTORY_MESSAGES = 50;

export interface ChannelSetupResult {
	pm: PeerManager;
	unsubs: (() => void)[];
}

export interface ChannelSetupCallbacks {
	onPeerLeft: (peerId: string) => void;
	onChatMessage: () => void;
	onConnectionClosed: () => void;
}

/**
 * Initialise PeerManager, configure ICE, bind all signaling event handlers.
 * Returns the PeerManager and a cleanup array.
 */
export async function setupChannel(
	channelId: string,
	userId: string,
	callbacks: ChannelSetupCallbacks,
): Promise<ChannelSetupResult> {
	const unsubs: (() => void)[] = [];
	const pm = createPeerManager(userId);

	// ── E2EE keypair ─────────────────────────────────────────────
	const keyPair = generateKeyPair();
	e2eeKeyPair.set(keyPair);

	// ICE
	try {
		const iceConfig = await getIceServers();
		pm.setIceServers(iceConfig.ice_servers);
	} catch {
		// Fall back to default STUN-only config
	}

	await pm.initLocalAudio();

	// ── Signal handlers ──────────────────────────────────────────

	unsubs.push(
		signalingClient.on('peer_list', (msg: WSMessage) => {
			const list = msg.payload as unknown as Array<{
				id: string;
				username: string;
				is_muted: boolean;
				is_sharing_screen: boolean;
				is_camera_on: boolean;
				public_key?: string | null;
			}>;
			if (!Array.isArray(list)) return;
			for (const p of list) {
				pm.createPeerConnection(p.id, p.username, true);
				pm.updatePeerState(p.id, {
					is_muted: p.is_muted,
					is_sharing_screen: p.is_sharing_screen,
					is_camera_on: p.is_camera_on ?? false,
				});
				if (p.public_key) {
					peerPublicKeys.update((m) => {
						m.set(p.id, importPublicKey(p.public_key!));
						return new Map(m);
					});
				}
			}
		}),
	);

	unsubs.push(
		signalingClient.on('peer_joined', (msg: WSMessage) => {
			const payload = msg.payload as { username: string; public_key?: string | null } | undefined;
			if (msg.sender_id && payload?.username) {
				pm.registerPeer(msg.sender_id, payload.username);
				if (payload.public_key) {
					const newPeerPk = importPublicKey(payload.public_key);
					peerPublicKeys.update((m) => {
						m.set(msg.sender_id!, newPeerPk);
						return new Map(m);
					});

					// The peer with the lowest ID sends chat history to the newcomer
					const peerIds = Array.from(get(peerPublicKeys).keys()).filter(
						(id) => id !== msg.sender_id,
					);
					const allIds = [userId, ...peerIds].sort();
					if (allIds[0] === userId) {
						sendChatHistory(msg.sender_id, newPeerPk);
					}
				}
			}
		}),
	);

	unsubs.push(
		signalingClient.on('peer_left', (msg: WSMessage) => {
			if (msg.sender_id) {
				pm.removePeer(msg.sender_id);
				peerPublicKeys.update((m) => {
					m.delete(msg.sender_id!);
					return new Map(m);
				});
				callbacks.onPeerLeft(msg.sender_id);
			}
		}),
	);

	unsubs.push(
		signalingClient.on('offer', async (msg: WSMessage) => {
			if (msg.sender_id && msg.payload && typeof msg.payload === 'object') {
				await pm.handleOffer(msg.sender_id, msg.sender_id, msg.payload as Record<string, unknown>);
			}
		}),
	);

	unsubs.push(
		signalingClient.on('answer', async (msg: WSMessage) => {
			if (msg.sender_id && msg.payload && typeof msg.payload === 'object') {
				await pm.handleAnswer(msg.sender_id, msg.payload as Record<string, unknown>);
			}
		}),
	);

	unsubs.push(
		signalingClient.on('ice_candidate', async (msg: WSMessage) => {
			if (msg.sender_id && msg.payload && typeof msg.payload === 'object') {
				await pm.handleIceCandidate(msg.sender_id, msg.payload as Record<string, unknown>);
			}
		}),
	);

	unsubs.push(
		signalingClient.on('encrypted_chat', (msg: WSMessage) => {
			const payload = msg.payload as { ciphertext: string; username: string } | undefined;
			if (!msg.sender_id || !payload?.ciphertext) return;

			const kp = get(e2eeKeyPair);
			const senderPk = get(peerPublicKeys).get(msg.sender_id);
			if (!kp || !senderPk) return;

			const content = decrypt(payload.ciphertext, senderPk, kp.secretKey);
			if (content === null) return;

			chatMessages.update((msgs) => {
				const next = [
					...msgs,
					{
						sender_id: msg.sender_id!,
						username: payload.username ?? 'unknown',
						content,
						timestamp: Date.now(),
					} satisfies ChatMessage,
				];
				return next.length > MAX_CHAT_MESSAGES ? next.slice(-MAX_CHAT_MESSAGES) : next;
			});
			callbacks.onChatMessage();
		}),
	);

	unsubs.push(
		signalingClient.on('peer_public_key', (msg: WSMessage) => {
			const payload = msg.payload as { key: string } | undefined;
			if (msg.sender_id && payload?.key) {
				peerPublicKeys.update((m) => {
					m.set(msg.sender_id!, importPublicKey(payload.key));
					return new Map(m);
				});
			}
		}),
	);

	unsubs.push(
		signalingClient.on('chat_history', (msg: WSMessage) => {
			const payload = msg.payload as { ciphertext: string } | undefined;
			if (!msg.sender_id || !payload?.ciphertext) return;

			const kp = get(e2eeKeyPair);
			const senderPk = get(peerPublicKeys).get(msg.sender_id);
			if (!kp || !senderPk) return;

			const json = decrypt(payload.ciphertext, senderPk, kp.secretKey);
			if (!json) return;

			try {
				const history = JSON.parse(json) as ChatMessage[];
				if (!Array.isArray(history)) return;
				chatMessages.update((msgs) => {
					// Prepend history, then cap total
					const merged = [...history, ...msgs];
					return merged.length > MAX_CHAT_MESSAGES
						? merged.slice(-MAX_CHAT_MESSAGES)
						: merged;
				});
				callbacks.onChatMessage();
			} catch {
				// Ignore malformed history
			}
		}),
	);

	unsubs.push(
		signalingClient.on('mute_state', (msg: WSMessage) => {
			const payload = msg.payload as { is_muted: boolean } | undefined;
			if (msg.sender_id && payload !== undefined) {
				pm.updatePeerState(msg.sender_id, { is_muted: payload.is_muted });
			}
		}),
	);

	unsubs.push(
		signalingClient.on('screen_share_state', (msg: WSMessage) => {
			const payload = msg.payload as { is_sharing_screen: boolean } | undefined;
			if (msg.sender_id && payload !== undefined) {
				pm.updatePeerState(msg.sender_id, { is_sharing_screen: payload.is_sharing_screen });
			}
		}),
	);

	unsubs.push(
		signalingClient.on('camera_state', (msg: WSMessage) => {
			const payload = msg.payload as { is_camera_on: boolean } | undefined;
			if (msg.sender_id && payload !== undefined) {
				pm.updatePeerState(msg.sender_id, { is_camera_on: payload.is_camera_on });
			}
		}),
	);

	unsubs.push(
		signalingClient.on('error', (msg: WSMessage) => {
			const payload = msg.payload as { message?: string } | undefined;
			if (payload?.message === 'Connection closed') {
				callbacks.onConnectionClosed();
			}
		}),
	);

	// ── Chat history relay ───────────────────────────────────────

	function sendChatHistory(targetPeerId: string, targetPk: Uint8Array): void {
		const kp = get(e2eeKeyPair);
		if (!kp) return;

		const msgs = get(chatMessages);
		if (msgs.length === 0) return;

		const recent = msgs.slice(-MAX_HISTORY_MESSAGES);
		const json = JSON.stringify(recent);
		const ciphertext = encrypt(json, targetPk, kp.secretKey);

		signalingClient.send({
			type: 'chat_history',
			target_id: targetPeerId,
			payload: { ciphertext },
		});
	}

	// ── Connect ──────────────────────────────────────────────────

	await signalingClient.connect(channelId);

	// Announce our public key so peers can encrypt messages for us
	signalingClient.send({
		type: 'public_key',
		payload: { key: exportPublicKey(keyPair.publicKey) },
	});

	return { pm, unsubs };
}

/**
 * Bind reactive Svelte store subscriptions needed by the channel page.
 * Returns unsubscribers that should be pushed into the unsubs array.
 */
export function subscribeChannelStores(setters: {
	setPeerArray: (v: PeerState[]) => void;
	setMessages: (v: ChatMessage[]) => void;
	setMuted: (v: boolean) => void;
	setSharing: (v: boolean) => void;
	setCameraOn: (v: boolean) => void;
}): (() => void)[] {
	return [
		peerList.subscribe(setters.setPeerArray),
		chatMessages.subscribe(setters.setMessages),
		isMuted.subscribe(setters.setMuted),
		isSharingScreen.subscribe(setters.setSharing),
		isCameraOn.subscribe(setters.setCameraOn),
	];
}
