<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { leaveChannel, getIceServers } from '$lib/api';
	import {
		userId,
		username,
		currentChannel,
		isConnected,
		signalingClient,
		createPeerManager,
		destroyPeerManager,
		getPeerManager,
		peers,
		peerList,
		isMuted,
		isSharingScreen,
		chatMessages,
		persistSession,
		resetState
	} from '$lib/stores';
	import type { ChatMessage, PeerState, WSMessage } from '$lib/types';
	import {
		Mic,
		MicOff,
		Monitor,
		MonitorOff,
		LogOut,
		Send,
		Maximize2,
		Minimize2,
		X,
		MessageSquare,
		Users,
		ChevronRight,
		ChevronDown,
		Settings
	} from 'lucide-svelte';

	const channelId = $derived($page.params.id ?? '');
	let chatInput = $state('');
	let chatContainer: HTMLDivElement = $state(undefined!);
	let messages: ChatMessage[] = $state([]);
	let peerArray: PeerState[] = $state([]);
	let muted = $state(false);
	let sharing = $state(false);
	let error = $state('');

	// Track which peer's screen is fullscreen (null = grid view)
	let fullscreenPeerId: string | null = $state(null);
	// Chat panel open
	let chatOpen = $state(true);
	// Flag to prevent error handler from wiping state on intentional leave
	let intentionalLeave = false;

	// Audio device selection
	let showDevicePicker = $state(false);
	let audioInputDevices: MediaDeviceInfo[] = $state([]);
	let audioOutputDevices: MediaDeviceInfo[] = $state([]);
	let selectedInputId = $state('');
	let selectedOutputId = $state('');

	const unsubs: (() => void)[] = [];

	// Derived: peers who are sharing screens
	let screenSharers = $derived(peerArray.filter((p) => p.is_sharing_screen && p.screenStream));

	onMount(async () => {
		if (!get(isConnected) || !get(userId)) {
			goto('/');
			return;
		}

		const uid = get(userId);

		try {
			const pm = createPeerManager(uid);

			// Fetch ICE servers (includes TURN if configured)
			try {
				const iceConfig = await getIceServers();
				pm.setIceServers(iceConfig.ice_servers);
			} catch {
				// Fall back to default STUN-only config
			}

			await pm.initLocalAudio();

			unsubs.push(peerList.subscribe((v) => (peerArray = v)));
			unsubs.push(chatMessages.subscribe((v) => (messages = v)));
			unsubs.push(isMuted.subscribe((v) => (muted = v)));
			unsubs.push(isSharingScreen.subscribe((v) => (sharing = v)));

			unsubs.push(
				signalingClient.on('peer_list', (msg: WSMessage) => {
					const list = (msg.payload as unknown) as Array<{
						id: string;
						username: string;
						is_muted: boolean;
						is_sharing_screen: boolean;
					}>;
					if (!Array.isArray(list)) return;
					for (const p of list) {
						pm.createPeerConnection(p.id, p.username, true);
					}
				})
			);

			unsubs.push(
				signalingClient.on('peer_joined', (msg: WSMessage) => {
					const payload = msg.payload as { username: string } | undefined;
					if (msg.sender_id && payload?.username) {
						pm.registerPeer(msg.sender_id, payload.username);
					}
				})
			);

			unsubs.push(
				signalingClient.on('peer_left', (msg: WSMessage) => {
					if (msg.sender_id) {
						pm.removePeer(msg.sender_id);
						if (fullscreenPeerId === msg.sender_id) fullscreenPeerId = null;
					}
				})
			);

			unsubs.push(
				signalingClient.on('offer', async (msg: WSMessage) => {
					if (msg.sender_id && msg.payload && typeof msg.payload === 'object') {
						await pm.handleOffer(
							msg.sender_id,
							msg.sender_id,
							msg.payload as Record<string, unknown>
						);
					}
				})
			);

			unsubs.push(
				signalingClient.on('answer', async (msg: WSMessage) => {
					if (msg.sender_id && msg.payload && typeof msg.payload === 'object') {
						await pm.handleAnswer(
							msg.sender_id,
							msg.payload as Record<string, unknown>
						);
					}
				})
			);

			unsubs.push(
				signalingClient.on('ice_candidate', async (msg: WSMessage) => {
					if (msg.sender_id && msg.payload && typeof msg.payload === 'object') {
						await pm.handleIceCandidate(
							msg.sender_id,
							msg.payload as Record<string, unknown>
						);
					}
				})
			);

			unsubs.push(
				signalingClient.on('chat_message', (msg: WSMessage) => {
					const payload = msg.payload as { content: string; username: string } | undefined;
					if (msg.sender_id && payload?.content) {
						chatMessages.update((msgs) => [
							...msgs,
							{
								sender_id: msg.sender_id!,
								username: payload.username ?? 'unknown',
								content: payload.content,
								timestamp: Date.now()
							}
						]);
						requestAnimationFrame(() => {
							if (chatContainer) {
								chatContainer.scrollTop = chatContainer.scrollHeight;
							}
						});
					}
				})
			);

			unsubs.push(
				signalingClient.on('mute_state', (msg: WSMessage) => {
					const payload = msg.payload as { is_muted: boolean } | undefined;
					if (msg.sender_id && payload !== undefined) {
						pm.updatePeerState(msg.sender_id, { is_muted: payload.is_muted });
					}
				})
			);

			unsubs.push(
				signalingClient.on('screen_share_state', (msg: WSMessage) => {
					const payload = msg.payload as { is_sharing_screen: boolean } | undefined;
					if (msg.sender_id && payload !== undefined) {
						pm.updatePeerState(msg.sender_id, {
							is_sharing_screen: payload.is_sharing_screen
						});
					}
				})
			);

			unsubs.push(
				signalingClient.on('error', (msg: WSMessage) => {
					const payload = msg.payload as { message?: string } | undefined;
					if (payload?.message === 'Connection closed' && !intentionalLeave) {
						resetState();
						goto('/');
					}
				})
			);

			await signalingClient.connect(channelId);
			persistSession(channelId);
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : 'Failed to join channel';
		}
	});

	onDestroy(() => {
		intentionalLeave = true;
		for (const unsub of unsubs) unsub();
		unsubs.length = 0;
		destroyPeerManager();
		signalingClient.disconnect();
	});

	function leave() {
		intentionalLeave = true;
		// Unsubscribe all signaling handlers immediately so no queued
		// onclose/error event can call resetState() after we navigate.
		for (const unsub of unsubs) unsub();
		unsubs.length = 0;
		// Fast path: signal leave over the already-open WebSocket. The server
		// notifies remaining peers inline — no HTTP round-trip needed.
		// send() is synchronous (buffers into the socket); the message is
		// guaranteed to be flushed before the Close frame that disconnect() sends.
		signalingClient.send({ type: 'leave' });
		// Fallback: fire-and-forget REST call in case the WS message was lost
		// (e.g. socket was already closing). Also acts as a belt-and-suspenders
		// keep_alive guard so the user stays registered for the lobby.
		leaveChannel(channelId).catch(() => {});
		destroyPeerManager();
		signalingClient.disconnect();
		currentChannel.set(null);
		chatMessages.set([]);
		persistSession(null);
		goto('/lobby');
	}

	function toggleMute() {
		const newMuted = !muted;
		isMuted.set(newMuted);
		getPeerManager()?.setLocalMuted(newMuted);
	}

	async function toggleDevicePicker() {
		showDevicePicker = !showDevicePicker;
		if (showDevicePicker) {
			await refreshDeviceList();
		}
	}

	async function refreshDeviceList() {
		const devices = await navigator.mediaDevices.enumerateDevices();
		audioInputDevices = devices.filter((d) => d.kind === 'audioinput');
		audioOutputDevices = devices.filter((d) => d.kind === 'audiooutput');
	}

	async function switchInput(e: Event) {
		const deviceId = (e.target as HTMLSelectElement).value;
		selectedInputId = deviceId;
		try {
			await getPeerManager()?.switchAudioInput(deviceId);
		} catch {
			error = 'Failed to switch microphone';
		}
	}

	async function switchOutput(e: Event) {
		const deviceId = (e.target as HTMLSelectElement).value;
		selectedOutputId = deviceId;
		try {
			await getPeerManager()?.switchAudioOutput(deviceId);
		} catch {
			error = 'Failed to switch speaker';
		}
	}

	async function toggleScreenShare() {
		const pm = getPeerManager();
		if (!pm) return;

		if (sharing) {
			pm.stopScreenShare();
			isSharingScreen.set(false);
		} else {
			try {
				await pm.startScreenShare();
				isSharingScreen.set(true);
			} catch {
				// User cancelled screen picker
			}
		}
	}

	function setVolume(peerId: string, e: Event) {
		const input = e.target as HTMLInputElement;
		getPeerManager()?.setVolume(peerId, parseFloat(input.value));
	}

	// Drag-to-volume on user cards
	function startVolumeDrag(peerId: string, e: PointerEvent) {
		const el = (e.currentTarget as HTMLElement);
		el.setPointerCapture(e.pointerId);
		updateVolFromPointer(peerId, el, e);

		const onMove = (ev: PointerEvent) => updateVolFromPointer(peerId, el, ev);
		const onUp = () => {
			el.removeEventListener('pointermove', onMove);
			el.removeEventListener('pointerup', onUp);
		};
		el.addEventListener('pointermove', onMove);
		el.addEventListener('pointerup', onUp);
	}

	function updateVolFromPointer(peerId: string, el: HTMLElement, e: PointerEvent) {
		const rect = el.getBoundingClientRect();
		const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
		const vol = Math.round((x / rect.width) * 20) / 20; // snap to 0.05
		getPeerManager()?.setVolume(peerId, vol);
	}

	function sendChat() {
		const content = chatInput.trim();
		if (!content || content.length > 2000) return;

		signalingClient.send({
			type: 'chat_message',
			payload: { content }
		});

		chatMessages.update((msgs) => [
			...msgs,
			{
				sender_id: get(userId),
				username: get(username),
				content,
				timestamp: Date.now()
			}
		]);

		chatInput = '';
		requestAnimationFrame(() => {
			if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
		});
	}

	function onChatKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendChat();
		}
	}

	function escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	function bindScreenStream(node: HTMLVideoElement, stream: MediaStream) {
		node.srcObject = stream;
		node.play().catch(() => {});

		return {
			update(newStream: MediaStream) {
				if (node.srcObject !== newStream) {
					node.srcObject = newStream;
					node.play().catch(() => {});
				}
			},
			destroy() {
				node.srcObject = null;
			}
		};
	}

	function gridCols(count: number): number {
		if (count <= 1) return 1;
		if (count <= 4) return 2;
		if (count <= 9) return 3;
		return 4;
	}
</script>

<div class="channel-page">
	<div class="channel-body">
		<!-- Left sidebar: users -->
		<aside class="sidebar">
			<div class="sidebar-section">
				<h3>
					<Users size={12} />
					Users
				</h3>
				<div class="user-list">
					<!-- Self -->
					<div class="user-item self">
						<div class="user-info">
							<span class="user-name">{$username}</span>
							<span class="you-label">you</span>
						</div>
						<div class="user-badges">
							{#if muted}
								<span class="badge muted"><MicOff size={10} /></span>
							{/if}
							{#if sharing}
								<span class="badge sharing"><Monitor size={10} /></span>
							{/if}
						</div>
					</div>

					<!-- Peers -->
					{#each peerArray as peer (peer.id)}
						<div
							class="user-item peer-volume"
							onpointerdown={(e) => startVolumeDrag(peer.id, e)}
							style="--vol: {peer.volume}"
							role="slider"
							aria-label="Volume for {peer.username}"
							aria-valuenow={Math.round(peer.volume * 100)}
							aria-valuemin={0}
							aria-valuemax={100}
							tabindex={0}
						>
							<div class="vol-fill"></div>
							<div class="user-row">
								<div class="user-info">
									<span class="user-name">{peer.username}</span>
								</div>
								<div class="user-right">
									<div class="user-badges">
										{#if peer.is_muted}
											<span class="badge muted"><MicOff size={10} /></span>
										{/if}
										{#if peer.is_sharing_screen}
											<span class="badge sharing"><Monitor size={10} /></span>
										{/if}
									</div>
									<span class="vol-pct">{Math.round(peer.volume * 100)}%</span>
								</div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		</aside>

		<!-- Center: screen share grid / empty state -->
		<main class="center-area">
			{#if fullscreenPeerId}
				<!-- Fullscreen single screen share -->
				{@const fsPeer = screenSharers.find((p) => p.id === fullscreenPeerId)}
				<div class="fullscreen-view">
					{#if fsPeer?.screenStream}
						<video use:bindScreenStream={fsPeer.screenStream} autoplay playsinline></video>
					{:else}
						<p class="waiting-text">Waiting for stream…</p>
					{/if}
					<div class="fullscreen-overlay">
						<span class="fs-label">{fsPeer?.username ?? 'Unknown'}</span>
						<button class="overlay-btn" onclick={() => (fullscreenPeerId = null)}>
							<Minimize2 size={14} />
						</button>
					</div>
				</div>
			{:else if screenSharers.length > 0}
				<!-- Grid of screen shares -->
				<div class="screen-grid" style="--cols: {gridCols(screenSharers.length)}">
					{#each screenSharers as peer (peer.id)}
						<div class="screen-tile">
							{#if peer.screenStream}
								<video use:bindScreenStream={peer.screenStream} autoplay playsinline></video>
							{/if}
							<div class="tile-overlay">
								<span class="tile-label">{peer.username}</span>
								<button class="overlay-btn" onclick={() => (fullscreenPeerId = peer.id)}>
									<Maximize2 size={12} />
								</button>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<!-- No screen shares -->
				<div class="empty-center">
					<Monitor size={36} strokeWidth={1} />
					<p>No active screen shares</p>
					<span>Share your screen or wait for others</span>
				</div>
			{/if}
		</main>

		<!-- Right: chat panel -->
		{#if chatOpen}
			<aside class="chat-panel">
				<div class="chat-header">
					<h3>
						<MessageSquare size={12} />
						Chat
					</h3>
					<button class="icon-btn" onclick={() => (chatOpen = false)}>
						<X size={14} />
					</button>
				</div>

				<div class="chat-messages" bind:this={chatContainer}>
					{#each messages as msg (msg.timestamp + msg.sender_id)}
						<div class="chat-msg" class:own={msg.sender_id === $userId}>
							<span class="msg-author">{escapeHtml(msg.username)}</span>
							<span class="msg-text">{escapeHtml(msg.content)}</span>
						</div>
					{/each}
				</div>

				<div class="chat-input-row">
					<input
						type="text"
						placeholder="Message…"
						bind:value={chatInput}
						onkeydown={onChatKeydown}
						maxlength={2000}
					/>
					<button class="send-btn" onclick={sendChat} disabled={!chatInput.trim()}>
						<Send size={14} />
					</button>
				</div>
			</aside>
		{/if}
	</div>

	<!-- Bottom controls -->
	<footer class="controls">
		{#if error}
			<span class="error">{error}</span>
		{/if}
		<div class="control-buttons">
			<button class="ctrl-btn" class:active={muted} class:danger-active={muted} onclick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
				{#if muted}
					<MicOff size={18} />
				{:else}
					<Mic size={18} />
				{/if}
			</button>
			<button class="ctrl-btn" class:active={sharing} onclick={toggleScreenShare} title={sharing ? 'Stop sharing' : 'Share screen'}>
				{#if sharing}
					<MonitorOff size={18} />
				{:else}
					<Monitor size={18} />
				{/if}
			</button>
			{#if !chatOpen}
				<button class="ctrl-btn" onclick={() => (chatOpen = true)} title="Open chat">
					<MessageSquare size={18} />
				</button>
			{/if}
			<div class="device-picker-wrap">
				<button class="ctrl-btn" class:active={showDevicePicker} onclick={toggleDevicePicker} title="Audio devices">
					<Settings size={18} />
				</button>
				{#if showDevicePicker}
					<div class="device-picker-popup">
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Microphone</label>
							<select class="device-select" value={selectedInputId} onchange={switchInput}>
								{#each audioInputDevices as dev (dev.deviceId)}
									<option value={dev.deviceId}>{dev.label || 'Microphone'}</option>
								{/each}
							</select>
						</div>
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Speaker</label>
							<select class="device-select" value={selectedOutputId} onchange={switchOutput}>
								{#each audioOutputDevices as dev (dev.deviceId)}
									<option value={dev.deviceId}>{dev.label || 'Speaker'}</option>
								{/each}
							</select>
						</div>
					</div>
				{/if}
			</div>
			<div class="control-divider"></div>
			<button class="ctrl-btn danger" onclick={leave} title="Leave channel">
				<LogOut size={18} />
			</button>
		</div>
	</footer>
</div>

<style>
	.channel-page {
		flex: 1;
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.channel-body {
		flex: 1;
		display: flex;
		overflow: hidden;
	}

	/* ── Sidebar ─────────────────────────────────────────── */

	.sidebar {
		width: 220px;
		min-width: 220px;
		background: var(--bg-secondary);
		border-right: 1px solid var(--border);
		padding: 16px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.sidebar-section h3 {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.7rem;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-bottom: 12px;
		letter-spacing: 0.06em;
	}

	.user-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.user-item {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		border-radius: var(--radius-sm);
		transition: background 0.1s;
	}

	.user-item:hover {
		background: var(--bg-tertiary);
	}

	.user-item.self {
		background: var(--bg-tertiary);
	}

	.user-info {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.user-name {
		font-size: 0.8rem;
		font-weight: 500;
		word-break: break-all;
	}

	.you-label {
		font-size: 0.65rem;
		color: var(--text-muted);
	}

	.user-badges {
		display: flex;
		gap: 4px;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px;
		border-radius: var(--radius-xs);
		color: var(--text-muted);
	}

	.badge.muted {
		color: var(--danger);
	}

	.badge.sharing {
		color: var(--success);
	}

	/* ── Drag-to-volume on peer cards ────────────────────── */

	.peer-volume {
		position: relative;
		overflow: hidden;
		cursor: ew-resize;
		touch-action: none;
		user-select: none;
	}

	.vol-fill {
		position: absolute;
		inset: 0;
		right: auto;
		width: calc(var(--vol) * 100%);
		background: color-mix(in srgb, var(--text-primary) 6%, transparent);
		border-radius: inherit;
		transition: width 0.06s linear;
		pointer-events: none;
	}

	.peer-volume:hover .vol-fill,
	.peer-volume:active .vol-fill {
		background: color-mix(in srgb, var(--text-primary) 10%, transparent);
	}

	.user-row {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		pointer-events: none;
	}

	.user-right {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.vol-pct {
		font-size: 0.6rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		min-width: 28px;
		text-align: right;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.peer-volume:hover .vol-pct,
	.peer-volume:active .vol-pct {
		opacity: 1;
	}

	/* ── Center area ─────────────────────────────────────── */

	.center-area {
		flex: 1;
		display: flex;
		overflow: hidden;
		background: var(--bg-primary);
	}

	.empty-center {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		color: var(--text-muted);
	}

	.empty-center p {
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.empty-center span {
		font-size: 0.8rem;
	}

	/* ── Screen share grid ───────────────────────────────── */

	.screen-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(var(--cols), 1fr);
		gap: 2px;
		padding: 2px;
		background: var(--border-subtle);
	}

	.screen-tile {
		position: relative;
		background: #000;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 0;
	}

	.screen-tile video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.tile-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
		opacity: 0;
		transition: opacity 0.15s;
	}

	.screen-tile:hover .tile-overlay {
		opacity: 1;
	}

	.tile-label {
		font-size: 0.75rem;
		color: #fff;
		font-weight: 500;
	}

	.overlay-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.15);
		color: #fff;
		border: none;
		cursor: pointer;
		padding: 0;
		transition: background 0.1s;
	}

	.overlay-btn:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	/* ── Fullscreen view ─────────────────────────────────── */

	.fullscreen-view {
		flex: 1;
		position: relative;
		background: #000;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.fullscreen-view video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.fullscreen-overlay {
		position: absolute;
		top: 12px;
		right: 12px;
		display: flex;
		align-items: center;
		gap: 8px;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.fullscreen-view:hover .fullscreen-overlay {
		opacity: 1;
	}

	.fs-label {
		font-size: 0.8rem;
		color: #fff;
		font-weight: 500;
		background: rgba(0, 0, 0, 0.5);
		padding: 4px 10px;
		border-radius: 6px;
	}

	.waiting-text {
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	/* ── Chat panel ──────────────────────────────────────── */

	.chat-panel {
		width: 300px;
		min-width: 300px;
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
		border-left: 1px solid var(--border);
	}

	.chat-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
	}

	.chat-header h3 {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.7rem;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--text-muted);
		letter-spacing: 0.06em;
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		padding: 0;
		transition: all 0.1s;
	}

	.icon-btn:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	.chat-messages {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.chat-msg {
		display: flex;
		gap: 8px;
		line-height: 1.5;
	}

	.chat-msg.own .msg-author {
		color: var(--text-primary);
	}

	.msg-author {
		font-weight: 600;
		font-size: 0.8rem;
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.msg-text {
		font-size: 0.8rem;
		word-break: break-word;
		color: var(--text-secondary);
	}

	.chat-input-row {
		display: flex;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--border);
	}

	.chat-input-row input {
		flex: 1;
		font-size: 0.8rem;
		padding: 8px 12px;
		background: var(--bg-tertiary);
	}

	.send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		background: var(--text-primary);
		color: var(--bg-primary);
		padding: 0;
		flex-shrink: 0;
	}

	.send-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.send-btn:disabled {
		opacity: 0.2;
	}

	/* ── Controls bar ────────────────────────────────────── */

	.controls {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 12px 24px;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
	}

	.control-buttons {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ctrl-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 42px;
		height: 42px;
		border-radius: 50%;
		background: var(--bg-tertiary);
		color: var(--text-primary);
		padding: 0;
		transition: all 0.15s ease;
		border: 1px solid transparent;
	}

	.ctrl-btn:hover {
		background: var(--bg-hover);
		border-color: var(--border);
	}

	.ctrl-btn.active {
		border-color: var(--text-muted);
	}

	.ctrl-btn.danger-active {
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 30%, transparent);
	}

	.ctrl-btn.danger {
		background: var(--danger);
		color: white;
		border: none;
	}

	.ctrl-btn.danger:hover {
		background: var(--danger-hover);
	}

	.control-divider {
		width: 1px;
		height: 24px;
		background: var(--border);
		margin: 0 6px;
	}

	/* ── Device picker ───────────────────────────────────── */

	.device-picker-wrap {
		position: relative;
	}

	.device-picker-popup {
		position: absolute;
		bottom: 54px;
		left: 50%;
		transform: translateX(-50%);
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 260px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
		z-index: 10;
	}

	.device-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.device-label {
		font-size: 0.7rem;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--text-muted);
		letter-spacing: 0.06em;
	}

	.device-select {
		width: 100%;
		padding: 6px 10px;
		font-size: 0.8rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-tertiary);
		color: var(--text-primary);
		outline: none;
	}

	.device-select:focus {
		border-color: var(--text-muted);
	}

	.error {
		color: var(--danger);
		font-size: 0.75rem;
	}
</style>
