import { Menu, Notice, Plugin } from "obsidian";
import {
	createAndOpenDrawing,
	getActiveExcalidrawView,
	isExcalidrawPluginEnabled,
	isViewOpen,
	waitForViewReady,
} from "./excalidraw";
import { derivePasswordKey } from "./crypto";
import { reasonText, t } from "./i18n";
import { Connected, LiveClient, LiveHost, parseAddress } from "./net";
import { HOST_ID, PeerInfo } from "./protocol";
import { LiveSession, SessionCallbacks } from "./session";
import { DEFAULT_SETTINGS, LiveSettings, LiveSettingTab } from "./settings";
import { HostInfoModal, JoinModal, JoinRequest } from "./ui";

export default class ExcalidrawLivePlugin extends Plugin {
	settings: LiveSettings = DEFAULT_SETTINGS;
	private session: LiveSession | null = null;
	private hostLabel = "";
	private statusEl!: HTMLElement;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new LiveSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("excalidraw-live-status", "mod-clickable");
		this.statusEl.addEventListener("click", (e) => this.showMenu(e));
		this.refreshStatus();

		this.addRibbonIcon("radio-tower", t("ribbon"), (e) => this.showMenu(e));

		this.addCommand({ id: "host", name: t("cmdHost"), callback: () => this.startHost() });
		this.addCommand({ id: "join", name: t("cmdJoin"), callback: () => this.openJoin() });
		this.addCommand({
			id: "show-addresses",
			name: t("cmdShowAddresses"),
			checkCallback: (checking) => {
				if (this.session?.role !== "host") return false;
				if (!checking) this.showHostInfo();
				return true;
			},
		});
		this.addCommand({
			id: "resync",
			name: t("cmdResync"),
			checkCallback: (checking) => {
				if (!this.session) return false;
				if (!checking) this.session.resync();
				return true;
			},
		});
		this.addCommand({
			id: "stop",
			name: t("cmdStop"),
			checkCallback: (checking) => {
				if (!this.session) return false;
				if (!checking) this.session.end("endStopped");
				return true;
			},
		});

		// End the session if its drawing gets closed or the tab switches to another file.
		const checkView = () => {
			const s = this.session;
			if (!s?.view) return;
			if (!isViewOpen(this.app, s.view)) s.end("endTabClosed");
			else if (!s.isBoundTo(s.view)) s.end("endOtherDrawing");
		};
		this.registerEvent(this.app.workspace.on("layout-change", checkView));
		this.registerEvent(this.app.workspace.on("file-open", checkView));
	}

	onunload(): void {
		this.session?.end("endUnloaded");
	}

	async loadSettings(): Promise<void> {
		// Up to 0.1 passwords were stored as typed; keep only the host one, as its scrypt key.
		type Stored = Partial<LiveSettings> & { password?: string; joinPassword?: string };
		const { password, joinPassword, ...data } = ((await this.loadData()) ?? {}) as Stored;
		this.settings = { ...DEFAULT_SETTINGS, ...data, joinKeys: { ...data.joinKeys } };
		if (password) this.settings.hostKey = await derivePasswordKey(password);
		// Also pin the random default name and color, or every restart would roll new ones.
		if (password !== undefined || joinPassword !== undefined || !data.name || !data.color) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private get self(): Omit<PeerInfo, "id"> {
		return { name: this.settings.name, color: this.settings.color };
	}

	private callbacksFor(getSession: () => LiveSession | null): SessionCallbacks {
		return {
			onPeersChanged: () => this.refreshStatus(),
			onPeerJoined: (p) => new Notice(t("peerJoined", { name: p.name })),
			onPeerLeft: (p) => new Notice(t("peerLeft", { name: p.name })),
			onEnded: (reason) => {
				if (this.session === getSession()) {
					this.session = null;
					new Notice(t("sessionEnded", { reason: reasonText(reason) }));
				}
				this.refreshStatus();
			},
		};
	}

	private ensureIdle(): boolean {
		if (this.session) {
			new Notice(t("alreadyRunning"));
			return false;
		}
		if (!isExcalidrawPluginEnabled(this.app)) {
			new Notice(t("needExcalidraw"));
			return false;
		}
		return true;
	}

	async startHost(): Promise<void> {
		if (!this.ensureIdle()) return;
		const view = getActiveExcalidrawView(this.app);
		if (!view) {
			new Notice(t("openDrawingToShare"));
			return;
		}
		let session: LiveSession | null = null;
		try {
			await waitForViewReady(view);
			session = new LiveSession("host", this.callbacksFor(() => session));
			const s = session;
			const host = await LiveHost.start(
				{
					port: this.settings.port,
					key: this.settings.hostKey,
					self: { id: HOST_ID, ...this.self },
					getSnapshot: () => s.snapshot(),
				},
				s,
			);
			// Runs before any incoming connection is processed, so the first
			// snapshot always comes from an attached view.
			s.attach(view);
			s.markSceneKnown();
			s.transport = host;
			this.session = s;
			this.refreshStatus();
			this.showHostInfo();
		} catch (e) {
			new Notice(t("hostFailed", { error: errorText(e) }));
		}
	}

	private openJoin(): void {
		if (!this.ensureIdle()) return;
		const { name, lastAddress, joinMode } = this.settings;
		new JoinModal(
			this.app,
			{ name, address: lastAddress, password: "", mode: joinMode },
			!!getActiveExcalidrawView(this.app),
			(address) => {
				const addr = parseAddress(address, this.settings.port);
				return !!addr && !!this.settings.joinKeys[addressKey(addr)];
			},
			(req) => void this.join(req),
		).open();
	}

	async join(req: JoinRequest): Promise<void> {
		if (!this.ensureIdle()) return;
		this.settings.name = req.name.trim() || this.settings.name;
		this.settings.lastAddress = req.address.trim();
		this.settings.joinMode = req.mode;
		await this.saveSettings();

		const addr = parseAddress(req.address, this.settings.port);
		if (!addr) {
			new Notice(t("badAddress"));
			return;
		}

		let view = req.mode === "new" ? null : getActiveExcalidrawView(this.app);
		if (req.mode !== "new" && !view) {
			new Notice(t("noOpenDrawing"));
			return;
		}

		let session: LiveSession | null = null;
		const s = (session = new LiveSession("client", this.callbacksFor(() => session)));
		const connecting = new Notice(t("connecting", { address: addressKey(addr) }), 0);
		const savedKey = this.settings.joinKeys[addressKey(addr)] ?? null;
		let res: Connected;
		try {
			res = await LiveClient.connect(addr, this.self, { password: req.password, saved: savedKey }, s);
			s.transport = res.client;
		} catch (e) {
			connecting.hide();
			new Notice(t("joinFailed", { error: errorText(e) }));
			return;
		}
		connecting.hide();
		this.session = s;
		const { welcome } = res;
		if (res.key) this.settings.joinKeys[addressKey(addr)] = res.key;
		else delete this.settings.joinKeys[addressKey(addr)];
		void this.saveSettings();
		this.hostLabel = welcome.peers.find((p) => p.id === HOST_ID)?.name ?? `${addr.host}`;
		this.refreshStatus();

		try {
			if (!view) {
				const name = sanitizeFileName(`Live - ${welcome.drawing || this.hostLabel} ${timestamp()}`);
				view = await createAndOpenDrawing(this.app, this.settings.folder, name);
			} else {
				await waitForViewReady(view);
			}
			if (this.session !== s) return; // disconnected while the drawing was opening
			s.attach(view);
			s.applyWelcome(welcome, req.mode);
			const vars = { drawing: welcome.drawing || this.hostLabel, host: this.hostLabel };
			new Notice(t(res.client.encrypted ? "connectedEncrypted" : "connected", vars));
		} catch (e) {
			s.end(errorText(e));
		}
	}

	private showHostInfo(): void {
		new HostInfoModal(this.app, this.settings.port, !!this.settings.hostKey).open();
	}

	private showMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const s = this.session;
		if (!s) {
			menu.addItem((i) => i.setTitle(t("menuHost")).setIcon("radio-tower").onClick(() => this.startHost()));
			menu.addItem((i) => i.setTitle(t("menuJoin")).setIcon("plug").onClick(() => this.openJoin()));
		} else {
			const peers = [...s.peers.values()];
			menu.addItem((i) =>
				i
					.setTitle(peers.length ? t("menuPeers", { names: peers.map((p) => p.name).join(", ") }) : t("menuNoPeers"))
					.setIcon("users")
					.setDisabled(true),
			);
			menu.addSeparator();
			if (s.role === "host") {
				menu.addItem((i) => i.setTitle(t("menuAddresses")).setIcon("copy").onClick(() => this.showHostInfo()));
			}
			menu.addItem((i) => i.setTitle(t("menuResync")).setIcon("refresh-cw").onClick(() => s.resync()));
			menu.addItem((i) =>
				i
					.setTitle(s.role === "host" ? t("menuEnd") : t("menuLeave"))
					.setIcon("power")
					.onClick(() => s.end("endStopped")),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private refreshStatus(): void {
		if (!this.statusEl) return;
		const s = this.session;
		this.statusEl.toggleClass("is-live", !!s);
		if (!s) {
			this.statusEl.setText(t("statusOff"));
			this.statusEl.setAttr("aria-label", t("statusOffTip"));
		} else if (s.role === "host") {
			this.statusEl.setText(t("statusHost", { count: s.peers.size }));
			this.statusEl.setAttr("aria-label", t("statusHostTip", { port: this.settings.port, count: s.peers.size }));
		} else {
			this.statusEl.setText(t("statusClient", { host: this.hostLabel }));
			this.statusEl.setAttr("aria-label", t("statusClientTip", { host: this.hostLabel }));
		}
	}
}

function errorText(e: unknown): string {
	return reasonText(e instanceof Error ? e.message : String(e));
}

function addressKey(addr: { host: string; port: number }): string {
	return `${addr.host}:${addr.port}`;
}

function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim();
}

function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}
