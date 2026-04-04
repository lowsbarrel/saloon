/** Audio playback helpers for peer mic and screen‑share audio. */

export interface AudioElementStore {
	elements: Map<string, HTMLAudioElement>;
	outputDeviceId: string;
}

/** Create or update the HTMLAudioElement for a peer's mic stream. */
export function playAudio(
	store: AudioElementStore,
	peerId: string,
	stream: MediaStream | undefined,
	volume: number,
): void {
	if (!stream) {
		const existing = store.elements.get(peerId);
		if (existing) {
			existing.pause();
			existing.srcObject = null;
			store.elements.delete(peerId);
		}
		return;
	}

	const existing = store.elements.get(peerId);
	if (existing) {
		if (existing.srcObject === stream) {
			existing.volume = volume;
			return;
		}
		existing.pause();
		existing.srcObject = null;
	}

	const audio = new Audio();
	audio.srcObject = stream;
	audio.volume = volume;
	audio.autoplay = true;
	if (store.outputDeviceId && typeof audio.setSinkId === 'function') {
		audio.setSinkId(store.outputDeviceId).catch(() => {});
	}
	audio.play().catch(() => {});
	store.elements.set(peerId, audio);
}

/** Clean up all audio elements in a store. */
export function destroyAudioStore(store: AudioElementStore): void {
	for (const audio of store.elements.values()) {
		audio.pause();
		audio.srcObject = null;
	}
	store.elements.clear();
}

/** Switch output device on all elements in a store. */
export async function switchOutputDevice(
	store: AudioElementStore,
	deviceId: string,
): Promise<void> {
	store.outputDeviceId = deviceId;
	for (const audio of store.elements.values()) {
		if (typeof audio.setSinkId === 'function') {
			await audio.setSinkId(deviceId);
		}
	}
}
