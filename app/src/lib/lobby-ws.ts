/** Reusable WebSocket connection manager with auto‑reconnect. */

import { getBaseUrl, getAuthToken } from '$lib/api';

export interface LobbyWsCallbacks {
	onMessage: (msg: { type: string; payload: unknown }) => void;
	onAuthError: () => void;
}

/**
 * Manages a WebSocket connection to the lobby endpoint with
 * automatic reconnection on close (unless auth‑rejected).
 */
export class LobbyWsManager {
	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private alive = true;
	private callbacks: LobbyWsCallbacks;

	constructor(callbacks: LobbyWsCallbacks) {
		this.callbacks = callbacks;
	}

	connect(): void {
		if (!this.alive) return;

		const base = getBaseUrl().replace(/^http/, 'ws');
		const token = getAuthToken();
		const url = `${base}/ws/lobby?token=${encodeURIComponent(token)}`;

		this.ws = new WebSocket(url);

		this.ws.onmessage = (event: MessageEvent) => {
			try {
				const msg = JSON.parse(event.data as string) as { type: string; payload: unknown };
				this.callbacks.onMessage(msg);
			} catch {
				// ignore malformed messages
			}
		};

		this.ws.onerror = (event: Event) => {
			console.error('Lobby WebSocket error:', event);
		};

		this.ws.onclose = (ev: CloseEvent) => {
			this.ws = null;
			if (ev.code === 4001) {
				this.callbacks.onAuthError();
				return;
			}
			if (this.alive) {
				this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
			}
		};
	}

	disconnect(): void {
		this.alive = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.close();
			this.ws = null;
		}
	}
}
