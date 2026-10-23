import { ExcalidrawAPI, ExcalidrawViewLike } from "./excalidraw";
import type { Snapshot, Transport, TransportEvents, Welcome } from "./net";
import { BinaryFile, Message, PeerInfo, PointerState, SceneElement } from "./protocol";

const FLUSH_INTERVAL = 50;
const POINTER_INTERVAL = 40;

type PointerPayload = Parameters<ExcalidrawViewLike["onPointerUpdate"]>[0];

interface Viewport {
	scrollX: number;
	scrollY: number;
	zoom: number;
}

export type Role = "host" | "client";
export type JoinMode = "new" | "replace" | "merge";

export interface SessionCallbacks {
	onPeersChanged(): void;
	onPeerJoined(peer: PeerInfo): void;
	onPeerLeft(peer: PeerInfo): void;
	onEnded(reason: string): void;
}

/**
 * Binds one open Excalidraw view to a transport: pushes local element changes
 * out, merges remote ones in, and renders remote cursors.
 *
 * Merging follows Excalidraw's own collab rule: an element with a higher
 * `version` wins, ties go to the lower `versionNonce`. Every peer applies the
 * same rule, so all scenes converge without a central authority.
 */
export class LiveSession implements TransportEvents {
	readonly peers = new Map<string, PeerInfo>();
	transport: Transport | null = null;
	view: ExcalidrawViewLike | null = null;

	/** Last version of each element we sent or received — anything else is a local change. */
	private known = new Map<string, number>();
	private knownFiles = new Set<string>();
	private queue: Message[] = [];
	private collaborators = new Map<string, unknown>();
	private filePath: string | null = null;
	private unhook: (() => void) | null = null;
	private flushTimer: number | null = null;
	private pointerTimer: number | null = null;
	private lastPointerSent = 0;
	private pendingPointer: PointerPayload | null = null;
	/** Last local pointer and the viewport it was measured in, so panning/zooming can move it too. */
	private lastPointer: { payload: PointerPayload; viewport: Viewport } | null = null;
	private collabFrame: number | null = null;
	private ended = false;

	constructor(
		readonly role: Role,
		private cb: SessionCallbacks,
	) {}

	get api(): ExcalidrawAPI | null {
		return this.view?.excalidrawAPI ?? null;
	}

	get drawingName(): string {
		return this.view?.file?.basename ?? "";
	}

	/** Starts listening to the view. Hosts call this right away; clients once the welcome arrives. */
	attach(view: ExcalidrawViewLike): void {
		this.view = view;
		this.filePath = view.file?.path ?? null;

		const session = this;
		const hadOwn = {
			onChange: Object.prototype.hasOwnProperty.call(view, "onChange"),
			onPointerUpdate: Object.prototype.hasOwnProperty.call(view, "onPointerUpdate"),
		};
		const origChange = view.onChange;
		const origPointer = view.onPointerUpdate;
		view.onChange = function (...args) {
			origChange.apply(this, args);
			session.scheduleFlush();
			session.onLocalViewport(args[1]);
		};
		view.onPointerUpdate = function (payload) {
			origPointer.call(this, payload);
			session.onLocalPointer(payload);
		};
		this.unhook = () => {
			/* eslint-disable @typescript-eslint/no-explicit-any */
			if (hadOwn.onChange) view.onChange = origChange;
			else delete (view as any).onChange;
			if (hadOwn.onPointerUpdate) view.onPointerUpdate = origPointer;
			else delete (view as any).onPointerUpdate;
			/* eslint-enable @typescript-eslint/no-explicit-any */
		};
	}

	/** Host: everything already on the canvas reaches newcomers through the welcome snapshot. */
	markSceneKnown(): void {
		const api = this.requireApi();
		for (const el of api.getSceneElementsIncludingDeleted()) this.known.set(el.id, el.version);
		for (const id of Object.keys(api.getFiles())) this.knownFiles.add(id);
	}

	snapshot(): Snapshot {
		const api = this.requireApi();
		return {
			drawing: this.drawingName,
			elements: [...api.getSceneElementsIncludingDeleted()],
			files: Object.values(api.getFiles()).filter((f) => f?.dataURL),
		};
	}

	/** Client: adopt the host's scene, then replay whatever arrived while we were getting ready. */
	applyWelcome(welcome: Welcome, mode: JoinMode): void {
		const api = this.requireApi();
		for (const peer of welcome.peers) this.peers.set(peer.id, peer);
		this.addFiles(welcome.files);
		if (mode === "merge") {
			this.mergeRemote(welcome.elements);
		} else {
			for (const el of welcome.elements) this.known.set(el.id, el.version);
			api.updateScene({ elements: welcome.elements, captureUpdate: "NEVER", commitToHistory: false });
		}
		// In merge mode our own elements are still unknown to the host; this sends them.
		this.scheduleFlush();
		const queued = this.queue;
		this.queue = [];
		for (const msg of queued) this.onMessage(msg);
		this.cb.onPeersChanged();
	}

	resync(): void {
		if (!this.transport) return;
		if (this.role === "client") {
			this.transport.send({ t: "sync-request" });
		} else {
			const snap = this.snapshot();
			if (snap.files.length) this.transport.send({ t: "files", files: snap.files });
			this.transport.send({ t: "elements", elements: snap.elements });
		}
	}

	end(reason: string): void {
		if (this.ended) return;
		this.ended = true;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		if (this.pointerTimer !== null) window.clearTimeout(this.pointerTimer);
		if (this.collabFrame !== null) window.cancelAnimationFrame(this.collabFrame);
		this.unhook?.();
		this.unhook = null;
		const transport = this.transport;
		this.transport = null;
		transport?.close();
		this.collaborators.clear();
		try {
			this.api?.updateScene({ collaborators: new Map() });
		} catch {
			// the view may already be gone
		}
		this.cb.onEnded(reason);
	}

	/** True while the view we're bound to is still showing the same file. */
	isBoundTo(view: ExcalidrawViewLike): boolean {
		return this.view === view && view.file?.path === this.filePath;
	}

	// --- TransportEvents -------------------------------------------------------

	onMessage(msg: Message): void {
		if (this.ended) return;
		if (!this.view) {
			this.queue.push(msg);
			return;
		}
		switch (msg.t) {
			case "elements":
				this.mergeRemote(msg.elements);
				break;
			case "files":
				this.addFiles(msg.files);
				break;
			case "pointer":
				if (msg.from) this.updateCollaborator(msg.from, msg.pointer);
				break;
		}
	}

	onPeerJoin(peer: PeerInfo): void {
		this.peers.set(peer.id, peer);
		this.cb.onPeerJoined(peer);
		this.cb.onPeersChanged();
	}

	onPeerLeave(id: string): void {
		const peer = this.peers.get(id);
		this.peers.delete(id);
		if (this.collaborators.delete(id)) this.scheduleCollaborators();
		if (peer) this.cb.onPeerLeft(peer);
		this.cb.onPeersChanged();
	}

	onClosed(reason: string): void {
		this.end(reason);
	}

	// --- outgoing --------------------------------------------------------------

	private scheduleFlush(): void {
		if (this.ended || this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, FLUSH_INTERVAL);
	}

	private flush(): void {
		const api = this.api;
		if (!api || !this.transport || !this.view) return;
		if (this.view.file?.path !== this.filePath) {
			this.end("во вкладке открыт другой рисунок");
			return;
		}

		// Files first, so image elements arriving right after can render immediately.
		const files: BinaryFile[] = [];
		for (const [id, file] of Object.entries(api.getFiles())) {
			if (this.knownFiles.has(id) || !file?.dataURL) continue;
			this.knownFiles.add(id);
			files.push(file);
		}
		if (files.length) this.transport.send({ t: "files", files });

		const changed: SceneElement[] = [];
		for (const el of api.getSceneElementsIncludingDeleted()) {
			if (this.known.get(el.id) === el.version) continue;
			this.known.set(el.id, el.version);
			changed.push(el);
		}
		if (changed.length) this.transport.send({ t: "elements", elements: changed });
	}

	private onLocalPointer(payload: PointerPayload): void {
		if (!this.transport || !payload?.pointer) return;
		const viewport = viewportOf(this.api?.getAppState());
		this.lastPointer = viewport && { payload, viewport };
		this.queuePointer(payload);
	}

	/**
	 * Wheel/pinch zoom and trackpad panning move the canvas under a still mouse
	 * without any pointer event, so the cursor's scene position changes silently.
	 * Re-project the last pointer through the new viewport so peers see it move.
	 */
	private onLocalViewport(appState: unknown): void {
		const last = this.lastPointer;
		const viewport = viewportOf(appState);
		if (!this.transport || !last || !viewport) return;
		const prev = last.viewport;
		if (viewport.scrollX === prev.scrollX && viewport.scrollY === prev.scrollY && viewport.zoom === prev.zoom) return;
		const { x, y } = last.payload.pointer;
		const payload: PointerPayload = {
			...last.payload,
			pointer: {
				...last.payload.pointer,
				x: ((x + prev.scrollX) * prev.zoom) / viewport.zoom - viewport.scrollX,
				y: ((y + prev.scrollY) * prev.zoom) / viewport.zoom - viewport.scrollY,
			},
		};
		this.lastPointer = { payload, viewport };
		this.queuePointer(payload);
	}

	private queuePointer(payload: PointerPayload): void {
		this.pendingPointer = payload;
		if (this.pointerTimer !== null) return;
		const wait = Math.max(0, POINTER_INTERVAL - (Date.now() - this.lastPointerSent));
		this.pointerTimer = window.setTimeout(() => {
			this.pointerTimer = null;
			this.sendPointer();
		}, wait);
	}

	private sendPointer(): void {
		const p = this.pendingPointer;
		const api = this.api;
		if (!p || !api || !this.transport) return;
		this.pendingPointer = null;
		this.lastPointerSent = Date.now();
		const selected = api.getAppState()?.selectedElementIds ?? {};
		this.transport.send({
			t: "pointer",
			pointer: {
				x: p.pointer.x,
				y: p.pointer.y,
				tool: p.pointer.tool === "laser" ? "laser" : "pointer",
				button: p.button === "down" ? "down" : "up",
				selectedElementIds: Object.keys(selected).filter((id) => selected[id]),
			},
		});
	}

	// --- incoming --------------------------------------------------------------

	private mergeRemote(remote: SceneElement[]): void {
		const api = this.api;
		if (!api || !remote?.length) return;

		const appState = api.getAppState() ?? {};
		// Never yank an element out from under the local user mid-edit; their
		// next change will carry a higher version and win anyway.
		const busy = new Set<string>(
			[appState.editingTextElement?.id, appState.editingElement?.id, appState.newElement?.id].filter(Boolean),
		);

		const local = api.getSceneElementsIncludingDeleted();
		const byId = new Map(local.map((el) => [el.id, el]));
		const added: SceneElement[] = [];
		let changed = false;

		for (const r of remote) {
			if (!r?.id) continue;
			const l = byId.get(r.id);
			if (l && busy.has(r.id)) continue;
			if (l && !remoteWins(l, r)) continue;
			if (!l) added.push(r);
			byId.set(r.id, r);
			this.known.set(r.id, r.version);
			changed = true;
		}
		if (!changed) return;

		let next = [...local.map((el) => byId.get(el.id) as SceneElement), ...added];
		// Excalidraw ≥0.18 orders the scene by fractional `index`; keep that order consistent across peers.
		if (next.every((el) => typeof el.index === "string")) {
			next = next.sort((a, b) =>
				a.index === b.index ? (a.id < b.id ? -1 : 1) : (a.index as string) < (b.index as string) ? -1 : 1,
			);
		}
		api.updateScene({ elements: next, captureUpdate: "NEVER", commitToHistory: false });
	}

	private addFiles(files: BinaryFile[]): void {
		const api = this.api;
		const fresh = (files ?? []).filter((f) => f?.id && f.dataURL);
		if (!api || !fresh.length) return;
		for (const f of fresh) this.knownFiles.add(f.id);
		api.addFiles(fresh);
	}

	private updateCollaborator(id: string, pointer: PointerState): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		this.collaborators.set(id, {
			id,
			socketId: id,
			username: peer.name,
			color: { background: peer.color, stroke: peer.color },
			pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool },
			button: pointer.button,
			selectedElementIds: Object.fromEntries((pointer.selectedElementIds ?? []).map((e) => [e, true])),
		});
		this.scheduleCollaborators();
	}

	private scheduleCollaborators(): void {
		if (this.collabFrame !== null) return;
		this.collabFrame = window.requestAnimationFrame(() => {
			this.collabFrame = null;
			// Excalidraw only notices a new Map instance.
			this.api?.updateScene({ collaborators: new Map(this.collaborators) });
		});
	}

	private requireApi(): ExcalidrawAPI {
		const api = this.api;
		if (!api) throw new Error("Excalidraw API недоступен");
		return api;
	}
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function viewportOf(appState: any): Viewport | null {
	const zoom = typeof appState?.zoom === "number" ? appState.zoom : appState?.zoom?.value;
	const { scrollX, scrollY } = appState ?? {};
	if (![zoom, scrollX, scrollY].every((n) => typeof n === "number" && Number.isFinite(n)) || zoom <= 0) return null;
	return { scrollX, scrollY, zoom };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function remoteWins(local: SceneElement, remote: SceneElement): boolean {
	if (remote.version !== local.version) return remote.version > local.version;
	return remote.versionNonce < local.versionNonce;
}
