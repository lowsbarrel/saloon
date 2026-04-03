<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { getBaseUrl, getAuthToken, createChannel, joinChannel } from '$lib/api';
	import {
		channels,
		currentChannel,
		userId,
		username,
		isConnected,
		resetState
	} from '$lib/stores';
	import { clearSession } from '$lib/session';
	import type { ChannelInfo } from '$lib/types';
	import { Plus, Lock, Hash, Users, MicOff, Monitor, KeyRound, Loader2, LogOut } from 'lucide-svelte';

	let loading = $state(false);
	let error = $state('');

	// Create channel form
	let showCreate = $state(false);
	let newName = $state('');
	let newIsPrivate = $state(false);
	let newPassword = $state('');

	// Join private channel
	let showJoinPrivate = $state(false);
	let joinId = $state('');
	let joinPassword = $state('');

	let channelList: ChannelInfo[] = $state([]);

	// Lobby WebSocket for real-time channel list updates
	let lobbyWs: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let mounted = true;

	onMount(() => {
		if (!get(isConnected) || !get(userId)) {
			goto('/');
			return;
		}
		connectLobbyWs();

		return () => {
			mounted = false;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (lobbyWs) {
				lobbyWs.onclose = null;
				lobbyWs.close();
				lobbyWs = null;
			}
		};
	});

	function logout() {
		mounted = false;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (lobbyWs) {
			lobbyWs.onclose = null;
			lobbyWs.close();
			lobbyWs = null;
		}
		resetState();
		goto('/');
	}

	function connectLobbyWs() {
		if (!mounted) return;
		const base = getBaseUrl().replace(/^http/, 'ws');
		const token = getAuthToken();
		const url = `${base}/ws/lobby?token=${encodeURIComponent(token)}`;

		lobbyWs = new WebSocket(url);

		lobbyWs.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);
				if (msg.type === 'channels' && Array.isArray(msg.payload)) {
					channelList = msg.payload;
					channels.set(msg.payload);
				}
			} catch {
				// ignore malformed messages
			}
		};

		lobbyWs.onerror = () => {};

		lobbyWs.onclose = (ev) => {
			lobbyWs = null;
			if (ev.code === 4001) {
				clearSession();
				resetState();
				goto('/');
				return;
			}
			if (mounted) {
				reconnectTimer = setTimeout(connectLobbyWs, 3000);
			}
		};
	}

	function handleAuthError(e: unknown): boolean {
		const msg = e instanceof Error ? e.message : '';
		if (msg === 'Unknown user' || msg === 'Invalid or expired token') {
			clearSession();
			resetState();
			goto('/');
			return true;
		}
		return false;
	}

	async function handleCreate() {
		if (!newName.trim()) return;
		if (newIsPrivate && (!newPassword || newPassword.length < 8)) {
			error = 'Password must be at least 8 characters';
			return;
		}

		loading = true;
		error = '';
		try {
			const ch = await createChannel(newName.trim(), newIsPrivate, newPassword || undefined);
			const joined = await joinChannel(ch.id, newIsPrivate ? newPassword : undefined);
			currentChannel.set(joined);
			goto(`/channel/${ch.id}`);
		} catch (e: unknown) {
			if (!handleAuthError(e)) {
				error = e instanceof Error ? e.message : 'Failed to create channel';
			}
		} finally {
			loading = false;
		}
	}

	async function handleJoinPublic(ch: ChannelInfo) {
		loading = true;
		error = '';
		try {
			const joined = await joinChannel(ch.id);
			currentChannel.set(joined);
			goto(`/channel/${ch.id}`);
		} catch (e: unknown) {
			if (!handleAuthError(e)) {
				error = e instanceof Error ? e.message : 'Failed to join channel';
			}
		} finally {
			loading = false;
		}
	}

	async function handleJoinPrivate() {
		if (!joinId.trim() || !joinPassword) return;
		loading = true;
		error = '';
		try {
			const joined = await joinChannel(joinId.trim(), joinPassword);
			currentChannel.set(joined);
			goto(`/channel/${joinId.trim()}`);
		} catch (e: unknown) {
			if (!handleAuthError(e)) {
				error = e instanceof Error ? e.message : 'Failed to join channel';
			}
		} finally {
			loading = false;
		}
	}
</script>

<div class="lobby-page">
	<header class="lobby-header">
		<div class="header-left">
			<h2>Lobby</h2>
			<span class="user-tag">signed in as {$username}</span>
		</div>
		<div class="header-actions">
			<button class="btn-ghost action-btn" onclick={() => (showJoinPrivate = !showJoinPrivate)}>
				<KeyRound size={14} />
				Join Private
			</button>
			<button class="btn-primary action-btn" onclick={() => (showCreate = !showCreate)}>
				<Plus size={14} />
				New Channel
			</button>
			<button class="btn-ghost action-btn logout-btn" onclick={logout} title="Disconnect and change server">
				<LogOut size={14} />
				Logout
			</button>
		</div>
	</header>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	<!-- Create channel form -->
	{#if showCreate}
		<div class="panel">
			<h3>New Channel</h3>
			<div class="panel-form">
				<input type="text" placeholder="Channel name" bind:value={newName} maxlength={64} />
				<label class="checkbox">
					<input type="checkbox" bind:checked={newIsPrivate} />
					<Lock size={12} />
					Private (password-protected)
				</label>
				{#if newIsPrivate}
					<input type="password" placeholder="Password (min 8 chars)" bind:value={newPassword} />
				{/if}
				<button class="btn-primary action-btn" onclick={handleCreate} disabled={loading || !newName.trim()}>
					{#if loading}
						<Loader2 size={14} class="spin" />
						Creating…
					{:else}
						Create
					{/if}
				</button>
			</div>
		</div>
	{/if}

	<!-- Join private channel form -->
	{#if showJoinPrivate}
		<div class="panel">
			<h3>Join Private Channel</h3>
			<div class="panel-form">
				<input type="text" placeholder="Channel ID" bind:value={joinId} />
				<input type="password" placeholder="Password" bind:value={joinPassword} />
				<button
					class="btn-primary action-btn"
					onclick={handleJoinPrivate}
					disabled={loading || !joinId.trim() || !joinPassword}
				>
					{#if loading}
						<Loader2 size={14} class="spin" />
						Joining…
					{:else}
						Join
					{/if}
				</button>
			</div>
		</div>
	{/if}

	<!-- Channel list -->
	<div class="channel-list">
		{#if channelList.length === 0}
			<div class="empty-state">
				<Hash size={32} strokeWidth={1.5} />
				<p>No public channels yet</p>
				<span>Create one to get started</span>
			</div>
		{:else}
			{#each channelList as ch (ch.id)}
				<button class="channel-card" onclick={() => handleJoinPublic(ch)} disabled={loading}>
					<div class="channel-info">
						<div class="channel-name-row">
							<Hash size={14} />
							<span class="channel-name">{ch.name}</span>
						</div>
						<span class="channel-count">
							<Users size={12} />
							{ch.user_count}
						</span>
					</div>
					{#if ch.users.length > 0}
						<div class="channel-users">
							{#each ch.users as u (u.id)}
								<span class="user-pill">
									{u.username}
									{#if u.is_muted}
										<MicOff size={10} />
									{/if}
									{#if u.is_sharing_screen}
										<Monitor size={10} />
									{/if}
								</span>
							{/each}
						</div>
					{/if}
				</button>
			{/each}
		{/if}
	</div>
</div>

<style>
	.lobby-page {
		flex: 1;
		display: flex;
		flex-direction: column;
		padding: 28px 32px;
		gap: 20px;
		overflow-y: auto;
		max-width: 720px;
		margin: 0 auto;
		width: 100%;
	}

	.lobby-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
	}

	.header-left h2 {
		font-size: 1.6rem;
		font-weight: 700;
		letter-spacing: -0.03em;
	}

	.user-tag {
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.header-actions {
		display: flex;
		gap: 8px;
	}

	.logout-btn {
		color: var(--danger);
	}

	.logout-btn:hover {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
	}

	.action-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
	}

	.error {
		color: var(--danger);
		font-size: 0.8rem;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--danger) 8%, transparent);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--danger) 20%, transparent);
	}

	.panel {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 20px;
	}

	.panel h3 {
		font-size: 0.9rem;
		font-weight: 600;
		margin-bottom: 14px;
	}

	.panel-form {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.checkbox {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-secondary);
		font-size: 0.8rem;
		cursor: pointer;
	}

	.checkbox input {
		width: auto;
	}

	.channel-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 64px 0;
		color: var(--text-muted);
	}

	.empty-state p {
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.empty-state span {
		font-size: 0.8rem;
	}

	.channel-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 16px 18px;
		text-align: left;
		width: 100%;
		color: var(--text-primary);
		transition: all 0.15s ease;
	}

	.channel-card:hover:not(:disabled) {
		border-color: var(--text-muted);
		background: var(--bg-hover);
	}

	.channel-info {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.channel-name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-secondary);
	}

	.channel-name {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--text-primary);
	}

	.channel-count {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.channel-users {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.user-pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: var(--bg-tertiary);
		padding: 3px 10px;
		border-radius: 20px;
		font-size: 0.7rem;
		color: var(--text-secondary);
	}
</style>
