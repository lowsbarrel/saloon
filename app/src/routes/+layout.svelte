<script>
	import '../app.css';
	let { children } = $props();
</script>

<div class="app-shell">
	{@render children()}
</div>

<style>
	.app-shell {
		width: 100vw;
		height: 100vh;
		display: flex;
		flex-direction: column;
	}
</style>
