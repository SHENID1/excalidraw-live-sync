import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import * as os from "os";
import { derivePasswordKey, PasswordKey } from "./crypto";
import { t } from "./i18n";
import type ExcalidrawLivePlugin from "./main";
import type { JoinMode } from "./session";

export interface LiveSettings {
	name: string;
	color: string;
	port: number;
	/** Our host password, stored only as its scrypt key; null means no password. */
	hostKey: PasswordKey | null;
	folder: string;
	lastAddress: string;
	/** Keys that got us into other hosts, by "host:port", so the password needn't be retyped. */
	joinKeys: Record<string, PasswordKey>;
	joinMode: JoinMode;
}

const PALETTE = ["#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599", "#e8590c", "#c2255c"];

export const DEFAULT_SETTINGS: LiveSettings = {
	name: safeUsername(),
	color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
	port: 47321,
	hostKey: null,
	folder: "Excalidraw Live",
	lastAddress: "",
	joinKeys: {},
	joinMode: "new",
};

function safeUsername(): string {
	try {
		return os.userInfo().username || t("anonymous");
	} catch {
		return t("anonymous");
	}
}

export class LiveSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ExcalidrawLivePlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("setName"))
			.setDesc(t("setNameDesc"))
			.addText((text) =>
				text.setValue(s.name).onChange(async (v) => {
					s.name = v.trim() || DEFAULT_SETTINGS.name;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName(t("setColor")).addColorPicker((c) =>
			c.setValue(s.color).onChange(async (v) => {
				s.color = v;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName(t("setPort"))
			.setDesc(t("setPortDesc"))
			.addText((text) =>
				text.setValue(String(s.port)).onChange(async (v) => {
					const port = Number(v);
					if (Number.isInteger(port) && port > 0 && port < 65536) {
						s.port = port;
						await this.plugin.saveSettings();
					}
				}),
			);

		let newPassword = "";
		const setPassword = async () => {
			if (!newPassword) {
				new Notice(t("pwEnter"));
				return;
			}
			s.hostKey = await derivePasswordKey(newPassword);
			await this.plugin.saveSettings();
			new Notice(t("pwSet"));
			this.display();
		};
		new Setting(containerEl)
			.setName(t("setPassword"))
			.setDesc(s.hostKey ? t("setPasswordOn") : t("setPasswordOff"))
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder(s.hostKey ? t("pwNewPlaceholder") : t("pwPlaceholder")).onChange((v) => (newPassword = v));
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") void setPassword();
				});
			})
			.addButton((b) => b.setButtonText(t("pwSetButton")).onClick(() => void setPassword()))
			.addButton((b) =>
				b
					.setButtonText(t("pwRemoveButton"))
					.setDisabled(!s.hostKey)
					.onClick(async () => {
						s.hostKey = null;
						await this.plugin.saveSettings();
						new Notice(t("pwRemoved"));
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName(t("setFolder"))
			.setDesc(t("setFolderDesc"))
			.addText((text) =>
				text.setValue(s.folder).onChange(async (v) => {
					s.folder = v.trim();
					await this.plugin.saveSettings();
				}),
			);
	}
}
