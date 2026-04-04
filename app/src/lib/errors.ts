/** Centralized error messages and async error‑handling helpers. */

import { goto } from '$app/navigation';
import { clearSession } from '$lib/session';

// ── Error Messages ────────────────────────────────────────────────────────

export const ErrorMsg = {
	CONNECT_FAILED: 'Could not connect to server',
	SERVER_UNREACHABLE: 'Server unreachable',
	SESSION_EXPIRED: 'Session expired. Please reconnect.',
	URL_REQUIRED: 'Enter a server URL',
	CHANNEL_CREATE: 'Failed to create channel',
	CHANNEL_JOIN: 'Failed to join channel',
	USERNAME_GENERATE: 'Failed to generate username',
	MIC_SWITCH: 'Failed to switch microphone',
	SPEAKER_SWITCH: 'Failed to switch speaker',
	CAMERA_START: 'Failed to start camera',
	CAMERA_SWITCH: 'Failed to switch camera',
	CHANNEL_JOIN_INIT: 'Failed to join channel',
	PASSWORD_MIN: 'Password must be at least 8 characters',
	PREFIX_FORMAT: 'Prefix must be 3–16 lowercase alphanumeric characters',
	PREFIX_CHARS: 'Only lowercase letters and numbers allowed',
} as const;

// ── Auth Error Detection ──────────────────────────────────────────────────

const AUTH_ERROR_PATTERNS = [
	'Unknown user',
	'Invalid or expired token',
	'401',
	'Unauthorized',
] as const;

/** Returns `true` when the error looks like an authentication failure. */
export function isAuthError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return AUTH_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * If `e` is an auth error, clear the session and redirect to `/`.
 * @returns `true` when the error was handled (callers should bail out).
 */
export function handleAuthError(e: unknown, resetState: () => void): boolean {
	if (isAuthError(e)) {
		clearSession();
		resetState();
		goto('/');
		return true;
	}
	return false;
}

// ── Async Helpers ────────────────────────────────────────────────────────

/** Extract a human‑readable message from unknown catch values. */
export function errorMessage(e: unknown, fallback: string): string {
	return e instanceof Error ? e.message : fallback;
}

export interface TryCatchResult<T> {
	data: T | null;
	error: string;
}

/**
 * Run an async operation with standardised error handling.
 *
 * @param fn         The async work to perform.
 * @param fallback   Message shown when the error is not an Error instance.
 * @param resetState The store‑reset function for auth‑error handling.
 * @returns `{ data, error }` — `error` is empty on success.
 */
export async function tryCatch<T>(
	fn: () => Promise<T>,
	fallback: string,
	resetState: () => void,
): Promise<TryCatchResult<T>> {
	try {
		const data = await fn();
		return { data, error: '' };
	} catch (e: unknown) {
		if (handleAuthError(e, resetState)) {
			return { data: null, error: '' };
		}
		return { data: null, error: errorMessage(e, fallback) };
	}
}
