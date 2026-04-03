<script lang="ts">
	import { goto } from '$app/navigation';
	import { createUsername } from '$lib/api';
	import { setAuthToken } from '$lib/api';
	import { userId, username, isConnected, authToken, persistSession } from '$lib/stores';
	import { get } from 'svelte/store';
	import { onMount } from 'svelte';
	import { RefreshCw, Check, Loader2, User } from 'lucide-svelte';

	let prefix = $state('');
	let generatedName = $state('');
	let generatedId = $state('');
	let generatedToken = $state('');
	let loading = $state(false);
	let error = $state('');
	let step: 'input' | 'confirm' = $state('input');

	onMount(() => {
		if (!get(isConnected)) goto('/');
	});

	async function generate() {
		const trimmed = prefix.trim().toLowerCase();
		if (trimmed.length < 3 || trimmed.length > 16) {
			error = 'Prefix must be 3–16 lowercase alphanumeric characters';
			return;
		}
		if (!/^[a-z0-9]+$/.test(trimmed)) {
			error = 'Only lowercase letters and numbers allowed';
			return;
		}

		loading = true;
		error = '';

		try {
			const res = await createUsername(trimmed);
			generatedName = res.username;
			generatedId = res.user_id;
			generatedToken = res.token;
			step = 'confirm';
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : 'Failed to generate username';
		} finally {
			loading = false;
		}
	}

	function confirm() {
		userId.set(generatedId);
		username.set(generatedName);
		authToken.set(generatedToken);
		setAuthToken(generatedToken);
		persistSession(null);
		goto('/lobby');
	}

	function reroll() {
		step = 'input';
		generatedName = '';
		generatedId = '';
		generatedToken = '';
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') generate();
	}
</script>

<div class="username-page">
	<div class="card">
		<div class="icon-wrap">
			<User size={24} />
		</div>
		<h2>Choose your name</h2>
		<p class="hint">Pick a prefix — we'll add a random suffix to make it unique.</p>

		{#if step === 'input'}
			<div class="form">
				<input
					type="text"
					placeholder="Your prefix (e.g. cosmic)"
					bind:value={prefix}
					onkeydown={onKeydown}
					disabled={loading}
					maxlength={16}
				/>
				<button class="btn-primary generate-btn" onclick={generate} disabled={loading || prefix.trim().length < 3}>
					{#if loading}
						<Loader2 size={16} class="spin" />
						Generating…
					{:else}
						Generate
					{/if}
				</button>
			</div>
		{:else}
			<div class="result">
				<p class="generated-name">{generatedName}</p>
				<div class="actions">
					<button class="btn-ghost reroll-btn" onclick={reroll}>
						<RefreshCw size={14} />
						Re-roll
					</button>
					<button class="btn-primary confirm-btn" onclick={confirm}>
						<Check size={14} />
						Use this name
					</button>
				</div>
			</div>
		{/if}

		{#if error}
			<p class="error">{error}</p>
		{/if}
	</div>
</div>

<style>
	.username-page {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.card {
		text-align: center;
		max-width: 400px;
		width: 100%;
		padding: 32px;
	}

	.icon-wrap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		margin-bottom: 20px;
		color: var(--text-secondary);
	}

	h2 {
		font-size: 1.5rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		margin-bottom: 6px;
	}

	.hint {
		color: var(--text-secondary);
		margin-bottom: 28px;
		font-size: 0.85rem;
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
	}

	.generate-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 12px;
		font-size: 0.9rem;
	}

	.result {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.generated-name {
		font-size: 1.8rem;
		font-weight: 700;
		letter-spacing: -0.03em;
		word-break: break-all;
	}

	.actions {
		display: flex;
		gap: 12px;
		justify-content: center;
	}

	.reroll-btn, .confirm-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85rem;
	}

	.error {
		color: var(--danger);
		margin-top: 16px;
		font-size: 0.8rem;
	}
</style>
