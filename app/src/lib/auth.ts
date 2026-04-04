/** Shared authentication error handler. */

import { goto } from '$app/navigation';
import { clearSession } from '$lib/session';
import { resetState } from '$lib/stores';

const AUTH_ERROR_MESSAGES = new Set(['Unknown user', 'Invalid or expired token']);

export function handleAuthError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : '';
	if (AUTH_ERROR_MESSAGES.has(msg)) {
		clearSession();
		resetState();
		goto('/');
		return true;
	}
	return false;
}
