<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { setBaseUrl, setAuthToken, healthCheck, checkUser } from '$lib/api';
	import { serverUrl, isConnected, userId, username, authToken, lastServerUrl } from '$lib/stores';
	import { loadSession, loadLastServer, saveLastServer } from '$lib/session';
	import { ErrorMsg } from '$lib/errors';
	import { ArrowRight, Loader2, TriangleAlert } from 'lucide-svelte';
	import FlameKindling from 'lucide-svelte/icons/flame-kindling';

	let url = $state('');
	let loading = $state(false);
	let error = $state('');
	let httpWarning = $derived(
		url.trim().toLowerCase().startsWith('http://') &&
		!url.trim().match(/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)*/i)
	);

	onMount(async () => {
		const saved = get(lastServerUrl) || loadLastServer();
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
					error = ErrorMsg.SESSION_EXPIRED;
				}
			}
			setAuthToken('');
		}
	});

	async function connect() {
		const trimmed = url.trim().replace(/\/+$/, '');
		if (!trimmed) {
			error = ErrorMsg.URL_REQUIRED;
			return;
		}

		loading = true;
		error = '';

		try {
			setBaseUrl(trimmed);
			const ok = await healthCheck();
			if (!ok) {
				error = ErrorMsg.SERVER_UNREACHABLE;
				return;
			}
			serverUrl.set(trimmed);
			isConnected.set(true);
			saveLastServer(trimmed);
			goto('/username');
		} catch {
			error = ErrorMsg.CONNECT_FAILED;
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
			{#if httpWarning}
				<p class="http-warning">
					<TriangleAlert size={13} />
					Insecure connection — your traffic won't be encrypted. Use <strong>https://</strong> for remote servers.
				</p>
			{/if}
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

	.http-warning {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.75rem;
		color: var(--warning, #e0a800);
		background: color-mix(in srgb, var(--warning, #e0a800) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--warning, #e0a800) 20%, transparent);
		border-radius: var(--radius-sm);
		padding: 8px 12px;
		text-align: left;
		line-height: 1.5;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
</style>
