import { Menu, Notice, Plugin } from "obsidian";
import {
	createAndOpenDrawing,
	getActiveExcalidrawView,
	isExcalidrawPluginEnabled,
	isViewOpen,
	waitForViewReady,
} from "./excalidraw";
import { derivePasswordKey } from "./crypto";
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

		this.addRibbonIcon("radio-tower", "Excalidraw Live", (e) => this.showMenu(e));

		this.addCommand({ id: "host", name: "Начать live-сессию (стать хостом)", callback: () => this.startHost() });
		this.addCommand({ id: "join", name: "Подключиться к live-сессии", callback: () => this.openJoin() });
		this.addCommand({
			id: "show-addresses",
			name: "Показать адреса для подключения",
			checkCallback: (checking) => {
				if (this.session?.role !== "host") return false;
				if (!checking) this.showHostInfo();
				return true;
			},
		});
		this.addCommand({
			id: "resync",
			name: "Пересинхронизировать рисунок",
			checkCallback: (checking) => {
				if (!this.session) return false;
				if (!checking) this.session.resync();
				return true;
			},
		});
		this.addCommand({
			id: "stop",
			name: "Завершить live-сессию",
			checkCallback: (checking) => {
				if (!this.session) return false;
				if (!checking) this.session.end("остановлено вручную");
				return true;
			},
		});

		// End the session if its drawing gets closed or the tab switches to another file.
		const checkView = () => {
			const s = this.session;
			if (!s?.view) return;
			if (!isViewOpen(this.app, s.view)) s.end("вкладка с рисунком закрыта");
			else if (!s.isBoundTo(s.view)) s.end("во вкладке открыт другой рисунок");
		};
		this.registerEvent(this.app.workspace.on("layout-change", checkView));
		this.registerEvent(this.app.workspace.on("file-open", checkView));
	}

	onunload(): void {
		this.session?.end("плагин выгружен");
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data, { joinKeys: { ...data.joinKeys } });

		// Up to 0.1 passwords were stored as typed; keep only the host one, as its scrypt key.
		if ("password" in data || "joinPassword" in data) {
			const legacy = this.settings as LiveSettings & { password?: string; joinPassword?: string };
			if (legacy.password) legacy.hostKey = await derivePasswordKey(legacy.password);
			delete legacy.password;
			delete legacy.joinPassword;
			await this.saveSettings();
		}
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
			onPeerJoined: (p) => new Notice(`Excalidraw Live: ${p.name} подключился`),
			onPeerLeft: (p) => new Notice(`Excalidraw Live: ${p.name} отключился`),
			onEnded: (reason) => {
				if (this.session === getSession()) {
					this.session = null;
					new Notice(`Excalidraw Live: сессия завершена — ${reason}`);
				}
				this.refreshStatus();
			},
		};
	}

	private ensureIdle(): boolean {
		if (this.session) {
			new Notice("Сессия уже идёт — сначала заверши её");
			return false;
		}
		if (!isExcalidrawPluginEnabled(this.app)) {
			new Notice("Нужен включённый плагин Excalidraw");
			return false;
		}
		return true;
	}

	async startHost(): Promise<void> {
		if (!this.ensureIdle()) return;
		const view = getActiveExcalidrawView(this.app);
		if (!view) {
			new Notice("Открой рисунок Excalidraw, которым хочешь поделиться");
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
			new Notice(`Не удалось запустить сессию: ${errorText(e)}`);
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
			new Notice("Некорректный адрес. Формат: 26.15.3.7 или 26.15.3.7:47321");
			return;
		}

		let view = req.mode === "new" ? null : getActiveExcalidrawView(this.app);
		if (req.mode !== "new" && !view) {
			new Notice("Нет открытого рисунка Excalidraw");
			return;
		}

		let session: LiveSession | null = null;
		const s = (session = new LiveSession("client", this.callbacksFor(() => session)));
		const connecting = new Notice(`Подключаюсь к ${addr.host}:${addr.port}…`, 0);
		const savedKey = this.settings.joinKeys[addressKey(addr)] ?? null;
		let res: Connected;
		try {
			res = await LiveClient.connect(addr, this.self, { password: req.password, saved: savedKey }, s);
			s.transport = res.client;
		} catch (e) {
			connecting.hide();
			new Notice(`Не удалось подключиться: ${errorText(e)}`);
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
			const lock = res.client.encrypted ? ", зашифровано" : "";
			new Notice(`Подключено к «${welcome.drawing || this.hostLabel}» (${this.hostLabel}${lock})`);
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
			menu.addItem((i) => i.setTitle("Начать сессию (хост)").setIcon("radio-tower").onClick(() => this.startHost()));
			menu.addItem((i) => i.setTitle("Подключиться…").setIcon("plug").onClick(() => this.openJoin()));
		} else {
			const peers = [...s.peers.values()];
			menu.addItem((i) =>
				i
					.setTitle(peers.length ? `Участники: ${peers.map((p) => p.name).join(", ")}` : "Пока никого нет")
					.setIcon("users")
					.setDisabled(true),
			);
			menu.addSeparator();
			if (s.role === "host") {
				menu.addItem((i) => i.setTitle("Адреса для подключения").setIcon("copy").onClick(() => this.showHostInfo()));
			}
			menu.addItem((i) => i.setTitle("Пересинхронизировать").setIcon("refresh-cw").onClick(() => s.resync()));
			menu.addItem((i) =>
				i
					.setTitle(s.role === "host" ? "Завершить сессию" : "Отключиться")
					.setIcon("power")
					.onClick(() => s.end("остановлено вручную")),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private refreshStatus(): void {
		if (!this.statusEl) return;
		const s = this.session;
		this.statusEl.toggleClass("is-live", !!s);
		if (!s) {
			this.statusEl.setText("Live: выкл");
			this.statusEl.setAttr("aria-label", "Excalidraw Live — нажми, чтобы начать или подключиться");
		} else if (s.role === "host") {
			this.statusEl.setText(`● Live: хост · ${s.peers.size}`);
			this.statusEl.setAttr("aria-label", `Хост на порту ${this.settings.port}, участников: ${s.peers.size}`);
		} else {
			this.statusEl.setText(`● Live: ${this.hostLabel}`);
			this.statusEl.setAttr("aria-label", `Подключено к ${this.hostLabel}`);
		}
	}
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
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
