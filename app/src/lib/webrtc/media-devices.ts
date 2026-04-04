/** Media device enumeration and management. */

export interface DeviceLists {
	audioInput: MediaDeviceInfo[];
	audioOutput: MediaDeviceInfo[];
	videoInput: MediaDeviceInfo[];
}

/** Enumerate all media devices, grouped by kind. */
export async function enumerateDevices(): Promise<DeviceLists> {
	const devices = await navigator.mediaDevices.enumerateDevices();
	return {
		audioInput: devices.filter((d) => d.kind === 'audioinput'),
		audioOutput: devices.filter((d) => d.kind === 'audiooutput'),
		videoInput: devices.filter((d) => d.kind === 'videoinput'),
	};
}
