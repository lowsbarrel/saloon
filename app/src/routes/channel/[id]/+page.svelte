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
		resetState,
		e2eeKeyPair,
		peerPublicKeys
	} from '$lib/stores';
	import { persistSession } from '$lib/persistence';
	import { setupChannel, subscribeChannelStores } from '$lib/channel-setup';
	import { enumerateDevices } from '$lib/webrtc/media-devices';
	import { ErrorMsg, errorMessage } from '$lib/errors';
	import { encrypt } from '$lib/crypto';
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
		Copy,
		Check,
		Maximize2,
		Minimize2,
		X,
		MessageSquare,
		Users,
		Settings,
		ChevronDown
	} from 'lucide-svelte';

	const channelId = page.params.id ?? '';
	const CHANNEL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
	let chatOpen = $state(false);
	let sidebarOpen = $state(false);
	let intentionalLeave = false;
	let inviteCopied = $state(false);
	let inviteCopiedTimeout: ReturnType<typeof setTimeout> | null = null;

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
	let peerCount = $derived(peerArray.length);
	let unreadCount = $state(0);

	onMount(async () => {
		if (!get(isConnected) || !get(userId) || !CHANNEL_SLUG_RE.test(channelId)) {
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
					if (!chatOpen) unreadCount++;
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
		if (inviteCopiedTimeout) clearTimeout(inviteCopiedTimeout);
		navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
		for (const unsub of unsubs) unsub();
		unsubs.length = 0;
		destroyPeerManager();
		signalingClient.disconnect();
	});

	async function copyPrivateChannelJoinName(): Promise<void> {
		try {
			await navigator.clipboard.writeText(channelId);
			inviteCopied = true;
			if (inviteCopiedTimeout) clearTimeout(inviteCopiedTimeout);
			inviteCopiedTimeout = setTimeout(() => {
				inviteCopied = false;
			}, 2000);
		} catch {
			error = 'Failed to copy private channel name';
		}
	}

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

	function openChat() {
		chatOpen = true;
		unreadCount = 0;
	}

	function sendChat(): void {
		const content = chatInput.trim();
		if (!content || content.length > 2000) return;

		const kp = get(e2eeKeyPair);
		const peerKeys = get(peerPublicKeys);
		if (!kp) return;

		const myUsername = get(username);

		for (const [peerId, peerPk] of peerKeys) {
			const ciphertext = encrypt(content, peerPk, kp.secretKey);
			signalingClient.send({
				type: 'encrypted_chat',
				target_id: peerId,
				payload: { ciphertext, username: myUsername },
			});
		}

		chatMessages.update((msgs) => {
			const next = [
				...msgs,
				{ sender_id: get(userId), username: myUsername, content, timestamp: Date.now() }
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
	{#if $currentChannel?.is_private}
		<div class="private-channel-banner">
			<div class="private-channel-copy">
				<span class="private-channel-label">Private channel</span>
				<span class="private-channel-id">{channelId}</span>
			</div>
			<button class="btn-ghost private-channel-btn" onclick={copyPrivateChannelJoinName}>
				{#if inviteCopied}
					<Check size={14} />
					Copied
				{:else}
					<Copy size={14} />
					Copy
				{/if}
			</button>
		</div>
	{/if}

	<div class="channel-body">
		<!-- Sidebar -->
		{#if sidebarOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="panel-backdrop" onclick={() => (sidebarOpen = false)}></div>
		{/if}
		<aside class="sidebar" class:open={sidebarOpen}>
			<div class="panel-header sidebar-header">
				<h3><Users size={13} /> Users · {peerCount + 1}</h3>
				<button class="panel-close" onclick={() => (sidebarOpen = false)}><X size={16} /></button>
			</div>
			<div class="user-list">
				<div class="user-item self">
					<div class="user-info">
						<span class="user-name">{$username}</span>
						<span class="you-label">you</span>
					</div>
					<div class="user-badges">
						{#if muted}<span class="badge muted"><MicOff size={10} /></span>{/if}
						{#if sharing}<span class="badge sharing"><Monitor size={10} /></span>{/if}
						{#if cameraOn}<span class="badge sharing"><Video size={10} /></span>{/if}
					</div>
				</div>
				{#each peerArray as peer (peer.id)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="user-item" oncontextmenu={(e) => openVolumeMenu(peer.id, 'mic', e)}>
						<div class="user-info">
							<span class="user-name">{peer.username}</span>
						</div>
						<div class="user-badges">
							{#if peer.is_muted}<span class="badge muted"><MicOff size={10} /></span>{/if}
							{#if peer.is_sharing_screen}<span class="badge sharing"><Monitor size={10} /></span>{/if}
							{#if peer.is_camera_on}<span class="badge sharing"><Video size={10} /></span>{/if}
						</div>
					</div>
				{/each}
			</div>
		</aside>

		<!-- Center -->
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
						<button class="overlay-btn" onclick={() => (fullscreenPeerId = null)}><Minimize2 size={14} /></button>
					</div>
				</div>
			{:else if hasVideoFeeds}
				{@const totalFeeds = screenSharers.length + cameraUsers.length + (cameraOn ? 1 : 0)}
				<div class="screen-grid" style="--cols: {gridCols(totalFeeds)}">
					{#each screenSharers as peer (peer.id)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="screen-tile" oncontextmenu={(e) => openVolumeMenu(peer.id, 'screen', e)}>
							{#if peer.screenStream}
								<video use:bindScreenStream={peer.screenStream} autoplay playsinline></video>
							{/if}
							<div class="tile-overlay">
								<span class="tile-label">{peer.username} <Monitor size={10} /></span>
								<button class="overlay-btn" onclick={() => { fullscreenPeerId = peer.id; fullscreenType = 'screen'; }}><Maximize2 size={12} /></button>
							</div>
						</div>
					{/each}
					{#if cameraOn && localCameraStream}
						<div class="screen-tile">
							<video use:bindScreenStream={localCameraStream} autoplay playsinline muted></video>
							<div class="tile-overlay"><span class="tile-label">{$username} (you)</span></div>
						</div>
					{/if}
					{#each cameraUsers as peer (peer.id + '-cam')}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="screen-tile" oncontextmenu={(e) => openVolumeMenu(peer.id, 'mic', e)}>
							{#if peer.videoStream}
								<video use:bindScreenStream={peer.videoStream} autoplay playsinline></video>
							{/if}
							<div class="tile-overlay">
								<span class="tile-label">{peer.username}</span>
								<button class="overlay-btn" onclick={() => { fullscreenPeerId = peer.id; fullscreenType = 'camera'; }}><Maximize2 size={12} /></button>
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

		<!-- Chat panel -->
		{#if chatOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="panel-backdrop chat-backdrop-el" onclick={() => (chatOpen = false)}></div>
			<aside class="chat-panel">
				<div class="panel-header chat-header">
					<h3><MessageSquare size={13} /> Chat</h3>
					<button class="panel-close" onclick={() => (chatOpen = false)}><X size={16} /></button>
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
					<input type="text" placeholder="Message…" bind:value={chatInput} onkeydown={onChatKeydown} maxlength={2000} />
					<button class="send-btn" onclick={sendChat} disabled={!chatInput.trim()}><Send size={14} /></button>
				</div>
			</aside>
		{/if}
	</div>

	<!-- Bottom controls -->
	<footer class="controls">
		{#if error}<span class="ctrl-error">{error}</span>{/if}
		<div class="control-buttons">
			<button class="ctrl-btn" class:active={sidebarOpen} onclick={() => (sidebarOpen = !sidebarOpen)} title="Users">
				<Users size={18} />
				{#if peerCount > 0}<span class="ctrl-badge">{peerCount}</span>{/if}
			</button>
			<button class="ctrl-btn" class:active={muted} class:danger-active={muted} onclick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
				{#if muted}<MicOff size={18} />{:else}<Mic size={18} />{/if}
			</button>
			<button class="ctrl-btn" class:active={sharing} onclick={toggleScreenShare} title={sharing ? 'Stop sharing' : 'Share screen'}>
				{#if sharing}<MonitorOff size={18} />{:else}<Monitor size={18} />{/if}
			</button>
			<button class="ctrl-btn" class:active={cameraOn} onclick={toggleCamera} title={cameraOn ? 'Turn off camera' : 'Turn on camera'}>
				{#if cameraOn}<Video size={18} />{:else}<VideoOff size={18} />{/if}
			</button>
			<button class="ctrl-btn" class:active={chatOpen} onclick={openChat} title="Chat">
				<MessageSquare size={18} />
				{#if unreadCount > 0}<span class="ctrl-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>{/if}
			</button>
			<div class="device-picker-wrap">
				<button class="ctrl-btn" class:active={showDevicePicker} onclick={toggleDevicePicker} title="Devices"><Settings size={18} /></button>
				{#if showDevicePicker}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div class="device-backdrop" onclick={() => (showDevicePicker = false)}></div>
					<div class="device-picker-popup">
						<div class="device-picker-handle"><span></span></div>
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Microphone</label>
							<select class="device-select" value={selectedInputId} onchange={(e) => switchAudioDevice('input', e)}>
								{#each audioInputDevices as dev (dev.deviceId)}<option value={dev.deviceId}>{dev.label || 'Microphone'}</option>{/each}
							</select>
						</div>
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Speaker</label>
							<select class="device-select" value={selectedOutputId} onchange={(e) => switchAudioDevice('output', e)}>
								{#each audioOutputDevices as dev (dev.deviceId)}<option value={dev.deviceId}>{dev.label || 'Speaker'}</option>{/each}
							</select>
						</div>
						<div class="device-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="device-label">Camera</label>
							<select class="device-select" value={selectedVideoId} onchange={switchVideoDevice}>
								{#each videoInputDevices as dev (dev.deviceId)}<option value={dev.deviceId}>{dev.label || 'Camera'}</option>{/each}
							</select>
						</div>
					</div>
				{/if}
			</div>
			<div class="control-divider"></div>
			<button class="ctrl-btn danger" onclick={leave} title="Leave channel"><LogOut size={18} /></button>
		</div>
	</footer>
</div>

<!-- Volume context menu -->
{#if ctxMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="ctx-backdrop" onclick={closeVolumeMenu} oncontextmenu={(e) => { e.preventDefault(); closeVolumeMenu(); }}></div>
	<div class="ctx-menu" style="left: {ctxMenu.x}px; top: {ctxMenu.y}px">
		<span class="ctx-label">{getCtxUsername()} — {ctxMenu.kind === 'mic' ? 'Mic' : 'Screen'}</span>
		<div class="ctx-slider-row">
			<input type="range" min="0" max="100" value={getCtxVolume()} oninput={onCtxSliderInput} class="ctx-slider" />
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

	/* ── Private banner ──────────────────────────────────── */

	.private-channel-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 20px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-secondary);
	}

	.private-channel-copy {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.private-channel-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.private-channel-id {
		font-family: var(--font-mono, 'SFMono-Regular', Consolas, monospace);
		font-size: 0.8rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.private-channel-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		padding: 6px 12px;
		font-size: 0.75rem;
	}

	/* ── Body ────────────────────────────────────────────── */

	.channel-body {
		flex: 1;
		display: flex;
		overflow: hidden;
		position: relative;
	}

	/* ── Shared panel chrome ─────────────────────────────── */

	.panel-backdrop {
		display: none;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.panel-header h3 {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.7rem;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--text-muted);
		letter-spacing: 0.06em;
	}

	.panel-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		padding: 0;
		border: none;
		cursor: pointer;
		transition: all 0.1s;
	}

	.panel-close:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	/* ── Sidebar ─────────────────────────────────────────── */

	.sidebar {
		width: 220px;
		min-width: 220px;
		background: var(--bg-secondary);
		border-right: 1px solid var(--border);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.sidebar-header {
		display: none;
	}

	.user-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 16px;
	}

	.user-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
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
		min-width: 0;
	}

	.user-name {
		font-size: 0.8rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.you-label {
		font-size: 0.6rem;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.user-badges {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px;
		border-radius: var(--radius-xs);
		color: var(--text-muted);
	}

	.badge.muted { color: var(--danger); }
	.badge.sharing { color: var(--success); }

	/* ── Center area ─────────────────────────────────────── */

	.center-area {
		flex: 1;
		display: flex;
		overflow: hidden;
		background: var(--bg-primary);
		min-width: 0;
	}

	.empty-center {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		color: var(--text-muted);
		padding: 20px;
		text-align: center;
	}

	.empty-center p { font-size: 0.9rem; color: var(--text-secondary); }
	.empty-center span { font-size: 0.8rem; }

	/* ── Video grid ──────────────────────────────────────── */

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

	.screen-tile:hover .tile-overlay { opacity: 1; }

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

	.overlay-btn:hover { background: rgba(255, 255, 255, 0.3); }

	/* ── Fullscreen view ─────────────────────────────────── */

	.fullscreen-view {
		flex: 1;
		position: relative;
		background: #000;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.fullscreen-view video { width: 100%; height: 100%; object-fit: contain; }

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

	.fullscreen-view:hover .fullscreen-overlay { opacity: 1; }

	.fs-label {
		font-size: 0.8rem;
		color: #fff;
		font-weight: 500;
		background: rgba(0, 0, 0, 0.5);
		padding: 4px 10px;
		border-radius: 6px;
	}

	.waiting-text { color: var(--text-muted); font-size: 0.85rem; }

	/* ── Chat panel ──────────────────────────────────────── */

	.chat-panel {
		width: 300px;
		min-width: 300px;
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
		border-left: 1px solid var(--border);
	}

	.chat-messages {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.chat-msg { display: flex; gap: 8px; line-height: 1.5; }
	.chat-msg.own .msg-author { color: var(--text-primary); }

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

	.send-btn:hover:not(:disabled) { opacity: 0.85; }
	.send-btn:disabled { opacity: 0.2; }

	/* ── Controls bar ────────────────────────────────────── */

	.controls {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		gap: 6px;
		padding: 10px 16px;
		padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
		z-index: 10;
	}

	.ctrl-error { color: var(--danger); font-size: 0.75rem; }

	.control-buttons {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ctrl-btn {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: var(--bg-tertiary);
		color: var(--text-primary);
		padding: 0;
		transition: all 0.15s ease;
		border: 1px solid transparent;
		flex-shrink: 0;
	}

	.ctrl-btn:hover { background: var(--bg-hover); border-color: var(--border); }
	.ctrl-btn.active { border-color: var(--text-muted); }

	.ctrl-btn.danger-active {
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 30%, transparent);
	}

	.ctrl-btn.danger { background: var(--danger); color: white; border: none; }
	.ctrl-btn.danger:hover { background: var(--danger-hover); }

	.ctrl-badge {
		position: absolute;
		top: -2px;
		right: -2px;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 8px;
		background: var(--text-primary);
		color: var(--bg-primary);
		font-size: 0.6rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}

	.control-divider {
		width: 1px;
		height: 24px;
		background: var(--border);
		margin: 0 4px;
	}

	/* ── Device picker ───────────────────────────────────── */

	.device-picker-wrap { position: relative; }
	.device-backdrop { display: none; }

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
		z-index: 30;
	}

	.device-picker-handle { display: none; }

	.device-group { display: flex; flex-direction: column; gap: 4px; }

	.device-label {
		font-size: 0.7rem;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--text-muted);
		letter-spacing: 0.06em;
	}

	.device-select {
		width: 100%;
		padding: 8px 10px;
		font-size: 0.8rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-tertiary);
		color: var(--text-primary);
		outline: none;
	}

	.device-select:focus { border-color: var(--text-muted); }

	/* ── Volume context menu ─────────────────────────────── */

	.ctx-backdrop { position: fixed; inset: 0; z-index: 100; }

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

	.ctx-slider-row { display: flex; align-items: center; gap: 8px; }

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

	/* ════════════════════════════════════════════════════════
	 * MOBILE ≤ 768px
	 * ════════════════════════════════════════════════════════ */

	@media (max-width: 768px) {
		.panel-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 40;
			background: rgba(0, 0, 0, 0.5);
			animation: fadeIn 0.15s ease;
		}

		.panel-header h3 {
			font-size: 0.85rem;
			font-weight: 600;
			color: var(--text-primary);
			text-transform: none;
			letter-spacing: 0;
		}

		.panel-close {
			width: 32px;
			height: 32px;
		}

		/* Sidebar → slide-over from left */
		.sidebar {
			position: fixed;
			top: 0;
			left: 0;
			bottom: 0;
			z-index: 41;
			width: 280px;
			min-width: 0;
			transform: translateX(-100%);
			transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
			box-shadow: var(--shadow-lg);
		}

		.sidebar.open { transform: translateX(0); }
		.sidebar-header { display: flex; }

		.user-list { padding: 8px 12px; }
		.user-item { padding: 12px; }
		.user-name { font-size: 0.85rem; }

		/* Chat → slide-over from right, full width */
		.chat-panel {
			position: fixed;
			top: 0;
			right: 0;
			bottom: 0;
			z-index: 41;
			width: 100%;
			max-width: 360px;
			min-width: 0;
			border-left: none;
			box-shadow: var(--shadow-lg);
			animation: slideRight 0.25s cubic-bezier(0.4, 0, 0.2, 1);
		}

		.chat-input-row {
			padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
		}

		/* Video */
		.center-area { width: 100%; }
		.screen-grid { grid-template-columns: 1fr !important; }
		.tile-overlay { opacity: 1; }
		.fullscreen-overlay { opacity: 1; }

		/* Controls */
		.controls {
			padding: 8px 12px;
			padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
		}

		.ctrl-btn { width: 42px; height: 42px; }
		.control-divider { margin: 0 2px; }

		/* Private banner */
		.private-channel-banner { padding: 8px 16px; }

		/* Device picker → bottom sheet */
		.device-backdrop {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 29;
			background: rgba(0, 0, 0, 0.4);
			animation: fadeIn 0.15s ease;
		}

		.device-picker-popup {
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			top: auto;
			transform: none;
			border-radius: 16px 16px 0 0;
			min-width: 0;
			padding: 4px 20px 20px;
			padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
			z-index: 30;
			animation: slideUp 0.25s cubic-bezier(0.4, 0, 0.2, 1);
		}

		.device-picker-handle {
			display: flex;
			justify-content: center;
			padding: 8px 0 12px;
		}

		.device-picker-handle span {
			width: 36px;
			height: 4px;
			border-radius: 2px;
			background: var(--border);
		}

		.device-select { padding: 12px; font-size: 0.85rem; }

		/* Context menu → bottom-anchored */
		.ctx-menu {
			left: 16px !important;
			right: 16px;
			top: auto !important;
			bottom: 80px;
			width: auto;
		}
	}

	/* ════════════════════════════════════════════════════════
	 * SMALL MOBILE ≤ 400px
	 * ════════════════════════════════════════════════════════ */

	@media (max-width: 400px) {
		.ctrl-btn { width: 38px; height: 38px; }
		.control-buttons { gap: 4px; }
		.control-divider { margin: 0 1px; height: 20px; }
		.sidebar { width: 240px; }
	}

	/* ── Animations ──────────────────────────────────────── */

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@keyframes slideRight {
		from { transform: translateX(100%); }
		to { transform: translateX(0); }
	}

	@keyframes slideUp {
		from { transform: translateY(100%); }
		to { transform: translateY(0); }
	}
</style>
