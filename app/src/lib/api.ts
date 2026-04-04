/** REST API client for the Saloon server. */

import type { ChannelInfo, UsernameResponse, IceServersResponse } from '$lib/types';

const REQUEST_TIMEOUT_MS = 10_000;

let _baseUrl = '';
let _authToken = '';

export function setBaseUrl(url: string) {
	_baseUrl = url.replace(/\/+$/, '');
}

export function getBaseUrl(): string {
	return _baseUrl;
}

export function setAuthToken(token: string) {
	_authToken = token;
}

export function getAuthToken(): string {
	return _authToken;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...(init?.headers as Record<string, string>)
	};
	if (_authToken) {
		headers['Authorization'] = `Bearer ${_authToken}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const res = await fetch(`${_baseUrl}${path}`, {
			...init,
			headers,
			signal: controller.signal
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({ detail: res.statusText }));
			throw new Error(body.detail ?? `HTTP ${res.status}`);
		}

		if (res.status === 204) return undefined as T;
		return res.json();
	} finally {
		clearTimeout(timeout);
	}
}

export async function healthCheck(): Promise<boolean> {
	try {
		await request<{ status: string }>('/health');
		return true;
	} catch {
		return false;
	}
}

export async function createUsername(prefix: string): Promise<UsernameResponse> {
	return request<UsernameResponse>('/username', {
		method: 'POST',
		body: JSON.stringify({ prefix })
	});
}

export async function checkUser(): Promise<{ valid: boolean; user_id: string; username: string }> {
	return request<{ valid: boolean; user_id: string; username: string }>('/users/check');
}

export async function getIceServers(): Promise<IceServersResponse> {
	return request<IceServersResponse>('/ice-servers');
}

export async function listChannels(): Promise<ChannelInfo[]> {
	return request<ChannelInfo[]>('/channels');
}

export async function createChannel(
	name: string,
	isPrivate: boolean,
	password?: string
): Promise<ChannelInfo> {
	return request<ChannelInfo>('/channels', {
		method: 'POST',
		body: JSON.stringify({
			name,
			is_private: isPrivate,
			password: isPrivate ? password : undefined
		})
	});
}

export async function joinChannel(
	channelId: string,
	password?: string
): Promise<ChannelInfo> {
	return request<ChannelInfo>(`/channels/${encodeURIComponent(channelId)}/join`, {
		method: 'POST',
		body: JSON.stringify({ password: password ?? null })
	});
}

export async function leaveChannel(channelId: string): Promise<void> {
	return request<void>(
		`/channels/${encodeURIComponent(channelId)}/leave`,
		{ method: 'POST' }
	);
}
