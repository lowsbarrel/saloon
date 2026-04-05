<script>
	import { onMount } from 'svelte';
	import '../app.css';
	import Splash from '$lib/Splash.svelte';

	const SPLASH_KEY = 'saloon_splash_seen';
	let alreadySeen = typeof localStorage !== 'undefined' && localStorage.getItem(SPLASH_KEY) === '1';
	let { children } = $props();
	let splashDone = $state(alreadySeen);
	let updateAvailable = $state(/** @type {string | null} */ (null));
	let updating = $state(false);

	function onSplashFinish() {
		splashDone = true;
		localStorage.setItem(SPLASH_KEY, '1');
	}

	async function checkForUpdate() {
		try {
			const { check } = await import('@tauri-apps/plugin-updater');
			const update = await check();
			if (update) updateAvailable = update.version;
		} catch {
			// Not running in Tauri or check failed — ignore
		}
	}

	async function installUpdate() {
		try {
			updating = true;
			const { check } = await import('@tauri-apps/plugin-updater');
			const update = await check();
			if (update) {
				await update.downloadAndInstall();
				const { relaunch } = await import('@tauri-apps/plugin-process');
				await relaunch();
			}
		} catch {
			updating = false;
		}
	}

	onMount(() => { checkForUpdate(); });
</script>

{#if !splashDone}
	<Splash onFinish={onSplashFinish} />
{/if}

<div class="app-shell" class:revealed={splashDone}>
	{#if updateAvailable}
		<div class="update-bar">
			<span>Saloon v{updateAvailable} is available.</span>
			<button class="btn-primary" onclick={installUpdate} disabled={updating}>
				{updating ? 'Updating…' : 'Update & restart'}
			</button>
			<button class="btn-ghost" onclick={() => (updateAvailable = null)}>Dismiss</button>
		</div>
	{/if}
	{@render children()}
</div>

<style>
	.app-shell {
		width: 100vw;
		height: 100vh;
		display: flex;
		flex-direction: column;
		opacity: 0;
		transition: opacity 0.5s ease;
	}

	.app-shell.revealed {
		opacity: 1;
	}

	.update-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 16px;
		background: var(--bg-tertiary);
		border-bottom: 1px solid var(--border);
		font-size: 13px;
		color: var(--text-secondary);
	}

	.update-bar span {
		flex: 1;
	}

	.update-bar button {
		padding: 4px 12px;
		font-size: 12px;
	}
</style>
