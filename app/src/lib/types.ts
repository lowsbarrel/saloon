/** Shared types matching the server models. */

export interface UserInfo {
	id: string;
	username: string;
	is_muted: boolean;
	is_sharing_screen: boolean;
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
}

export type WSMessageType =
	| 'offer'
	| 'answer'
	| 'ice_candidate'
	| 'peer_joined'
	| 'peer_left'
	| 'chat_message'
	| 'mute_state'
	| 'screen_share_state'
	| 'error'
	| 'peer_list';

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
	volume: number; // 0-1, local only
	connection?: RTCPeerConnection;
	audioStream?: MediaStream;
	screenStream?: MediaStream;
}
