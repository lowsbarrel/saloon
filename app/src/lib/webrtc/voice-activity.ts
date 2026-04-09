/** Voice activity detection via AnalyserNode on remote/local audio streams. */

const THRESHOLD = 18;
const POLL_MS = 80;
const HOLD_MS = 350;

export interface VadHandle {
	destroy(): void;
}

export function createVoiceDetector(
	stream: MediaStream,
	onChange: (talking: boolean) => void,
): VadHandle {
	const ctx = new AudioContext();
	const source = ctx.createMediaStreamSource(stream);
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 256;
	source.connect(analyser);

	const buf = new Uint8Array(analyser.frequencyBinCount);
	let talking = false;
	let lastVoice = 0;

	const id = setInterval(() => {
		analyser.getByteFrequencyData(buf);
		let sum = 0;
		for (let i = 0; i < buf.length; i++) sum += buf[i];
		const avg = sum / buf.length;

		if (avg > THRESHOLD) {
			lastVoice = Date.now();
			if (!talking) {
				talking = true;
				onChange(true);
			}
		} else if (talking && Date.now() - lastVoice > HOLD_MS) {
			talking = false;
			onChange(false);
		}
	}, POLL_MS);

	return {
		destroy() {
			clearInterval(id);
			source.disconnect();
			ctx.close().catch(() => {});
		},
	};
}
