/** Public API for the webrtc module. */

export { PeerManager } from './peer-manager';
export { enumerateDevices, type DeviceLists } from './media-devices';
export { classifyVideoStreams, classifyAudioStreams } from './stream-classifier';
export { playAudio, destroyAudioStore, switchOutputDevice, type AudioElementStore } from './audio-player';
export { createVoiceDetector, type VadHandle } from './voice-activity';
