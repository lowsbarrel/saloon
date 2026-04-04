/** Classify incoming media streams into camera / screen and mic / screen‑audio. */

import type { PeerState } from '$lib/types';

/**
 * Assign available video streams to `videoStream` (camera) and `screenStream`
 * based on the peer's current state flags.
 */
export function classifyVideoStreams(
	peer: PeerState,
	streams: Map<string, MediaStream> | undefined,
): void {
	const available = streams ? Array.from(streams.values()) : [];

	peer.videoStream = undefined;
	peer.screenStream = undefined;

	if (available.length === 0) {
		return;
	} else if (available.length === 1) {
		if (peer.is_camera_on) {
			peer.videoStream = available[0];
		} else if (peer.is_sharing_screen) {
			peer.screenStream = available[0];
		} else {
			peer.videoStream = available[0];
		}
	} else {
		// Camera track is typically added first (getUserMedia before getDisplayMedia)
		peer.videoStream = available[0];
		peer.screenStream = available[1];
	}
}

/**
 * Assign available audio streams to `audioStream` (mic) and `screenAudioStream`.
 * First audio stream = mic, second = screen share audio.
 */
export function classifyAudioStreams(
	peer: PeerState,
	streams: Map<string, MediaStream> | undefined,
): void {
	const available = streams ? Array.from(streams.values()) : [];

	peer.audioStream = available[0] ?? undefined;
	peer.screenAudioStream = available[1] ?? undefined;
}
