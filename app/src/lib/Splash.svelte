<script lang="ts">
	import { onMount } from 'svelte';
	import FlameKindling from 'lucide-svelte/icons/flame-kindling';

	let { onFinish }: { onFinish: () => void } = $props();

	let phase = $state<'logo' | 'tagline' | 'fadeout'>('logo');
	let visible = $state(true);

	onMount(() => {
		// Phase 1: Show "Saloon" for ~1.8s (letters animate in over ~0.8s, hold)
		setTimeout(() => {
			phase = 'tagline';
		}, 1800);

		// Phase 2: Show tagline for ~1.8s
		setTimeout(() => {
			phase = 'fadeout';
		}, 3600);

		// Phase 3: Fade everything out and finish
		setTimeout(() => {
			visible = false;
			onFinish();
		}, 4400);
	});

	const letters = 'Saloon'.split('');
</script>

{#if visible}
	<div class="splash" class:fadeout={phase === 'fadeout'}>
		<div class="splash-content">
			{#if phase === 'logo' || phase === 'tagline'}
				<div class="logo-row" class:slide-up={phase === 'tagline'}>
					<FlameKindling size={44} strokeWidth={1.3} class="splash-icon" />
					<h1 class="splash-title">
						{#each letters as letter, i}
							<span class="letter" style="animation-delay: {i * 0.09}s">{letter}</span>
						{/each}
					</h1>
				</div>
			{/if}

			{#if phase === 'tagline'}
				<p class="tagline">chat with who you really want</p>
			{/if}
		</div>
	</div>
{/if}

<style>
	.splash {
		position: fixed;
		inset: 0;
		z-index: 9999;
		background: var(--bg-primary);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: opacity 0.7s ease;
	}

	.splash.fadeout {
		opacity: 0;
	}

	.splash-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 20px;
	}

	.logo-row {
		display: flex;
		align-items: center;
		gap: 14px;
		transition: all 0.6s cubic-bezier(0.22, 1, 0.36, 1);
	}

	.logo-row :global(.splash-icon) {
		opacity: 0;
		animation: iconIn 0.5s ease forwards;
		animation-delay: 0.1s;
	}

	.logo-row.slide-up {
		transform: translateY(-18px);
		opacity: 0.6;
		filter: blur(2px);
		scale: 0.92;
	}

	.splash-title {
		font-family: var(--font-serif);
		font-size: 4.2rem;
		font-weight: 400;
		letter-spacing: -0.03em;
		color: var(--text-primary);
		display: flex;
	}

	.letter {
		display: inline-block;
		opacity: 0;
		transform: translateY(20px) scale(0.8);
		animation: letterIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards;
	}

	.tagline {
		font-family: var(--font-serif);
		font-style: italic;
		font-size: 1.15rem;
		color: var(--text-secondary);
		letter-spacing: 0.01em;
		opacity: 0;
		transform: translateY(8px);
		animation: taglineIn 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.15s forwards;
	}

	@keyframes letterIn {
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@keyframes iconIn {
		from {
			opacity: 0;
			transform: scale(0.7) rotate(-10deg);
		}
		to {
			opacity: 1;
			transform: scale(1) rotate(0deg);
		}
	}

	@keyframes taglineIn {
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
