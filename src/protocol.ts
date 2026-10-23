// Wire protocol over a plain TCP socket. Topology is a star: one peer hosts,
// everyone else connects to it and the host relays messages between clients.
//
// The handshake is newline-delimited JSON, so peers on another protocol
// version still read each other's reject:
//   client: hello            host: open | challenge
//   client: auth             host: auth-ok | reject       (password set)
// From the line after `open` / `auth-ok` on, both directions switch to
// length-prefixed frames, AES-GCM sealed when a password is set, starting
// with the client's `join` and the host's `welcome`.

export const PROTOCOL_VERSION = 2;
export const HOST_ID = "host";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SceneElement = {
	id: string;
	version: number;
	versionNonce: number;
	isDeleted?: boolean;
	index?: string | null;
	fileId?: string | null;
	[key: string]: any;
};

export type BinaryFile = {
	id: string;
	mimeType: string;
	dataURL: string;
	created: number;
	[key: string]: any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PeerInfo {
	id: string;
	name: string;
	color: string;
}

export interface PointerState {
	x: number;
	y: number;
	tool: "pointer" | "laser";
	button: "up" | "down";
	selectedElementIds: string[];
}

export type Message =
	| { t: "hello"; proto: number }
	| { t: "open" }
	| { t: "challenge"; salt: string; nonce: string }
	| { t: "auth"; nonce: string; proof: string }
	| { t: "auth-ok"; proof: string }
	| { t: "join"; name: string; color: string }
	| { t: "welcome"; id: string; peers: PeerInfo[]; drawing: string; elements: SceneElement[]; files: BinaryFile[] }
	| { t: "reject"; reason: string }
	| { t: "peer-join"; peer: PeerInfo }
	| { t: "peer-leave"; id: string }
	| { t: "elements"; from?: string; elements: SceneElement[] }
	| { t: "files"; from?: string; files: BinaryFile[] }
	| { t: "pointer"; from?: string; pointer: PointerState }
	| { t: "sync-request"; from?: string }
	| { t: "ping" }
	| { t: "pong" };

/** Messages a client may send that the host forwards to the other clients. */
export const RELAYED: ReadonlySet<Message["t"]> = new Set(["elements", "files", "pointer"]);
