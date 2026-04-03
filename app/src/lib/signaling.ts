/** WebSocket signaling client for WebRTC negotiation and chat. */

import { getBaseUrl, getAuthToken } from '$lib/api';
import type { WSMessage } from '$lib/types';

export type WSEventHandler = (msg: WSMessage) => void;

export class SignalingClient {
	private ws: WebSocket | null = null;
	private handlers = new Map<string, Set<WSEventHandler>>();
	private _connected = false;

	get connected(): boolean {
		return this._connected;
	}

	connect(channelId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const base = getBaseUrl().replace(/^http/, 'ws');
			const token = getAuthToken();
			const url = `${base}/ws/${encodeURIComponent(channelId)}?token=${encodeURIComponent(token)}`;

			this.ws = new WebSocket(url);

			this.ws.onopen = () => {
				this._connected = true;
				resolve();
			};

			this.ws.onerror = () => {
				reject(new Error('WebSocket connection failed'));
			};

			this.ws.onclose = () => {
				this._connected = false;
				this.emit({ type: 'error', payload: { message: 'Connection closed' } });
			};

			this.ws.onmessage = (event) => {
				try {
					const msg: WSMessage = JSON.parse(event.data);
					this.emit(msg);
				} catch {
					// Ignore malformed messages
				}
			};
		});
	}

	send(msg: WSMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	on(type: string, handler: WSEventHandler): () => void {
		if (!this.handlers.has(type)) {
			this.handlers.set(type, new Set());
		}
		this.handlers.get(type)!.add(handler);
		return () => {
			this.handlers.get(type)?.delete(handler);
		};
	}

	private emit(msg: WSMessage): void {
		const typeHandlers = this.handlers.get(msg.type);
		if (typeHandlers) {
			for (const handler of typeHandlers) {
				handler(msg);
			}
		}
		const allHandlers = this.handlers.get('*');
		if (allHandlers) {
			for (const handler of allHandlers) {
				handler(msg);
			}
		}
	}

	disconnect(): void {
		// Clear handlers FIRST so no queued onclose/onerror can invoke them.
		this.handlers.clear();
		this._connected = false;
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.onmessage = null;
			this.ws.close();
			this.ws = null;
		}
	}
}
