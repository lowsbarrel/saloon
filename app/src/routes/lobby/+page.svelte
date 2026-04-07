<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { createChannel, joinChannel } from '$lib/api';
	import {
		channels,
		currentChannel,
		userId,
		username,
		isConnected,
		resetState
	} from '$lib/stores';
	import { clearSession } from '$lib/session';
	import { tryCatch, ErrorMsg } from '$lib/errors';
	import { LobbyWsManager } from '$lib/lobby-ws';
	import type { ChannelInfo } from '$lib/types';
	import { Plus, Lock, Hash, Users, MicOff, Monitor, KeyRound, Loader2, LogOut, Search } from 'lucide-svelte';

	let loading = $state(false);
	let error = $state('');

	let showCreate = $state(false);
	let newName = $state('');
	let newIsPrivate = $state(false);
	let newPassword = $state('');

	let showJoinPrivate = $state(false);
	let joinId = $state('');
	let joinPassword = $state('');

	let channelList: ChannelInfo[] = $state([]);
	let searchQuery = $state('');
	let filteredChannels = $derived(
		channelList.filter((ch) =>
			ch.name.toLowerCase().includes(searchQuery.toLowerCase().trim())
		)
	);

	let lobbyWs: LobbyWsManager | null = null;

	onMount(() => {
		if (!get(isConnected) || !get(userId)) {
			goto('/');
			return;
		}

		lobbyWs = new LobbyWsManager({
			onMessage(msg) {
				if (msg.type === 'channels' && Array.isArray(msg.payload)) {
					channelList = msg.payload as ChannelInfo[];
					channels.set(msg.payload as ChannelInfo[]);
				}
			},
			onAuthError() {
				clearSession();
				resetState();
				goto('/');
			}
		});
		lobbyWs.connect();

		return () => {
			lobbyWs?.disconnect();
		};
	});

	function logout(): void {
		lobbyWs?.disconnect();
		resetState();
		goto('/');
	}

	async function handleCreate(): Promise<void> {
		if (!newName.trim()) return;
		if (newIsPrivate && (!newPassword || newPassword.length < 8)) {
			error = ErrorMsg.PASSWORD_MIN;
			return;
		}

		loading = true;
		error = '';
		const result = await tryCatch(
			async () => {
				const ch = await createChannel(newName.trim(), newIsPrivate, newPassword || undefined);
				return joinChannel(ch.id, newIsPrivate ? newPassword : undefined);
			},
			ErrorMsg.CHANNEL_CREATE,
			resetState,
		);
		if (result.error) {
			error = result.error;
		} else if (result.data) {
			currentChannel.set(result.data);
			goto(`/channel/${result.data.id}`);
		}
		loading = false;
	}

	async function handleJoinPublic(ch: ChannelInfo): Promise<void> {
		loading = true;
		error = '';
		const result = await tryCatch(
			() => joinChannel(ch.id),
			ErrorMsg.CHANNEL_JOIN,
			resetState,
		);
		if (result.error) {
			error = result.error;
		} else if (result.data) {
			currentChannel.set(result.data);
			goto(`/channel/${result.data.id}`);
		}
		loading = false;
	}

	async function handleJoinPrivate(): Promise<void> {
		if (!joinId.trim() || !joinPassword) return;
		loading = true;
		error = '';
		const result = await tryCatch(
			() => joinChannel(joinId.trim(), joinPassword),
			ErrorMsg.CHANNEL_JOIN,
			resetState,
		);
		if (result.error) {
			error = result.error;
		} else if (result.data) {
			currentChannel.set(result.data);
			goto(`/channel/${result.data.id}`);
		}
		loading = false;
	}
</script>

<div class="lobby-page">
	<header class="lobby-header">
		<div class="header-left">
			<h2>Lobby</h2>
			<span class="user-tag">{$username}</span>
		</div>
		<div class="header-actions">
			<button class="btn-ghost action-btn" onclick={() => (showJoinPrivate = !showJoinPrivate)}>
				<KeyRound size={14} />
				<span class="action-label">Join Private</span>
			</button>
			<button class="btn-primary action-btn" onclick={() => (showCreate = !showCreate)}>
				<Plus size={14} />
				<span class="action-label">New Channel</span>
			</button>
			<button class="btn-ghost action-btn logout-btn" onclick={logout} title="Disconnect and change server">
				<LogOut size={14} />
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
				<input type="text" placeholder="Private channel name or invite link" bind:value={joinId} />
				<p class="panel-hint">Private channel names are unique. We normalize them to lowercase slugs automatically.</p>
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

	<!-- Search + Channel list -->
	{#if channelList.length > 0}
		<div class="search-bar">
			<Search size={14} />
			<input type="text" placeholder="Search channels…" bind:value={searchQuery} />
		</div>
	{/if}

	<div class="channel-list">
		{#if channelList.length === 0}
			<div class="empty-state">
				<Hash size={32} strokeWidth={1.5} />
				<p>No public channels yet</p>
				<span>Create one to get started</span>
			</div>
		{:else if filteredChannels.length === 0}
			<div class="empty-state">
				<Search size={28} strokeWidth={1.5} />
				<p>No channels match "{searchQuery}"</p>
			</div>
		{:else}
			{#each filteredChannels as ch (ch.id)}
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
		-webkit-overflow-scrolling: touch;
	}

	.lobby-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}

	.header-left {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}

	.header-left h2 {
		font-size: 1.6rem;
		font-weight: 700;
		letter-spacing: -0.03em;
		flex-shrink: 0;
	}

	.user-tag {
		color: var(--text-muted);
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.header-actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}

	.action-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
	}

	.logout-btn {
		color: var(--danger);
	}

	.logout-btn:hover {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
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

	.panel-hint {
		font-size: 0.85rem;
		color: var(--text-secondary);
		line-height: 1.4;
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

	.search-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0 14px;
		color: var(--text-muted);
	}

	.search-bar input {
		flex: 1;
		background: none;
		border: none;
		outline: none;
		padding: 10px 0;
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	.search-bar input::placeholder {
		color: var(--text-muted);
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
		min-width: 0;
	}

	.channel-name {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.channel-count {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--text-muted);
		font-size: 0.75rem;
		flex-shrink: 0;
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

	/* ── Mobile ──────────────────────────────────────────── */

	@media (max-width: 600px) {
		.lobby-page {
			padding: 20px 16px;
			gap: 16px;
		}

		.lobby-header {
			flex-direction: column;
			align-items: stretch;
			gap: 12px;
		}

		.header-left {
			justify-content: space-between;
		}

		.header-left h2 {
			font-size: 1.3rem;
		}

		.header-actions {
			display: grid;
			grid-template-columns: 1fr 1fr auto;
			gap: 8px;
		}

		.action-btn {
			justify-content: center;
			padding: 10px 12px;
		}

		.action-label {
			display: inline;
		}

		.panel {
			padding: 16px;
		}

		.channel-card {
			padding: 14px;
		}

		.empty-state {
			padding: 40px 0;
		}
	}

	@media (max-width: 380px) {
		.action-label {
			display: none;
		}

		.header-actions {
			grid-template-columns: auto auto auto;
			justify-content: flex-start;
		}
	}
</style>
