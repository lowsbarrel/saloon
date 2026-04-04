/** Persist / restore application state to sessionStorage & localStorage. */

import { get } from 'svelte/store';
import { serverUrl, userId, username, authToken } from '$lib/stores';
import { saveSession, clearSession, saveLastServer } from '$lib/session';

/** Snapshot current store values and save to sessionStorage. */
export function persistSession(channelId: string | null = null): void {
	const url = get(serverUrl);
	const uid = get(userId);
	const uname = get(username);
	const tok = get(authToken);

	if (url && uid && uname && tok) {
		saveSession({ serverUrl: url, userId: uid, username: uname, token: tok, channelId });
	}
}

/** Preserve the server URL in localStorage for the connect page, then wipe everything. */
export function persistLastServer(): void {
	const url = get(serverUrl);
	if (url) {
		saveLastServer(url);
	}
}
