<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { setBaseUrl, setAuthToken, healthCheck, checkUser } from '$lib/api';
	import { serverUrl, isConnected, userId, username, authToken, lastServerUrl } from '$lib/stores';
	import { loadSession } from '$lib/session';
	import { ArrowRight, Loader2 } from 'lucide-svelte';
	import FlameKindling from 'lucide-svelte/icons/flame-kindling';

	let url = $state('');
	let loading = $state(false);
	let error = $state('');

	onMount(async () => {
		const saved = get(lastServerUrl);
		const session = loadSession();

		if (saved) {
			url = saved;
		} else if (session?.serverUrl) {
			url = session.serverUrl;
		}

		if (session?.token) {
			setBaseUrl(session.serverUrl);
			setAuthToken(session.token);
			const ok = await healthCheck();
			if (ok) {
				try {
					const result = await checkUser();
					if (result.valid) {
						serverUrl.set(session.serverUrl);
						isConnected.set(true);
						userId.set(result.user_id);
						username.set(result.username);
						authToken.set(session.token);
						goto(session.channelId ? `/channel/${session.channelId}` : '/lobby');
						return;
					}
				} catch {
					error = 'Session expired. Please reconnect.';
				}
			}
			// Reset token if session restore failed
			setAuthToken('');
		}
	});

	async function connect() {
		const trimmed = url.trim().replace(/\/+$/, '');
		if (!trimmed) {
			error = 'Enter a server URL';
			return;
		}

		loading = true;
		error = '';

		try {
			setBaseUrl(trimmed);
			const ok = await healthCheck();
			if (!ok) {
				error = 'Server unreachable';
				return;
			}
			serverUrl.set(trimmed);
			isConnected.set(true);
			goto('/username');
		} catch {
			error = 'Could not connect to server';
		} finally {
			loading = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') connect();
	}
</script>

<div class="connect-page">
	<div class="connect-card">
		<h1 class="brand"><FlameKindling size={32} strokeWidth={1.5} /> Saloon</h1>
		<p class="subtitle">Privacy-first voice chat</p>

		<div class="form">
			<input
				type="text"
				placeholder="Server URL (e.g. http://localhost:8000)"
				bind:value={url}
				onkeydown={onKeydown}
				disabled={loading}
			/>
			<button class="btn-primary connect-btn" onclick={connect} disabled={loading || !url.trim()}>
				{#if loading}
					<Loader2 size={16} class="spin" />
					Connecting…
				{:else}
					Connect
					<ArrowRight size={16} />
				{/if}
			</button>
		</div>

		{#if error}
			<p class="error">{error}</p>
		{/if}
	</div>
</div>

<style>
	.connect-page {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.connect-card {
		text-align: center;
		max-width: 380px;
		width: 100%;
		padding: 32px;
	}

	h1 {
		font-family: var(--font-serif);
		font-size: 2.8rem;
		font-weight: 400;
		letter-spacing: -0.02em;
		margin-bottom: 6px;
	}

	.brand {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
	}

	.subtitle {
		color: var(--text-secondary);
		margin-bottom: 40px;
		font-size: 0.95rem;
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	input {
		width: 100%;
		padding: 12px 16px;
		font-size: 0.9rem;
		border-radius: var(--radius-sm);
	}

	.connect-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px;
		font-size: 0.9rem;
		font-weight: 500;
	}

	.error {
		color: var(--danger);
		margin-top: 16px;
		font-size: 0.8rem;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
</style>
