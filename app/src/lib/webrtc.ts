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
	private audioElements = new Map<string, HTMLAudioElement>();
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
			volume: 1,
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

		pc.ontrack = (event) => {
			// Use streams[0] if available, otherwise create a new stream from the track
			const stream = event.streams[0] ?? new MediaStream([event.track]);

			if (event.track.kind === 'audio') {
				peerState.audioStream = stream;
				this.playAudio(peerState);
			} else if (event.track.kind === 'video') {
				peerState.screenStream = stream;
			}

			this.peers.set(peerId, peerState);
			this.notifyChanged();
		};

		// Renegotiation: when tracks are added/removed, create a new offer
		// For the polite (answerer) side, only renegotiate after the connection is established
		pc.onnegotiationneeded = async () => {
			try {
				// If we're the polite side AND not yet connected, skip — we'll get their offer
				if (!isOfferer && pc.connectionState !== 'connected') return;

				const offer = await pc.createOffer();
				await pc.setLocalDescription(offer);
				this.signaling.send({
					type: 'offer',
					target_id: peerId,
					payload: { sdp: pc.localDescription!.sdp, type: pc.localDescription!.type }
				});
			} catch {
				// Negotiation failed — ignore
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

		// Check if we already have a connection (renegotiation for screen share)
		const existing = this.peers.get(senderId);
		if (existing?.connection && existing.connection.signalingState !== 'closed') {
			const pc = existing.connection;
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

	updatePeerState(
		peerId: string,
		updates: Partial<Pick<PeerState, 'is_muted' | 'is_sharing_screen'>>
	): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;

		Object.assign(peer, updates);
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

		for (const audio of this.audioElements.values()) {
			audio.pause();
			audio.srcObject = null;
		}
		this.audioElements.clear();

		if (this.localStream) {
			for (const track of this.localStream.getTracks()) {
				track.stop();
			}
			this.localStream = null;
		}

		this.stopScreenShare();
	}

	getPeers(): Map<string, PeerState> {
		return new Map(this.peers);
	}

	private playAudio(peer: PeerState): void {
		if (!peer.audioStream) return;

		// Remove existing audio element for this peer
		const existing = this.audioElements.get(peer.id);
		if (existing) {
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
		audio.play().catch(() => {
			// Autoplay blocked — will retry on user interaction
		});
		this.audioElements.set(peer.id, audio);
	}

	private notifyChanged(): void {
		this.onPeersChanged(this.getPeers());
	}
}
