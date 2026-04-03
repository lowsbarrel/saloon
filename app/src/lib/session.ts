/**
 * Persist key stores to sessionStorage so page reloads
 * don't lose the connection/user state.
 */

const KEY = 'saloon_session';

interface SessionData {
	serverUrl: string;
	userId: string;
	username: string;
	channelId: string | null;
}

export function saveSession(data: SessionData): void {
	try {
		sessionStorage.setItem(KEY, JSON.stringify(data));
	} catch {
		// Storage full or unavailable — ignore
	}
}

export function loadSession(): SessionData | null {
	try {
		const raw = sessionStorage.getItem(KEY);
		if (!raw) return null;
		const data = JSON.parse(raw);
		if (data && typeof data.serverUrl === 'string' && typeof data.userId === 'string') {
			return data as SessionData;
		}
	} catch {
		// Corrupt data — ignore
	}
	return null;
}

export function clearSession(): void {
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		// ignore
	}
}
