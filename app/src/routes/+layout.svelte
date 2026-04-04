<script>
	import '../app.css';
	import Splash from '$lib/Splash.svelte';

	const SPLASH_KEY = 'saloon_splash_seen';
	let alreadySeen = typeof localStorage !== 'undefined' && localStorage.getItem(SPLASH_KEY) === '1';
	let { children } = $props();
	let splashDone = $state(alreadySeen);

	function onSplashFinish() {
		splashDone = true;
		localStorage.setItem(SPLASH_KEY, '1');
	}
</script>

{#if !splashDone}
	<Splash onFinish={onSplashFinish} />
{/if}

<div class="app-shell" class:revealed={splashDone}>
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
</style>
