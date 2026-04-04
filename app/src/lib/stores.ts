/** Global application state stores. */

import { writable, derived, get } from 'svelte/store';
import type { ChannelInfo, ChatMessage, PeerState } from '$lib/types';
import { SignalingClient } from '$lib/signaling';
import { PeerManager } from '$lib/webrtc/peer-manager';
import { clearSession, saveLastServer } from '$lib/session';

// ── Connection ────────────────────────────────────────────────────────────

export const serverUrl = writable<string>('');
export const isConnected = writable<boolean>(false);
export const lastServerUrl = writable<string>('');

// ── User ──────────────────────────────────────────────────────────────────

export const userId = writable<string>('');
export const username = writable<string>('');
export const authToken = writable<string>('');

// ── Channel ───────────────────────────────────────────────────────────────

export const currentChannel = writable<ChannelInfo | null>(null);
export const channels = writable<ChannelInfo[]>([]);

// ── Peers & Media ─────────────────────────────────────────────────────────

export const peers = writable<Map<string, PeerState>>(new Map());
export const isMuted = writable<boolean>(false);
export const isSharingScreen = writable<boolean>(false);
export const isCameraOn = writable<boolean>(false);

// ── Chat ──────────────────────────────────────────────────────────────────

export const chatMessages = writable<ChatMessage[]>([]);

// ── Singletons ────────────────────────────────────────────────────────────

export const signalingClient = new SignalingClient();

let _peerManager: PeerManager | null = null;

export function getPeerManager(): PeerManager | null {
	return _peerManager;
}

export function createPeerManager(uid: string): PeerManager {
	_peerManager?.destroy();
	_peerManager = new PeerManager(signalingClient, uid, (newPeers) => {
		peers.set(newPeers);
	});
	return _peerManager;
}

export function destroyPeerManager(): void {
	_peerManager?.destroy();
	_peerManager = null;
	peers.set(new Map());
}

// ── Derived ───────────────────────────────────────────────────────────────

export const peerList = derived(peers, ($peers) => Array.from($peers.values()));

/** Reset all state (disconnect). */
export function resetState(): void {
	const url = get(serverUrl);
	if (url) {
		lastServerUrl.set(url);
		saveLastServer(url);
	}

	destroyPeerManager();
	signalingClient.disconnect();
	clearSession();
	serverUrl.set('');
	isConnected.set(false);
	userId.set('');
	username.set('');
	authToken.set('');
	currentChannel.set(null);
	channels.set([]);
	chatMessages.set([]);
	isMuted.set(false);
	isSharingScreen.set(false);
	isCameraOn.set(false);
}
