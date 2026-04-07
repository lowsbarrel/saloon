/** Shared types matching the server models. */

export interface UserInfo {
	id: string;
	username: string;
	is_muted: boolean;
	is_sharing_screen: boolean;
	is_camera_on: boolean;
}

export interface ChannelInfo {
	id: string;
	name: string;
	is_private: boolean;
	user_count: number;
	users: UserInfo[];
}

export interface UsernameResponse {
	user_id: string;
	username: string;
	token: string;
}

export interface IceServersResponse {
	ice_servers: IceServerConfig[];
}

export interface IceServerConfig {
	urls: string | string[];
	username?: string;
	credential?: string;
}

export type WSMessageType =
	| 'offer'
	| 'answer'
	| 'ice_candidate'
	| 'peer_joined'
	| 'peer_left'
	| 'chat_message'
	| 'encrypted_chat'
	| 'chat_history'
	| 'public_key'
	| 'peer_public_key'
	| 'mute_state'
	| 'screen_share_state'
	| 'camera_state'
	| 'error'
	| 'peer_list'
	| 'leave'
	| 'ping'
	| 'pong';

export interface WSMessage {
	type: WSMessageType;
	sender_id?: string;
	target_id?: string;
	payload?: Record<string, unknown> | string | null;
}

export interface ChatMessage {
	sender_id: string;
	username: string;
	content: string;
	timestamp: number;
}

export interface PeerState {
	id: string;
	username: string;
	is_muted: boolean;
	is_sharing_screen: boolean;
	is_camera_on: boolean;
	volume: number; // 0-1, mic volume local only
	screenVolume: number; // 0-1, screen share audio volume local only
	connection?: RTCPeerConnection;
	audioStream?: MediaStream;
	screenAudioStream?: MediaStream;
	screenStream?: MediaStream;
	videoStream?: MediaStream;
	publicKey?: Uint8Array;
}
