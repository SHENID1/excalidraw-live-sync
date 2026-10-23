import * as net from "net";
import * as os from "os";
import { randomBytes } from "crypto";
import { BinaryFile, HOST_ID, Message, PeerInfo, PROTOCOL_VERSION, RELAYED, SceneElement } from "./protocol";

const MAX_BUFFER = 256 * 1024 * 1024; // a single line may carry embedded images
const PING_INTERVAL = 5_000;
const DEAD_AFTER = 25_000;
const HANDSHAKE_TIMEOUT = 10_000;
/** Pointer updates are dropped instead of queued once this much is waiting to be written. */
const VOLATILE_BACKLOG = 512 * 1024;

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

/** Newline-delimited JSON framing plus keepalive on top of a TCP socket. */
class LineSocket {
	private buf = "";
	private lastSeen = Date.now();
	private pingTimer: number;
	private closed = false;

	constructor(
		readonly sock: net.Socket,
		private onMessage: (msg: Message) => void,
		private onClose: (reason: string) => void,
	) {
		sock.setEncoding("utf8");
		sock.setNoDelay(true);
		sock.setKeepAlive(true, 10_000);
		sock.on("data", (chunk: string) => this.onData(chunk));
		sock.on("error", (err) => this.close(err.message));
		sock.on("close", () => this.close("соединение закрыто"));
		this.pingTimer = window.setInterval(() => {
			if (Date.now() - this.lastSeen > DEAD_AFTER) this.close("таймаут соединения");
			else this.send({ t: "ping" }, true);
		}, PING_INTERVAL);
	}

	get remote(): string {
		return `${this.sock.remoteAddress ?? "?"}:${this.sock.remotePort ?? "?"}`;
	}

	send(msg: Message, volatile = false): void {
		if (this.closed || !this.sock.writable) return;
		if (volatile && this.sock.writableLength > VOLATILE_BACKLOG) return;
		this.sock.write(JSON.stringify(msg) + "\n");
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
		window.clearInterval(this.pingTimer);
		this.sock.destroy();
		this.onClose(reason);
	}

	private onData(chunk: string): void {
		this.lastSeen = Date.now();
		this.buf += chunk;
		if (this.buf.length > MAX_BUFFER) {
			this.close("слишком большое сообщение");
			return;
		}
		let nl: number;
		while (!this.closed && (nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg: Message;
			try {
				msg = JSON.parse(line);
			} catch {
				console.warn("[excalidraw-live] malformed message from", this.remote);
				continue;
			}
			if (msg.t === "ping") this.send({ t: "pong" }, true);
			else if (msg.t !== "pong") this.onMessage(msg);
		}
	}
}

interface HostClient {
	ls: LineSocket;
	peer: PeerInfo | null;
}

export interface HostOptions {
	port: number;
	password: string;
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
				reject(new Error(err.code === "EADDRINUSE" ? `порт ${opts.port} уже занят` : err.message));
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

	get peerCount(): number {
		let n = 0;
		for (const c of this.clients) if (c.peer) n++;
		return n;
	}

	send(msg: Message): void {
		const out = { ...msg, from: HOST_ID } as Message;
		for (const c of this.clients) if (c.peer) c.ls.send(out, out.t === "pointer");
	}

	close(): void {
		this.server.close();
		for (const c of [...this.clients]) c.ls.finish({ t: "reject", reason: "хост завершил сессию" });
		this.clients.clear();
	}

	private accept(sock: net.Socket): void {
		const client: HostClient = { ls: null as unknown as LineSocket, peer: null };
		client.ls = new LineSocket(
			sock,
			(msg) => this.onClientMessage(client, msg),
			(reason) => this.onClientClosed(client, reason),
		);
		this.clients.add(client);
		window.setTimeout(() => {
			if (!client.peer) client.ls.close("нет приветствия");
		}, HANDSHAKE_TIMEOUT);
	}

	private onClientMessage(client: HostClient, msg: Message): void {
		if (!client.peer) {
			if (msg.t === "hello") this.handshake(client, msg);
			else client.ls.close("протокол нарушен");
			return;
		}
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

	private handshake(client: HostClient, hello: Extract<Message, { t: "hello" }>): void {
		const reject = (reason: string) => client.ls.finish({ t: "reject", reason });
		if (hello.proto !== PROTOCOL_VERSION) return reject("несовместимая версия плагина");
		if (this.opts.password && hello.password !== this.opts.password) return reject("неверный пароль");

		const peer: PeerInfo = {
			id: randomBytes(6).toString("hex"),
			name: String(hello.name || "Гость").slice(0, 40),
			color: String(hello.color || "#888888"),
		};
		const others = [...this.clients].filter((c) => c.peer).map((c) => c.peer as PeerInfo);
		const snap = this.opts.getSnapshot();
		client.peer = peer;
		client.ls.send({ t: "welcome", id: peer.id, peers: [this.opts.self, ...others], ...snap });
		for (const c of this.clients) if (c !== client && c.peer) c.ls.send({ t: "peer-join", peer });
		this.events.onPeerJoin(peer);
	}

	private onClientClosed(client: HostClient, _reason: string): void {
		this.clients.delete(client);
		if (!client.peer) return;
		for (const c of this.clients) if (c.peer) c.ls.send({ t: "peer-leave", id: client.peer.id });
		this.events.onPeerLeave(client.peer.id);
	}
}

export type Welcome = Extract<Message, { t: "welcome" }>;

/** A peer connected to a host. */
export class LiveClient implements Transport {
	private constructor(
		private ls: LineSocket,
		readonly selfId: string,
	) {}

	static connect(
		address: { host: string; port: number },
		hello: { name: string; color: string; password: string },
		events: TransportEvents,
	): Promise<{ client: LiveClient; welcome: Welcome }> {
		return new Promise((resolve, reject) => {
			let client: LiveClient | null = null;
			const sock = net.connect({ host: address.host, port: address.port });
			const timer = window.setTimeout(() => ls.close("хост не отвечает"), HANDSHAKE_TIMEOUT);
			const ls = new LineSocket(
				sock,
				(msg) => {
					if (client) return dispatch(msg);
					if (msg.t === "welcome") {
						window.clearTimeout(timer);
						client = new LiveClient(ls, msg.id);
						resolve({ client, welcome: msg });
					} else if (msg.t === "reject") {
						ls.close(msg.reason);
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
			sock.once("connect", () => ls.send({ t: "hello", proto: PROTOCOL_VERSION, ...hello }));
		});
	}

	send(msg: Message): void {
		this.ls.send(msg, msg.t === "pointer");
	}

	close(): void {
		this.ls.close("отключено");
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
	if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(ip)) return `Локальная сеть (${name})`;
	return name;
}
