<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { leaveChannel } from '$lib/api';
	import {
		userId,
		username,
		currentChannel,
		isConnected,
		signalingClient,
		destroyPeerManager,
		getPeerManager,
		isMuted,
		isSharingScreen,
		isCameraOn,
		chatMessages,
		resetState
	} from '$lib/stores';
	import { persistSession } from '$lib/persistence';
	import { setupChannel, subscribeChannelStores } from '$lib/channel-setup';
	import { enumerateDevices } from '$lib/webrtc/media-devices';
	import { ErrorMsg, errorMessage } from '$lib/errors';
	import type { ChatMessage, PeerState, WSMessage } from '$lib/types';
	import {
		Mic,
		MicOff,
		Monitor,
		MonitorOff,
		Video,
		VideoOff,
		LogOut,
		Send,
		Maximize2,
		Minimize2,
		X,
		MessageSquare,
		Users,
		Settings
	} from 'lucide-svelte';

	const channelId = page.params.id ?? '';
	let chatInput = $state('');
	let chatContainer: HTMLDivElement = $state(undefined!);
	let messages: ChatMessage[] = $state([]);
	let peerArray: PeerState[] = $state([]);
	let muted = $state(false);
	let sharing = $state(false);
	let cameraOn = $state(false);
	let localCameraStream: MediaStream | null = $state(null);
	let error = $state('');

	let fullscreenPeerId: string | null = $state(null);
	let fullscreenType: 'screen' | 'camera' = $state('screen');
	let chatOpen = $state(true);
	let intentionalLeave = false;

	// Device selection
	let showDevicePicker = $state(false);
	let audioInputDevices: MediaDeviceInfo[] = $state([]);
	let audioOutputDevices: MediaDeviceInfo[] = $state([]);
	let videoInputDevices: MediaDeviceInfo[] = $state([]);
	let selectedInputId = $state('');
	let selectedOutputId = $state('');
	let selectedVideoId = $state('');

	const unsubs: (() => void)[] = [];

	// Derived
	let screenSharers = $derived(peerArray.filter((p) => p.is_sharing_screen && p.screenStream));
	let cameraUsers = $derived(peerArray.filter((p) => p.is_camera_on && p.videoStream));
	let hasVideoFeeds = $derived(screenSharers.length > 0 || cameraUsers.length > 0 || cameraOn);

	onMount(async () => {
		if (!get(isConnected) || !get(userId)) {
			goto('/');
			return;
		}

		const uid = get(userId);

		try {
			const { pm, unsubs: signalUnsubs } = await setupChannel(channelId, uid, {
				onPeerLeft(peerId) {
					if (fullscreenPeerId === peerId) fullscreenPeerId = null;
				},
				onChatMessage() {
					requestAnimationFrame(() => {
						if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
					});
				},
				onConnectionClosed() {
					if (!intentionalLeave) {
						resetState();
						goto('/');
					}
				},
			});

			unsubs.push(...signalUnsubs);
			unsubs.push(
				...subscribeChannelStores({
					setPeerArray: (v) => (peerArray = v),
					setMessages: (v) => (messages = v),
					setMuted: (v) => (muted = v),
					setSharing: (v) => (sharing = v),
					setCameraOn: (v) => (cameraOn = v),
				}),
			);

			persistSession(channelId);
			navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
		} catch (e: unknown) {
			error = errorMessage(e, ErrorMsg.CHANNEL_JOIN_INIT);
		}
	});

	onDestroy(() => {
		intentionalLeave = true;
		navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
		for (const unsub of unsubs) unsub();
		unsubs.length = 0;
		destroyPeerManager();
		signalingClient.disconnect();
	});

	function leave() {
		intentionalLeave = true;
		for (const unsub of unsubs) unsub();
		unsubs.length = 0;
		signalingClient.send({ type: 'leave' });
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
		if (showDevicePicker) await refreshDeviceList();
	}

	async function refreshDeviceList(): Promise<void> {
		const devices = await enumerateDevices();
		audioInputDevices = devices.audioInput;
		audioOutputDevices = devices.audioOutput;
		videoInputDevices = devices.videoInput;
	}

	function onDeviceChange(): void {
		refreshDeviceList().catch(() => {});
	}

	async function switchAudioDevice(kind: 'input' | 'output', e: Event): Promise<void> {
		const deviceId = (e.target as HTMLSelectElement).value;
		try {
			if (kind === 'input') {
				selectedInputId = deviceId;
				await getPeerManager()?.switchAudioInput(deviceId);
			} else {
				selectedOutputId = deviceId;
				await getPeerManager()?.switchAudioOutput(deviceId);
			}
		} catch {
			error = kind === 'input' ? ErrorMsg.MIC_SWITCH : ErrorMsg.SPEAKER_SWITCH;
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

	async function toggleCamera() {
		const pm = getPeerManager();
		if (!pm) return;

		if (cameraOn) {
			pm.stopCamera();
			localCameraStream = null;
			isCameraOn.set(false);
		} else {
			try {
				const stream = await pm.startCamera(selectedVideoId || undefined);
				localCameraStream = stream;
				isCameraOn.set(true);
			} catch {
				error = ErrorMsg.CAMERA_START;
			}
		}
	}

	async function switchVideoDevice(e: Event): Promise<void> {
		const deviceId = (e.target as HTMLSelectElement).value;
		selectedVideoId = deviceId;
		try {
			if (cameraOn) {
				await getPeerManager()?.switchVideoInput(deviceId);
				localCameraStream = getPeerManager()?.getLocalCameraStream() ?? null;
			}
		} catch {
			error = ErrorMsg.CAMERA_SWITCH;
		}
	}

	// ── Context menu volume slider ──────────────────────────
	let ctxMenu: { x: number; y: number; peerId: string; kind: 'mic' | 'screen' } | null = $state(null);

	function openVolumeMenu(peerId: string, kind: 'mic' | 'screen', e: MouseEvent) {
		e.preventDefault();
		ctxMenu = { x: e.clientX, y: e.clientY, peerId, kind };
	}

	function closeVolumeMenu() {
		ctxMenu = null;
	}

	function onCtxSliderInput(e: Event) {
		if (!ctxMenu) return;
		const val = parseFloat((e.target as HTMLInputElement).value) / 100;
		if (ctxMenu.kind === 'mic') {
			getPeerManager()?.setVolume(ctxMenu.peerId, val);
		} else {
			getPeerManager()?.setScreenVolume(ctxMenu.peerId, val);
		}
	}

	function getCtxVolume(): number {
		if (!ctxMenu) return 100;
		const peer = peerArray.find((p) => p.id === ctxMenu!.peerId);
		if (!peer) return 100;
		return Math.round((ctxMenu.kind === 'mic' ? peer.volume : peer.screenVolume) * 100);
	}

	function getCtxUsername(): string {
		if (!ctxMenu) return '';
		const peer = peerArray.find((p) => p.id === ctxMenu!.peerId);
		return peer?.username ?? '';
	}

	function sendChat(): void {
		const content = chatInput.trim();
		if (!content || content.length > 2000) return;

		signalingClient.send({ type: 'chat_message', payload: { content } });

		chatMessages.update((msgs) => {
			const next = [
				...msgs,
				{ sender_id: get(userId), username: get(username), content, timestamp: Date.now() }
			];
			return next.length > 500 ? next.slice(-500) : next;
		});

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
							{#if cameraOn}
								<span class="badge sharing"><Video size={10} /></span>
							{/if}
						</div>
					</div>

					<!-- Peers -->
					{#each peerArray as peer (peer.id)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="user-item"
							oncontextmenu={(e) => openVolumeMenu(peer.id, 'mic', e)}
						>
							<div class="user-info">
								<span class="user-name">{peer.username}</span>
							</div>
							<div class="user-badges">
								{#if peer.is_muted}
									<span class="badge muted"><MicOff size={10} /></span>
								{/if}
								{#if peer.is_sharing_screen}
									<span class="badge sharing"><Monitor size={10} /></span>
								{/if}
								{#if peer.is_camera_on}
									<span class="badge sharing"><Video size={10} /></span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		</aside>

		<!-- Center: video grid / empty state -->
		<main class="center-area">
			{#if fullscreenPeerId}
				{@const fsPeer = peerArray.find((p) => p.id === fullscreenPeerId)}
				{@const fsStream = fullscreenType === 'camera' ? fsPeer?.videoStream : fsPeer?.screenStream}
				<div class="fullscreen-view">
					{#if fsStream}
						<video use:bindScreenStream={fsStream} autoplay playsinline></video>
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
			{:else if hasVideoFeeds}
				{@const totalFeeds = screenSharers.length + cameraUsers.length + (cameraOn ? 1 : 0)}
				<div class="screen-grid" style="--cols: {gridCols(totalFeeds)}">
					<!-- Screen shares -->
					{#each screenSharers as peer (peer.id)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="screen-tile" oncontextmenu={(e) => openVolumeMenu(peer.id, 'screen', e)}>
							{#if peer.screenStream}
								<video use:bindScreenStream={peer.screenStream} autoplay playsinline></video>
							{/if}
							<div class="tile-overlay">
								<span class="tile-label">{peer.username} <Monitor size={10} /></span>
								<button class="overlay-btn" onclick={() => { fullscreenPeerId = peer.id; fullscreenType = 'screen'; }}>
									<Maximize2 size={12} />
								</button>
							</div>
						</div>
					{/each}
					<!-- Local camera -->
					{#if cameraOn && localCameraStream}
						<div class="screen-tile">
							<video use:bindScreenStream={localCameraStream} autoplay playsinline muted></video>
							<div class="tile-overlay">
								<span class="tile-label">{$username} (you)</span>
							</div>
						</div>
					{/if}
					<!-- Peer cameras -->
					{#each cameraUsers as peer (peer.id + '-cam')}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="screen-tile" oncontextmenu={(e) => openVolumeMenu(peer.id, 'mic', e)}>
							{#if peer.videoStream}
								<video use:bindScreenStream={peer.videoStream} autoplay playsinline></video>
							{/if}
							<div class="tile-overlay">
								<span class="tile-label">{peer.username}</span>
								<button class="overlay-btn" onclick={() => { fullscreenPeerId = peer.id; fullscreenType = 'camera'; }}>
									<Maximize2 size={12} />
								</button>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="empty-center">
					<Video size={36} strokeWidth={1} />
					<p>No active video feeds</p>
					<span>Turn on your camera, share your screen, or wait for others</span>
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
			<button class="ctrl-btn" class:active={cameraOn} onclick={toggleCamera} title={cameraOn ? 'Turn off camera' : 'Turn on camera'}>
				{#if cameraOn}
					<Video size={18} />
				{:else}
					<VideoOff size={18} />
				{/if}
			</button>
			{#if !chatOpen}
				<button class="ctrl-btn" onclick={() => (chatOpen = true)} title="Open chat">
					<MessageSquare size={18} />
				</button>
			{/if}
			<div class="device-picker-wrap">
				<button class="ctrl-btn" class:active={showDevicePicker} onclick={toggleDevicePicker} title="Devices">
					<Settings size={18} />
				</button>
				{#if showDevicePicker}
					<div class="device-picker-popup">
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Microphone</label>
							<select class="device-select" value={selectedInputId} onchange={(e) => switchAudioDevice('input', e)}>
								{#each audioInputDevices as dev (dev.deviceId)}
									<option value={dev.deviceId}>{dev.label || 'Microphone'}</option>
								{/each}
							</select>
						</div>
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Speaker</label>
							<select class="device-select" value={selectedOutputId} onchange={(e) => switchAudioDevice('output', e)}>
								{#each audioOutputDevices as dev (dev.deviceId)}
									<option value={dev.deviceId}>{dev.label || 'Speaker'}</option>
								{/each}
							</select>
						</div>
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Camera</label>
							<select class="device-select" value={selectedVideoId} onchange={switchVideoDevice}>
								{#each videoInputDevices as dev (dev.deviceId)}
									<option value={dev.deviceId}>{dev.label || 'Camera'}</option>
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

<!-- Volume context menu (rendered outside channel-page to avoid overflow clipping) -->
{#if ctxMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="ctx-backdrop" onclick={closeVolumeMenu} oncontextmenu={(e) => { e.preventDefault(); closeVolumeMenu(); }}></div>
	<div class="ctx-menu" style="left: {ctxMenu.x}px; top: {ctxMenu.y}px">
		<span class="ctx-label">{getCtxUsername()} — {ctxMenu.kind === 'mic' ? 'Mic' : 'Screen'}</span>
		<div class="ctx-slider-row">
			<input
				type="range"
				min="0"
				max="100"
				value={getCtxVolume()}
				oninput={onCtxSliderInput}
				class="ctx-slider"
			/>
			<span class="ctx-value">{getCtxVolume()}%</span>
		</div>
	</div>
{/if}

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

	/* ── Volume context menu ─────────────────────────────── */

	.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
	}

	.ctx-menu {
		position: fixed;
		z-index: 101;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 10px 14px;
		min-width: 200px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.ctx-label {
		font-size: 0.7rem;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--text-muted);
		letter-spacing: 0.06em;
	}

	.ctx-slider-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.ctx-slider {
		flex: 1;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: var(--bg-tertiary);
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}

	.ctx-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--text-primary);
		cursor: pointer;
	}

	.ctx-slider::-moz-range-thumb {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--text-primary);
		border: none;
		cursor: pointer;
	}

	.ctx-value {
		font-size: 0.7rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		min-width: 32px;
		text-align: right;
	}
</style>
