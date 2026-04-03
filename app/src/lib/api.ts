/** REST API client for the Saloon server. */

import type { ChannelInfo, UsernameResponse } from '$lib/types';

let _baseUrl = '';

export function setBaseUrl(url: string) {
	_baseUrl = url.replace(/\/+$/, '');
}

export function getBaseUrl(): string {
	return _baseUrl;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${_baseUrl}${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...init?.headers
		}
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({ detail: res.statusText }));
		throw new Error(body.detail ?? `HTTP ${res.status}`);
	}

	if (res.status === 204) return undefined as T;
	return res.json();
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

export async function checkUser(userId: string): Promise<boolean> {
	try {
		await request<{ valid: boolean }>(`/users/${encodeURIComponent(userId)}/check`);
		return true;
	} catch {
		return false;
	}
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
	userId: string,
	password?: string
): Promise<ChannelInfo> {
	return request<ChannelInfo>(`/channels/${encodeURIComponent(channelId)}/join`, {
		method: 'POST',
		body: JSON.stringify({ user_id: userId, password: password ?? null })
	});
}

export async function leaveChannel(channelId: string, userId: string): Promise<void> {
	return request<void>(
		`/channels/${encodeURIComponent(channelId)}/leave?user_id=${encodeURIComponent(userId)}`,
		{ method: 'POST' }
	);
}
