/**
 * WebRTC peer connection manager.
 *
 * Handles creation of peer connections, audio tracks, screen sharing,
 * and local volume control via Web Audio API gain nodes.
 */

import type { PeerState, IceServerConfig } from '$lib/types';
import type { SignalingClient } from '$lib/signaling';

const DEFAULT_RTC_CONFIG: RTCConfiguration = {
	iceServers: []
};

export class PeerManager {
	private peers = new Map<string, PeerState>();
	private peerUsernames = new Map<string, string>();
	private politeSet = new Set<string>(); // peer IDs where we are the "polite" (answerer) side
	private localStream: MediaStream | null = null;
	private localScreenStream: MediaStream | null = null;
	private localCameraStream: MediaStream | null = null;
	private audioElements = new Map<string, HTMLAudioElement>();
	/** Separate audio elements for screen share audio per peer. */
	private screenAudioElements = new Map<string, HTMLAudioElement>();
	/** All incoming audio streams per peer, keyed by stream ID. */
	private peerAudioStreams = new Map<string, Map<string, MediaStream>>();
	/** All incoming video streams per peer, keyed by stream ID. */
	private peerVideoStreams = new Map<string, Map<string, MediaStream>>();
	private signaling: SignalingClient;
	private userId: string;
	private onPeersChanged: (peers: Map<string, PeerState>) => void;
	private rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG;
	private _outputDeviceId: string = '';

	constructor(
		signaling: SignalingClient,
		userId: string,
		onPeersChanged: (peers: Map<string, PeerState>) => void
	) {
		this.signaling = signaling;
		this.userId = userId;
		this.onPeersChanged = onPeersChanged;
	}

	/** Configure ICE servers from the server-provided list. */
	setIceServers(servers: IceServerConfig[]): void {
		this.rtcConfig = { iceServers: servers.map((s) => ({ ...s })) };
	}

	async initLocalAudio(): Promise<MediaStream> {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('Microphone access is not available. Check app permissions in System Settings → Privacy & Security → Microphone.');
		}
		this.localStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			},
			video: false
		});
		return this.localStream;
	}

	/** Switch the audio input device, replacing the track on all peer connections. */
	async switchAudioInput(deviceId: string): Promise<void> {
		const newStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: { exact: deviceId },
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			},
			video: false
		});

		const newTrack = newStream.getAudioTracks()[0];
		if (!newTrack) return;

		// Preserve mute state
		const wasMuted = this.localStream?.getAudioTracks()[0]?.enabled === false;
		if (wasMuted) newTrack.enabled = false;

		// Replace the track on every peer connection
		for (const peer of this.peers.values()) {
			if (peer.connection) {
				const sender = peer.connection.getSenders().find((s) => s.track?.kind === 'audio');
				if (sender) {
					await sender.replaceTrack(newTrack);
				}
			}
		}

		// Stop old tracks and swap
		if (this.localStream) {
			for (const track of this.localStream.getAudioTracks()) {
				track.stop();
			}
		}
		this.localStream = newStream;
	}

	/** Switch the audio output device on all peer audio elements (where supported). */
	async switchAudioOutput(deviceId: string): Promise<void> {
		for (const audio of this.audioElements.values()) {
			if (typeof audio.setSinkId === 'function') {
				await audio.setSinkId(deviceId);
			}
		}
		for (const audio of this.screenAudioElements.values()) {
			if (typeof audio.setSinkId === 'function') {
				await audio.setSinkId(deviceId);
			}
		}
		this._outputDeviceId = deviceId;
	}

	/** Store a peer's username for later use (when their offer arrives). */
	registerPeer(peerId: string, username: string): void {
		this.peerUsernames.set(peerId, username);
	}

	/** Resolve a peer's display username. */
	private resolvePeerUsername(peerId: string, fallback: string): string {
		return this.peerUsernames.get(peerId) ?? fallback;
	}

	async createPeerConnection(
		peerId: string,
		peerUsername: string,
		isOfferer: boolean
	): Promise<RTCPeerConnection> {
		// Close any existing connection to avoid duplicates
		const existing = this.peers.get(peerId);
		if (existing?.connection) {
			existing.connection.close();
		}

		const pc = new RTCPeerConnection(this.rtcConfig);
		const peerState: PeerState = {
			id: peerId,
			username: peerUsername,
			is_muted: false,
			is_sharing_screen: false,
			is_camera_on: false,
			volume: 1,
			screenVolume: 1,
			connection: pc
		};

		if (this.localStream) {
			for (const track of this.localStream.getTracks()) {
				pc.addTrack(track, this.localStream);
			}
		}

		if (this.localScreenStream) {
			for (const track of this.localScreenStream.getTracks()) {
				pc.addTrack(track, this.localScreenStream);
			}
		}

		if (this.localCameraStream) {
			for (const track of this.localCameraStream.getTracks()) {
				pc.addTrack(track, this.localCameraStream);
			}
		}

		pc.ontrack = (event) => {
			// Use streams[0] if available, otherwise create a new stream from the track
			const stream = event.streams[0] ?? new MediaStream([event.track]);

			if (event.track.kind === 'audio') {
				// Track all incoming audio streams by their ID
				if (!this.peerAudioStreams.has(peerId)) {
					this.peerAudioStreams.set(peerId, new Map());
				}
				this.peerAudioStreams.get(peerId)!.set(stream.id, stream);

				event.track.addEventListener('ended', () => {
					this.peerAudioStreams.get(peerId)?.delete(stream.id);
					this.classifyAudioStreams(peerId);
				});
				event.track.addEventListener('mute', () => {
					this.peerAudioStreams.get(peerId)?.delete(stream.id);
					this.classifyAudioStreams(peerId);
				});

				this.classifyAudioStreams(peerId);
			} else if (event.track.kind === 'video') {
				// Store every incoming video stream by its ID
				if (!this.peerVideoStreams.has(peerId)) {
					this.peerVideoStreams.set(peerId, new Map());
				}
				this.peerVideoStreams.get(peerId)!.set(stream.id, stream);

				// When the track ends, remove it and re-classify
				event.track.addEventListener('ended', () => {
					const streams = this.peerVideoStreams.get(peerId);
					if (streams) {
						streams.delete(stream.id);
					}
					this.classifyVideoStreams(peerId);
				});

				// Also handle mute (track disabled remotely via removeTrack)
				event.track.addEventListener('mute', () => {
					const streams = this.peerVideoStreams.get(peerId);
					if (streams) {
						streams.delete(stream.id);
					}
					this.classifyVideoStreams(peerId);
				});

				this.classifyVideoStreams(peerId);
			}

			this.peers.set(peerId, peerState);
			this.notifyChanged();
		};

		// Renegotiation: when tracks are added/removed, create a new offer.
		// Use a makingOffer flag to implement "perfect negotiation" pattern and
		// avoid offe collisions between both sides.
		let makingOffer = false;

		pc.onnegotiationneeded = async () => {
			try {
				makingOffer = true;
				const offer = await pc.createOffer();
				if (pc.signalingState !== 'stable') return; // glare guard
				await pc.setLocalDescription(offer);
				this.signaling.send({
					type: 'offer',
					target_id: peerId,
					payload: { sdp: pc.localDescription!.sdp, type: pc.localDescription!.type }
				});
			} catch {
				// Negotiation failed — ignore
			} finally {
				makingOffer = false;
			}
		};

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.signaling.send({
					type: 'ice_candidate',
					target_id: peerId,
					payload: { candidate: event.candidate.toJSON() }
				});
			}
		};

		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
				this.removePeer(peerId);
			}
		};

		if (!isOfferer) {
			this.politeSet.add(peerId);
		}

		this.peers.set(peerId, peerState);
		this.notifyChanged();
		return pc;
	}

	async handleOffer(
		senderId: string,
		senderUsername: string,
		payload: Record<string, unknown>
	): Promise<void> {
		const resolvedUsername = this.resolvePeerUsername(senderId, senderUsername);
		const sdp = payload as { sdp: string; type: RTCSdpType };

		// Check if we already have a connection (renegotiation)
		const existing = this.peers.get(senderId);
		if (existing?.connection && existing.connection.signalingState !== 'closed') {
			const pc = existing.connection;
			const isPolite = this.politeSet.has(senderId);

			// Offer collision: if we're not the polite side, ignore the incoming offer
			if (!isPolite && pc.signalingState !== 'stable') {
				return;
			}

			// Polite side: rollback our own offer if needed
			await pc.setRemoteDescription(new RTCSessionDescription(sdp));
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			this.signaling.send({
				type: 'answer',
				target_id: senderId,
				payload: { sdp: answer.sdp, type: answer.type }
			});
			return;
		}

		// New connection
		const pc = await this.createPeerConnection(senderId, resolvedUsername, false);
		await pc.setRemoteDescription(new RTCSessionDescription(sdp));

		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);

		this.signaling.send({
			type: 'answer',
			target_id: senderId,
			payload: { sdp: answer.sdp, type: answer.type }
		});
	}

	async handleAnswer(senderId: string, payload: Record<string, unknown>): Promise<void> {
		const peer = this.peers.get(senderId);
		if (!peer?.connection) return;

		const sdp = payload as { sdp: string; type: RTCSdpType };
		await peer.connection.setRemoteDescription(new RTCSessionDescription(sdp));
	}

	async handleIceCandidate(senderId: string, payload: Record<string, unknown>): Promise<void> {
		const peer = this.peers.get(senderId);
		if (!peer?.connection) return;

		const candidate = (payload as { candidate: RTCIceCandidateInit }).candidate;
		if (candidate) {
			await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
		}
	}

	setVolume(peerId: string, volume: number): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;

		peer.volume = Math.max(0, Math.min(1, volume));
		const audio = this.audioElements.get(peerId);
		if (audio) {
			audio.volume = peer.volume;
		}
		this.notifyChanged();
	}

	setScreenVolume(peerId: string, volume: number): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;

		peer.screenVolume = Math.max(0, Math.min(1, volume));
		const audio = this.screenAudioElements.get(peerId);
		if (audio) {
			audio.volume = peer.screenVolume;
		}
		this.notifyChanged();
	}

	setLocalMuted(muted: boolean): void {
		if (this.localStream) {
			for (const track of this.localStream.getAudioTracks()) {
				track.enabled = !muted;
			}
		}
		this.signaling.send({
			type: 'mute_state',
			payload: { is_muted: muted }
		});
	}

	async startScreenShare(): Promise<MediaStream> {
		const stream = await navigator.mediaDevices.getDisplayMedia({
			video: true,
			audio: true
		});

		this.localScreenStream = stream;

		for (const peer of this.peers.values()) {
			if (peer.connection) {
				for (const track of stream.getTracks()) {
					peer.connection.addTrack(track, stream);
				}
			}
		}

		stream.getVideoTracks()[0]?.addEventListener('ended', () => {
			this.stopScreenShare();
		});

		this.signaling.send({
			type: 'screen_share_state',
			payload: { is_sharing_screen: true }
		});

		return stream;
	}

	stopScreenShare(): void {
		if (this.localScreenStream) {
			for (const track of this.localScreenStream.getTracks()) {
				track.stop();

				for (const peer of this.peers.values()) {
					if (peer.connection) {
						const senders = peer.connection.getSenders();
						const sender = senders.find((s) => s.track === track);
						if (sender) {
							peer.connection.removeTrack(sender);
						}
					}
				}
			}
			this.localScreenStream = null;
		}

		this.signaling.send({
			type: 'screen_share_state',
			payload: { is_sharing_screen: false }
		});
	}

	async startCamera(deviceId?: string): Promise<MediaStream> {
		const constraints: MediaStreamConstraints = {
			video: deviceId
				? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
				: { width: { ideal: 640 }, height: { ideal: 480 } },
			audio: false
		};

		const stream = await navigator.mediaDevices.getUserMedia(constraints);
		this.localCameraStream = stream;

		for (const peer of this.peers.values()) {
			if (peer.connection) {
				for (const track of stream.getTracks()) {
					peer.connection.addTrack(track, stream);
				}
			}
		}

		this.signaling.send({
			type: 'camera_state',
			payload: { is_camera_on: true }
		});

		return stream;
	}

	stopCamera(): void {
		if (this.localCameraStream) {
			for (const track of this.localCameraStream.getTracks()) {
				track.stop();

				for (const peer of this.peers.values()) {
					if (peer.connection) {
						const senders = peer.connection.getSenders();
						const sender = senders.find((s) => s.track === track);
						if (sender) {
							peer.connection.removeTrack(sender);
						}
					}
				}
			}
			this.localCameraStream = null;
		}

		this.signaling.send({
			type: 'camera_state',
			payload: { is_camera_on: false }
		});
	}

	async switchVideoInput(deviceId: string): Promise<void> {
		if (!this.localCameraStream) return;

		const newStream = await navigator.mediaDevices.getUserMedia({
			video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } },
			audio: false
		});

		const newTrack = newStream.getVideoTracks()[0];
		if (!newTrack) return;

		for (const peer of this.peers.values()) {
			if (peer.connection) {
				const sender = peer.connection.getSenders().find(
					(s) => s.track?.kind === 'video' && this.localCameraStream?.getVideoTracks().includes(s.track)
				);
				if (sender) {
					await sender.replaceTrack(newTrack);
				}
			}
		}

		for (const track of this.localCameraStream.getVideoTracks()) {
			track.stop();
		}
		this.localCameraStream = newStream;
	}

	getLocalCameraStream(): MediaStream | null {
		return this.localCameraStream;
	}

	updatePeerState(
		peerId: string,
		updates: Partial<Pick<PeerState, 'is_muted' | 'is_sharing_screen' | 'is_camera_on'>>
	): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;

		Object.assign(peer, updates);

		// Re-classify video streams whenever camera/screen state changes
		if ('is_camera_on' in updates || 'is_sharing_screen' in updates) {
			this.classifyVideoStreams(peerId);
		}

		this.notifyChanged();
	}

	/**
	 * Assign available video streams to videoStream (camera) and screenStream
	 * based on the peer's current state flags. When only one video stream exists,
	 * assign it according to whichever flag is on; when two exist, assign both.
	 */
	private classifyVideoStreams(peerId: string): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;

		const streams = this.peerVideoStreams.get(peerId);
		const available = streams ? Array.from(streams.values()) : [];

		// Reset assignments
		peer.videoStream = undefined;
		peer.screenStream = undefined;

		if (available.length === 0) {
			// Nothing to assign
		} else if (available.length === 1) {
			// Single video stream — assign based on which flag is active
			if (peer.is_camera_on) {
				peer.videoStream = available[0];
			} else if (peer.is_sharing_screen) {
				peer.screenStream = available[0];
			} else {
				// Flag hasn't arrived yet — assign to videoStream as default
				peer.videoStream = available[0];
			}
		} else {
			// Two (or more) video streams — assign first to camera, second to screen
			// The camera track is typically added first (getUserMedia before getDisplayMedia)
			peer.videoStream = available[0];
			peer.screenStream = available[1];
		}

		this.notifyChanged();
	}

	/**
	 * Assign available audio streams to audioStream (mic) and screenAudioStream.
	 * First audio stream = mic, second = screen share audio.
	 */
	private classifyAudioStreams(peerId: string): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;

		const streams = this.peerAudioStreams.get(peerId);
		const available = streams ? Array.from(streams.values()) : [];

		peer.audioStream = available[0] ?? undefined;
		peer.screenAudioStream = available[1] ?? undefined;

		// Play/update mic audio
		this.playAudio(peer);
		// Play/update screen share audio
		this.playScreenAudio(peer);

		this.peers.set(peerId, peer);
		this.notifyChanged();
	}

	removePeer(peerId: string): void {
		const peer = this.peers.get(peerId);
		if (peer) {
			peer.connection?.close();
			const audio = this.audioElements.get(peerId);
			if (audio) {
				audio.pause();
				audio.srcObject = null;
				this.audioElements.delete(peerId);
			}
			const screenAudio = this.screenAudioElements.get(peerId);
			if (screenAudio) {
				screenAudio.pause();
				screenAudio.srcObject = null;
				this.screenAudioElements.delete(peerId);
			}
			this.peerAudioStreams.delete(peerId);
			this.peerVideoStreams.delete(peerId);
			this.peers.delete(peerId);
			this.notifyChanged();
		}
	}

	destroy(): void {
		for (const peer of this.peers.values()) {
			peer.connection?.close();
		}
		this.peers.clear();
		this.peerUsernames.clear();
		this.peerAudioStreams.clear();
		this.peerVideoStreams.clear();

		for (const audio of this.audioElements.values()) {
			audio.pause();
			audio.srcObject = null;
		}
		this.audioElements.clear();

		for (const audio of this.screenAudioElements.values()) {
			audio.pause();
			audio.srcObject = null;
		}
		this.screenAudioElements.clear();

		if (this.localStream) {
			for (const track of this.localStream.getTracks()) {
				track.stop();
			}
			this.localStream = null;
		}

		this.stopScreenShare();
		this.stopCamera();
	}

	getPeers(): Map<string, PeerState> {
		return new Map(this.peers);
	}

	private playAudio(peer: PeerState): void {
		if (!peer.audioStream) {
			// No mic audio — clean up existing element
			const existing = this.audioElements.get(peer.id);
			if (existing) {
				existing.pause();
				existing.srcObject = null;
				this.audioElements.delete(peer.id);
			}
			return;
		}

		// Remove existing audio element for this peer
		const existing = this.audioElements.get(peer.id);
		if (existing) {
			// If same stream, just update volume
			if (existing.srcObject === peer.audioStream) {
				existing.volume = peer.volume;
				return;
			}
			existing.pause();
			existing.srcObject = null;
		}

		const audio = new Audio();
		audio.srcObject = peer.audioStream;
		audio.volume = peer.volume;
		audio.autoplay = true;
		if (this._outputDeviceId && typeof audio.setSinkId === 'function') {
			audio.setSinkId(this._outputDeviceId).catch(() => {});
		}
		audio.play().catch(() => {});
		this.audioElements.set(peer.id, audio);
	}

	private playScreenAudio(peer: PeerState): void {
		if (!peer.screenAudioStream) {
			// No screen audio — clean up existing element
			const existing = this.screenAudioElements.get(peer.id);
			if (existing) {
				existing.pause();
				existing.srcObject = null;
				this.screenAudioElements.delete(peer.id);
			}
			return;
		}

		const existing = this.screenAudioElements.get(peer.id);
		if (existing) {
			if (existing.srcObject === peer.screenAudioStream) {
				existing.volume = peer.screenVolume;
				return;
			}
			existing.pause();
			existing.srcObject = null;
		}

		const audio = new Audio();
		audio.srcObject = peer.screenAudioStream;
		audio.volume = peer.screenVolume;
		audio.autoplay = true;
		if (this._outputDeviceId && typeof audio.setSinkId === 'function') {
			audio.setSinkId(this._outputDeviceId).catch(() => {});
		}
		audio.play().catch(() => {});
		this.screenAudioElements.set(peer.id, audio);
	}

	private notifyChanged(): void {
		this.onPeersChanged(this.getPeers());
	}
}
