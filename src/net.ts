import * as net from "net";
import * as os from "os";
import { randomBytes } from "crypto";
import {
	CipherPair,
	derivePasswordKey,
	makeNonce,
	makeProof,
	PasswordKey,
	proofMatches,
	sessionCiphers,
} from "./crypto";
import { t } from "./i18n";
import { BinaryFile, HOST_ID, Message, PeerInfo, PROTOCOL_VERSION, RELAYED, SceneElement } from "./protocol";

const MAX_BUFFER = 256 * 1024 * 1024; // a single message may carry embedded images
const MAX_LINE = 64 * 1024; // handshake lines are tiny
const PING_INTERVAL = 5_000;
const DEAD_AFTER = 25_000;
const HANDSHAKE_TIMEOUT = 10_000;
/** Pointer updates are dropped instead of queued once this much is waiting to be written. */
const VOLATILE_BACKLOG = 512 * 1024;
const NEWLINE = Buffer.from("\n");

export interface TransportEvents {
	onMessage(msg: Message): void;
	onPeerJoin(peer: PeerInfo): void;
	onPeerLeave(id: string): void;
	onClosed(reason: string): void;
}

export interface Transport {
	readonly selfId: string;
	send(msg: Message): void;
	close(): void;
}

export interface Snapshot {
	drawing: string;
	elements: SceneElement[];
	files: BinaryFile[];
}

/**
 * Message framing plus keepalive on top of a TCP socket. Starts out reading and
 * writing JSON lines for the handshake; `upgrade()` switches both directions to
 * length-prefixed frames, sealed with AES-GCM when given ciphers.
 */
class PeerSocket {
	private parts: Buffer[] = [];
	private size = 0;
	/** Bytes needed before the next message can be parsed; avoids re-joining a large frame on every chunk. */
	private need = 0;
	private framed = false;
	private ciphers: CipherPair | null = null;
	private lastSeen = Date.now();
	private pingTimer: number | null = null;
	private closed = false;

	constructor(
		readonly sock: net.Socket,
		private onMessage: (msg: Message) => void,
		private onClose: (reason: string) => void,
	) {
		sock.setNoDelay(true);
		sock.setKeepAlive(true, 10_000);
		sock.on("data", (chunk: Buffer) => this.onData(chunk));
		sock.on("error", (err) => this.close(err.message));
		sock.on("close", () => this.close("netClosed"));
	}

	get remote(): string {
		return `${this.sock.remoteAddress ?? "?"}:${this.sock.remotePort ?? "?"}`;
	}

	get encrypted(): boolean {
		return !!this.ciphers;
	}

	/**
	 * Switches to frames. Must run synchronously right after the last handshake
	 * line is sent and read on this side, so no line and frame ever interleave.
	 */
	upgrade(ciphers: CipherPair | null): void {
		this.framed = true;
		this.ciphers = ciphers;
		this.lastSeen = Date.now();
		// Pings only start now: a ping line racing the switch would corrupt the stream.
		this.pingTimer = window.setInterval(() => {
			if (Date.now() - this.lastSeen > DEAD_AFTER) this.close("netTimeout");
			else this.send({ t: "ping" }, true);
		}, PING_INTERVAL);
	}

	send(msg: Message, volatile = false): void {
		if (this.closed || !this.sock.writable) return;
		if (volatile && this.sock.writableLength > VOLATILE_BACKLOG) return;
		const json = Buffer.from(JSON.stringify(msg), "utf8");
		if (!this.framed) {
			this.sock.write(Buffer.concat([json, NEWLINE]));
			return;
		}
		const body = this.ciphers ? this.ciphers.send.seal(json) : json;
		const head = Buffer.alloc(4);
		head.writeUInt32BE(body.length);
		this.sock.write(Buffer.concat([head, body]));
	}

	/** Sends a final message and half-closes, letting it flush before the socket goes away. */
	finish(msg: Message): void {
		if (this.closed) return;
		this.send(msg);
		this.sock.end();
	}

	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
		this.sock.destroy();
		this.onClose(reason);
	}

	private onData(chunk: Buffer): void {
		this.lastSeen = Date.now();
		this.parts.push(chunk);
		this.size += chunk.length;
		if (this.size < this.need) return;

		let buf = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
		let pos = 0;
		this.need = 0;
		while (!this.closed) {
			let body: Buffer;
			if (this.framed) {
				if (buf.length - pos < 4) {
					this.need = 4;
					break;
				}
				const len = buf.readUInt32BE(pos);
				if (len > MAX_BUFFER) return this.close("netTooLarge");
				if (buf.length - pos < 4 + len) {
					this.need = 4 + len;
					break;
				}
				body = buf.subarray(pos + 4, pos + 4 + len);
				pos += 4 + len;
			} else {
				const nl = buf.indexOf(0x0a, pos);
				if (nl < 0) {
					if (buf.length - pos > MAX_LINE) return this.close("netProtocol");
					break;
				}
				body = buf.subarray(pos, nl);
				pos = nl + 1;
				if (!body.length) continue;
			}

			let msg: Message;
			try {
				const plain = this.framed && this.ciphers ? this.ciphers.recv.open(body) : body;
				msg = JSON.parse(plain.toString("utf8")) as Message;
			} catch {
				// A frame that fails authentication means tampering or a desynced stream; nothing after it can be trusted.
				if (this.framed && this.ciphers) return this.close("netDecrypt");
				console.warn("[excalidraw-live] malformed message from", this.remote);
				continue;
			}
			if (msg.t === "ping") this.send({ t: "pong" }, true);
			else if (msg.t !== "pong") this.onMessage(msg);
		}

		buf = buf.subarray(pos);
		this.parts = buf.length ? [buf] : [];
		this.size = buf.length;
	}
}

type HandshakeStage = "hello" | "auth" | "join";

interface HostClient {
	ls: PeerSocket;
	peer: PeerInfo | null;
	stage: HandshakeStage;
	hostNonce: string;
}

export interface HostOptions {
	port: number;
	/** Peers must prove they know the password behind this key; null lets anyone in, unencrypted. */
	key: PasswordKey | null;
	self: PeerInfo;
	getSnapshot(): Snapshot;
}

/** The hosting peer: accepts clients and relays their changes to each other. */
export class LiveHost implements Transport {
	readonly selfId = HOST_ID;
	private clients = new Set<HostClient>();

	private constructor(
		private server: net.Server,
		private opts: HostOptions,
		private events: TransportEvents,
	) {
		server.on("connection", (sock) => this.accept(sock));
	}

	static start(opts: HostOptions, events: TransportEvents): Promise<LiveHost> {
		return new Promise((resolve, reject) => {
			const server = net.createServer();
			const onError = (err: NodeJS.ErrnoException) => {
				reject(new Error(err.code === "EADDRINUSE" ? t("netPortInUse", { port: opts.port }) : err.message));
			};
			server.once("error", onError);
			// Bind on all interfaces so LAN, Radmin VPN, Hamachi etc. all reach us.
			server.listen(opts.port, "0.0.0.0", () => {
				server.off("error", onError);
				server.on("error", (err) => console.error("[excalidraw-live] server error", err));
				resolve(new LiveHost(server, opts, events));
			});
		});
	}

	send(msg: Message): void {
		const out = { ...msg, from: HOST_ID } as Message;
		for (const c of this.clients) if (c.peer) c.ls.send(out, out.t === "pointer");
	}

	close(): void {
		this.server.close();
		for (const c of [...this.clients]) c.ls.finish({ t: "reject", reason: "rejectEnded" });
		this.clients.clear();
	}

	private accept(sock: net.Socket): void {
		const client: HostClient = { ls: null as unknown as PeerSocket, peer: null, stage: "hello", hostNonce: "" };
		client.ls = new PeerSocket(
			sock,
			(msg) => this.onClientMessage(client, msg),
			(reason) => this.onClientClosed(client, reason),
		);
		this.clients.add(client);
		window.setTimeout(() => {
			if (!client.peer) client.ls.close("netNoHello");
		}, HANDSHAKE_TIMEOUT);
	}

	private onClientMessage(client: HostClient, msg: Message): void {
		if (!client.peer) return this.handshake(client, msg);
		const from = client.peer.id;
		if (msg.t === "sync-request") {
			const snap = this.opts.getSnapshot();
			if (snap.files.length) client.ls.send({ t: "files", from: HOST_ID, files: snap.files });
			client.ls.send({ t: "elements", from: HOST_ID, elements: snap.elements });
			return;
		}
		if (!RELAYED.has(msg.t)) return;
		const out = { ...msg, from } as Message;
		for (const other of this.clients) {
			if (other !== client && other.peer) other.ls.send(out, out.t === "pointer");
		}
		this.events.onMessage(out);
	}

	private handshake(client: HostClient, msg: Message): void {
		const reject = (reason: string) => client.ls.finish({ t: "reject", reason });
		const key = this.opts.key;

		if (client.stage === "hello" && msg.t === "hello") {
			if (msg.proto !== PROTOCOL_VERSION) return reject("rejectVersion");
			if (!key) {
				client.ls.send({ t: "open" });
				client.ls.upgrade(null);
				client.stage = "join";
				return;
			}
			client.hostNonce = makeNonce();
			client.stage = "auth";
			client.ls.send({ t: "challenge", salt: key.salt, nonce: client.hostNonce });
			return;
		}

		if (client.stage === "auth" && msg.t === "auth" && key && typeof msg.nonce === "string") {
			if (!proofMatches(makeProof(key, "client", client.hostNonce, msg.nonce), msg.proof)) {
				return reject("rejectPassword");
			}
			client.ls.send({ t: "auth-ok", proof: makeProof(key, "host", client.hostNonce, msg.nonce) });
			client.ls.upgrade(sessionCiphers(key, client.hostNonce, msg.nonce, "host"));
			client.stage = "join";
			return;
		}

		if (client.stage === "join" && msg.t === "join") {
			const peer: PeerInfo = {
				id: randomBytes(6).toString("hex"),
				name: String(msg.name || t("guestName")).slice(0, 40),
				color: String(msg.color || "#888888"),
			};
			const others = [...this.clients].filter((c) => c.peer).map((c) => c.peer as PeerInfo);
			const snap = this.opts.getSnapshot();
			client.peer = peer;
			client.ls.send({ t: "welcome", id: peer.id, peers: [this.opts.self, ...others], ...snap });
			for (const c of this.clients) if (c !== client && c.peer) c.ls.send({ t: "peer-join", peer });
			this.events.onPeerJoin(peer);
			return;
		}

		client.ls.close("netProtocol");
	}

	private onClientClosed(client: HostClient, _reason: string): void {
		this.clients.delete(client);
		if (!client.peer) return;
		for (const c of this.clients) if (c.peer) c.ls.send({ t: "peer-leave", id: client.peer.id });
		this.events.onPeerLeave(client.peer.id);
	}
}

export type Welcome = Extract<Message, { t: "welcome" }>;

export interface ClientAuth {
	/** Typed by the user; empty when none was entered. */
	password: string;
	/** Key remembered from an earlier successful join to this host. */
	saved: PasswordKey | null;
}

export interface Connected {
	client: LiveClient;
	welcome: Welcome;
	/** The key that got us in, worth remembering for next time; null when the host has no password. */
	key: PasswordKey | null;
}

/** A peer connected to a host. */
export class LiveClient implements Transport {
	private constructor(
		private ls: PeerSocket,
		readonly selfId: string,
	) {}

	get encrypted(): boolean {
		return this.ls.encrypted;
	}

	static connect(
		address: { host: string; port: number },
		self: { name: string; color: string },
		auth: ClientAuth,
		events: TransportEvents,
	): Promise<Connected> {
		return new Promise((resolve, reject) => {
			let client: LiveClient | null = null;
			let stage: HandshakeStage = "hello";
			let key: PasswordKey | null = null;
			let hostNonce = "";
			let clientNonce = "";
			const sock = net.connect({ host: address.host, port: address.port });
			const timer = window.setTimeout(() => ls.close("netHostTimeout"), HANDSHAKE_TIMEOUT);

			const join = () => {
				stage = "join";
				ls.send({ t: "join", ...self });
			};
			const answer = async (challenge: Extract<Message, { t: "challenge" }>) => {
				try {
					if (auth.password) key = await derivePasswordKey(auth.password, challenge.salt);
					else if (auth.saved?.salt === challenge.salt) key = auth.saved;
					else return ls.close(auth.saved ? "netPasswordChanged" : "netPasswordRequired");
					hostNonce = challenge.nonce;
					clientNonce = makeNonce();
					ls.send({ t: "auth", nonce: clientNonce, proof: makeProof(key, "client", hostNonce, clientNonce) });
				} catch (e) {
					ls.close(e instanceof Error ? e.message : String(e));
				}
			};

			const ls = new PeerSocket(
				sock,
				(msg) => {
					if (client) return dispatch(msg);
					if (msg.t === "reject") {
						ls.close(msg.reason);
					} else if (stage === "hello" && msg.t === "open") {
						// Refuse rather than silently fall back to plaintext when we expected a password.
						if (auth.password) return ls.close("netNoHostPassword");
						ls.upgrade(null);
						join();
					} else if (stage === "hello" && msg.t === "challenge" && typeof msg.salt === "string") {
						stage = "auth";
						void answer(msg);
					} else if (stage === "auth" && msg.t === "auth-ok" && key) {
						if (!proofMatches(makeProof(key, "host", hostNonce, clientNonce), msg.proof)) {
							return ls.close("netHostUnverified");
						}
						ls.upgrade(sessionCiphers(key, hostNonce, clientNonce, "client"));
						join();
					} else if (stage === "join" && msg.t === "welcome") {
						window.clearTimeout(timer);
						client = new LiveClient(ls, msg.id);
						resolve({ client, welcome: msg, key });
					} else {
						ls.close("netProtocol");
					}
				},
				(reason) => {
					window.clearTimeout(timer);
					if (client) events.onClosed(reason);
					else reject(new Error(reason));
				},
			);
			const dispatch = (msg: Message) => {
				if (msg.t === "reject") ls.close(msg.reason);
				else if (msg.t === "peer-join") events.onPeerJoin(msg.peer);
				else if (msg.t === "peer-leave") events.onPeerLeave(msg.id);
				else events.onMessage(msg);
			};
			sock.once("connect", () => ls.send({ t: "hello", proto: PROTOCOL_VERSION }));
		});
	}

	send(msg: Message): void {
		this.ls.send(msg, msg.t === "pointer");
	}

	close(): void {
		this.ls.close("netDisconnected");
	}
}

/** Parses "host", "host:port" or "[v6]:port". */
export function parseAddress(input: string, defaultPort: number): { host: string; port: number } | null {
	const s = input.trim();
	if (!s) return null;
	let host = s;
	let port = defaultPort;
	const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
	if (v6) {
		host = v6[1];
		if (v6[2]) port = Number(v6[2]);
	} else if ((s.match(/:/g) ?? []).length === 1) {
		const [h, p] = s.split(":");
		host = h;
		port = Number(p);
	}
	if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { host, port };
}

export interface LocalAddress {
	address: string;
	label: string;
}

/** IPv4 addresses of this machine, labelled with a guess at which network they belong to. */
export function localAddresses(): LocalAddress[] {
	const out: LocalAddress[] = [];
	for (const [name, infos] of Object.entries(os.networkInterfaces())) {
		for (const info of infos ?? []) {
			if (info.family !== "IPv4" || info.internal) continue;
			out.push({ address: info.address, label: describeInterface(name, info.address) });
		}
	}
	return out;
}

function describeInterface(name: string, ip: string): string {
	const n = name.toLowerCase();
	if (n.includes("radmin") || ip.startsWith("26.")) return `Radmin VPN (${name})`;
	if (n.includes("hamachi") || ip.startsWith("25.")) return `Hamachi (${name})`;
	if (n.includes("zerotier")) return `ZeroTier (${name})`;
	if (n.includes("tailscale") || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return `Tailscale (${name})`;
	if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(ip)) return t("lanLabel", { name });
	return name;
}
