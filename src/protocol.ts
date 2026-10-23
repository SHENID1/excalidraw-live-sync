// Wire protocol: newline-delimited JSON over a plain TCP socket.
// Topology is a star: one peer hosts, everyone else connects to it and the
// host relays messages between clients.

export const PROTOCOL_VERSION = 1;
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
	| { t: "hello"; proto: number; name: string; color: string; password: string }
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
