/**
 * WebRTC peer connection manager.
 *
 * Orchestrates peer connections, local media tracks, screen sharing,
 * camera, and per‑peer volume control.
 */

import type { PeerState, IceServerConfig } from '$lib/types';
import type { SignalingClient } from '$lib/signaling';
import { classifyVideoStreams, classifyAudioStreams } from './stream-classifier';
import {
	playAudio,
	destroyAudioStore,
	switchOutputDevice,
	type AudioElementStore,
} from './audio-player';

const DEFAULT_RTC_CONFIG: RTCConfiguration = { iceServers: [] };

function isSdpPayload(p: Record<string, unknown>): p is { sdp: string; type: RTCSdpType } {
	return typeof p.sdp === 'string' && typeof p.type === 'string';
}

function isIceCandidatePayload(p: Record<string, unknown>): p is { candidate: RTCIceCandidateInit } {
	return p.candidate != null && typeof p.candidate === 'object';
}

export class PeerManager {
	private peers = new Map<string, PeerState>();
	private peerUsernames = new Map<string, string>();
	private politeSet = new Set<string>();
	private localStream: MediaStream | null = null;
	private localScreenStream: MediaStream | null = null;
	private localCameraStream: MediaStream | null = null;

	private micAudio: AudioElementStore = { elements: new Map(), outputDeviceId: '' };
	private screenAudio: AudioElementStore = { elements: new Map(), outputDeviceId: '' };

	private peerAudioStreams = new Map<string, Map<string, MediaStream>>();
	private peerVideoStreams = new Map<string, Map<string, MediaStream>>();
	private signaling: SignalingClient;
	private userId: string;
	private onPeersChanged: (peers: Map<string, PeerState>) => void;
	private rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG;

	constructor(
		signaling: SignalingClient,
		userId: string,
		onPeersChanged: (peers: Map<string, PeerState>) => void,
	) {
		this.signaling = signaling;
		this.userId = userId;
		this.onPeersChanged = onPeersChanged;
	}

	// ── Configuration ──────────────────────────────────────────────────

	setIceServers(servers: IceServerConfig[]): void {
		this.rtcConfig = { iceServers: servers.map((s) => ({ ...s })) };
	}

	// ── Local media ────────────────────────────────────────────────────

	async initLocalAudio(): Promise<MediaStream> {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error(
				'Microphone access is not available. Check app permissions in System Settings → Privacy & Security → Microphone.',
			);
		}
		this.localStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			video: false,
		});
		return this.localStream;
	}

	async switchAudioInput(deviceId: string): Promise<void> {
		const newStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: { exact: deviceId },
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
			video: false,
		});

		const newTrack = newStream.getAudioTracks()[0];
		if (!newTrack) return;

		const wasMuted = this.localStream?.getAudioTracks()[0]?.enabled === false;
		if (wasMuted) newTrack.enabled = false;

		for (const peer of this.peers.values()) {
			if (peer.connection) {
				const sender = peer.connection.getSenders().find((s) => s.track?.kind === 'audio');
				if (sender) await sender.replaceTrack(newTrack);
			}
		}

		this.stopLocalTracks(this.localStream, 'audio');
		this.localStream = newStream;
	}

	async switchAudioOutput(deviceId: string): Promise<void> {
		await switchOutputDevice(this.micAudio, deviceId);
		await switchOutputDevice(this.screenAudio, deviceId);
	}

	// ── Peer registration ──────────────────────────────────────────────

	registerPeer(peerId: string, username: string): void {
		this.peerUsernames.set(peerId, username);
	}

	private resolvePeerUsername(peerId: string, fallback: string): string {
		return this.peerUsernames.get(peerId) ?? fallback;
	}

	// ── Peer connection lifecycle ──────────────────────────────────────

	async createPeerConnection(
		peerId: string,
		peerUsername: string,
		isOfferer: boolean,
	): Promise<RTCPeerConnection> {
		const existing = this.peers.get(peerId);
		if (existing?.connection) existing.connection.close();

		const pc = new RTCPeerConnection(this.rtcConfig);
		const peerState: PeerState = {
			id: peerId,
			username: peerUsername,
			is_muted: false,
			is_sharing_screen: false,
			is_camera_on: false,
			volume: 1,
			screenVolume: 1,
			connection: pc,
		};

		this.addLocalTracks(pc);
		this.attachTrackHandlers(pc, peerId, peerState);
		this.attachNegotiationHandlers(pc, peerId);

		if (!isOfferer) this.politeSet.add(peerId);

		this.peers.set(peerId, peerState);
		this.notifyChanged();
		return pc;
	}

	private addLocalTracks(pc: RTCPeerConnection): void {
		for (const stream of [this.localStream, this.localScreenStream, this.localCameraStream]) {
			if (stream) {
				for (const track of stream.getTracks()) {
					pc.addTrack(track, stream);
				}
			}
		}
	}

	private attachTrackHandlers(
		pc: RTCPeerConnection,
		peerId: string,
		peerState: PeerState,
	): void {
		pc.ontrack = (event) => {
			const stream = event.streams[0] ?? new MediaStream([event.track]);

			if (event.track.kind === 'audio') {
				this.ensureStreamMap(this.peerAudioStreams, peerId).set(stream.id, stream);

				const cleanup = () => {
					this.peerAudioStreams.get(peerId)?.delete(stream.id);
					this.reclassifyAudio(peerId);
				};
				event.track.addEventListener('ended', cleanup);
				event.track.addEventListener('mute', cleanup);

				this.reclassifyAudio(peerId);
			} else if (event.track.kind === 'video') {
				this.ensureStreamMap(this.peerVideoStreams, peerId).set(stream.id, stream);

				const cleanup = () => {
					this.peerVideoStreams.get(peerId)?.delete(stream.id);
					this.reclassifyVideo(peerId);
				};
				event.track.addEventListener('ended', cleanup);
				event.track.addEventListener('mute', cleanup);

				this.reclassifyVideo(peerId);
			}

			this.peers.set(peerId, peerState);
			this.notifyChanged();
		};
	}

	private attachNegotiationHandlers(pc: RTCPeerConnection, peerId: string): void {
		let makingOffer = false;

		pc.onnegotiationneeded = async () => {
			try {
				makingOffer = true;
				const offer = await pc.createOffer();
				if (pc.signalingState !== 'stable') return;
				await pc.setLocalDescription(offer);
				this.signaling.send({
					type: 'offer',
					target_id: peerId,
					payload: { sdp: pc.localDescription!.sdp, type: pc.localDescription!.type },
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
					payload: { candidate: event.candidate.toJSON() },
				});
			}
		};

		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
				this.removePeer(peerId);
			}
		};
	}

	// ── Signaling handlers ─────────────────────────────────────────────

	async handleOffer(
		senderId: string,
		senderUsername: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		const resolvedUsername = this.resolvePeerUsername(senderId, senderUsername);
		if (!isSdpPayload(payload)) return;

		const existing = this.peers.get(senderId);
		if (existing?.connection && existing.connection.signalingState !== 'closed') {
			const pc = existing.connection;
			const isPolite = this.politeSet.has(senderId);
			if (!isPolite && pc.signalingState !== 'stable') return;

			await pc.setRemoteDescription(new RTCSessionDescription(payload));
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			this.signaling.send({
				type: 'answer',
				target_id: senderId,
				payload: { sdp: answer.sdp, type: answer.type },
			});
			return;
		}

		const pc = await this.createPeerConnection(senderId, resolvedUsername, false);
		await pc.setRemoteDescription(new RTCSessionDescription(payload));
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		this.signaling.send({
			type: 'answer',
			target_id: senderId,
			payload: { sdp: answer.sdp, type: answer.type },
		});
	}

	async handleAnswer(senderId: string, payload: Record<string, unknown>): Promise<void> {
		const peer = this.peers.get(senderId);
		if (!peer?.connection || !isSdpPayload(payload)) return;
		await peer.connection.setRemoteDescription(new RTCSessionDescription(payload));
	}

	async handleIceCandidate(senderId: string, payload: Record<string, unknown>): Promise<void> {
		const peer = this.peers.get(senderId);
		if (!peer?.connection || !isIceCandidatePayload(payload)) return;
		await peer.connection.addIceCandidate(new RTCIceCandidate(payload.candidate));
	}

	// ── Volume ─────────────────────────────────────────────────────────

	setVolume(peerId: string, volume: number): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;
		peer.volume = Math.max(0, Math.min(1, volume));
		const audio = this.micAudio.elements.get(peerId);
		if (audio) audio.volume = peer.volume;
		this.notifyChanged();
	}

	setScreenVolume(peerId: string, volume: number): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;
		peer.screenVolume = Math.max(0, Math.min(1, volume));
		const audio = this.screenAudio.elements.get(peerId);
		if (audio) audio.volume = peer.screenVolume;
		this.notifyChanged();
	}

	// ── Mute ───────────────────────────────────────────────────────────

	setLocalMuted(muted: boolean): void {
		if (this.localStream) {
			for (const track of this.localStream.getAudioTracks()) {
				track.enabled = !muted;
			}
		}
		this.signaling.send({ type: 'mute_state', payload: { is_muted: muted } });
	}

	// ── Screen sharing ─────────────────────────────────────────────────

	async startScreenShare(): Promise<MediaStream> {
		const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
		this.localScreenStream = stream;

		this.addStreamToPeers(stream);

		stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopScreenShare());
		this.signaling.send({ type: 'screen_share_state', payload: { is_sharing_screen: true } });
		return stream;
	}

	stopScreenShare(): void {
		if (!this.localScreenStream) return;
		this.removeStreamFromPeers(this.localScreenStream);
		this.localScreenStream = null;
		this.signaling.send({ type: 'screen_share_state', payload: { is_sharing_screen: false } });
	}

	// ── Camera ─────────────────────────────────────────────────────────

	async startCamera(deviceId?: string): Promise<MediaStream> {
		const constraints: MediaStreamConstraints = {
			video: deviceId
				? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
				: { width: { ideal: 640 }, height: { ideal: 480 } },
			audio: false,
		};
		const stream = await navigator.mediaDevices.getUserMedia(constraints);
		this.localCameraStream = stream;
		this.addStreamToPeers(stream);
		this.signaling.send({ type: 'camera_state', payload: { is_camera_on: true } });
		return stream;
	}

	stopCamera(): void {
		if (!this.localCameraStream) return;
		this.removeStreamFromPeers(this.localCameraStream);
		this.localCameraStream = null;
		this.signaling.send({ type: 'camera_state', payload: { is_camera_on: false } });
	}

	async switchVideoInput(deviceId: string): Promise<void> {
		if (!this.localCameraStream) return;

		const newStream = await navigator.mediaDevices.getUserMedia({
			video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } },
			audio: false,
		});
		const newTrack = newStream.getVideoTracks()[0];
		if (!newTrack) return;

		for (const peer of this.peers.values()) {
			if (peer.connection) {
				const sender = peer.connection
					.getSenders()
					.find(
						(s) =>
							s.track?.kind === 'video' &&
							this.localCameraStream?.getVideoTracks().includes(s.track),
					);
				if (sender) await sender.replaceTrack(newTrack);
			}
		}

		this.stopLocalTracks(this.localCameraStream, 'video');
		this.localCameraStream = newStream;
	}

	getLocalCameraStream(): MediaStream | null {
		return this.localCameraStream;
	}

	// ── Peer state updates ─────────────────────────────────────────────

	updatePeerState(
		peerId: string,
		updates: Partial<Pick<PeerState, 'is_muted' | 'is_sharing_screen' | 'is_camera_on'>>,
	): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;
		Object.assign(peer, updates);
		if ('is_camera_on' in updates || 'is_sharing_screen' in updates) {
			this.reclassifyVideo(peerId);
		}
		this.notifyChanged();
	}

	// ── Peer removal & cleanup ─────────────────────────────────────────

	removePeer(peerId: string): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;

		peer.connection?.close();

		this.cleanupPeerAudio(peerId, this.micAudio);
		this.cleanupPeerAudio(peerId, this.screenAudio);
		this.peerAudioStreams.delete(peerId);
		this.peerVideoStreams.delete(peerId);
		this.peers.delete(peerId);
		this.notifyChanged();
	}

	destroy(): void {
		for (const peer of this.peers.values()) peer.connection?.close();
		this.peers.clear();
		this.peerUsernames.clear();
		this.peerAudioStreams.clear();
		this.peerVideoStreams.clear();

		destroyAudioStore(this.micAudio);
		destroyAudioStore(this.screenAudio);

		if (this.localStream) {
			for (const track of this.localStream.getTracks()) track.stop();
			this.localStream = null;
		}
		this.stopScreenShare();
		this.stopCamera();
	}

	getPeers(): Map<string, PeerState> {
		return new Map(this.peers);
	}

	// ── Private helpers ────────────────────────────────────────────────

	private reclassifyVideo(peerId: string): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;
		classifyVideoStreams(peer, this.peerVideoStreams.get(peerId));
		this.notifyChanged();
	}

	private reclassifyAudio(peerId: string): void {
		const peer = this.peers.get(peerId);
		if (!peer) return;
		classifyAudioStreams(peer, this.peerAudioStreams.get(peerId));
		playAudio(this.micAudio, peer.id, peer.audioStream, peer.volume);
		playAudio(this.screenAudio, peer.id, peer.screenAudioStream, peer.screenVolume);
		this.peers.set(peerId, peer);
		this.notifyChanged();
	}

	private ensureStreamMap(
		store: Map<string, Map<string, MediaStream>>,
		peerId: string,
	): Map<string, MediaStream> {
		let map = store.get(peerId);
		if (!map) {
			map = new Map();
			store.set(peerId, map);
		}
		return map;
	}

	private addStreamToPeers(stream: MediaStream): void {
		for (const peer of this.peers.values()) {
			if (peer.connection) {
				for (const track of stream.getTracks()) {
					peer.connection.addTrack(track, stream);
				}
			}
		}
	}

	private removeStreamFromPeers(stream: MediaStream): void {
		for (const track of stream.getTracks()) {
			track.stop();
			for (const peer of this.peers.values()) {
				if (peer.connection) {
					const sender = peer.connection.getSenders().find((s) => s.track === track);
					if (sender) peer.connection.removeTrack(sender);
				}
			}
		}
	}

	private stopLocalTracks(stream: MediaStream | null, kind: 'audio' | 'video'): void {
		if (!stream) return;
		const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
		for (const track of tracks) track.stop();
	}

	private cleanupPeerAudio(peerId: string, store: AudioElementStore): void {
		const audio = store.elements.get(peerId);
		if (audio) {
			audio.pause();
			audio.srcObject = null;
			store.elements.delete(peerId);
		}
	}

	private notifyChanged(): void {
		this.onPeersChanged(this.getPeers());
	}
}
