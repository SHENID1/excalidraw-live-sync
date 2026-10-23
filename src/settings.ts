import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, TextComponent } from "obsidian";
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

/** Random per install (and saved on first load), so two fresh peers rarely look alike. */
export const DEFAULT_SETTINGS: LiveSettings = {
	name: `${t("guestName")} ${1000 + Math.floor(Math.random() * 9000)}`,
	color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
	port: 47321,
	hostKey: null,
	folder: "Excalidraw Live",
	lastAddress: "",
	joinKeys: {},
	joinMode: "new",
};

function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port < 65536;
}

/**
 * Obsidian 1.13+ builds this tab from `getSettingDefinitions()` (which also
 * makes the settings searchable); older versions call `display()`. Both share
 * the password row, the one setting that needs custom controls.
 */
export class LiveSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ExcalidrawLivePlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: t("setName"), desc: t("setNameDesc"), control: { type: "text", key: "name" } },
			{ name: t("setColor"), control: { type: "color", key: "color" } },
			{
				name: t("setPort"),
				desc: t("setPortDesc"),
				control: {
					type: "number",
					key: "port",
					min: 1,
					max: 65535,
					validate: (port) => (isValidPort(port) ? undefined : t("setPortInvalid")),
				},
			},
			{
				name: t("setPassword"),
				desc: this.passwordDesc(),
				render: (setting) => this.renderPassword(setting),
			},
			{ name: t("setFolder"), desc: t("setFolderDesc"), control: { type: "folder", key: "folder" } },
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === "name" && typeof value === "string") s.name = value.trim() || s.name;
		else if (key === "color" && typeof value === "string") s.color = value;
		else if (key === "port" && typeof value === "number" && isValidPort(value)) s.port = value;
		else if (key === "folder" && typeof value === "string") s.folder = value.trim();
		else return;
		await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("setName"))
			.setDesc(t("setNameDesc"))
			.addText((text) => text.setValue(s.name).onChange((v) => this.setControlValue("name", v)));

		new Setting(containerEl)
			.setName(t("setColor"))
			.addColorPicker((c) => c.setValue(s.color).onChange((v) => this.setControlValue("color", v)));

		new Setting(containerEl)
			.setName(t("setPort"))
			.setDesc(t("setPortDesc"))
			.addText((text) => text.setValue(String(s.port)).onChange((v) => this.setControlValue("port", Number(v))));

		this.renderPassword(new Setting(containerEl).setName(t("setPassword")));

		new Setting(containerEl)
			.setName(t("setFolder"))
			.setDesc(t("setFolderDesc"))
			.addText((text) => text.setValue(s.folder).onChange((v) => this.setControlValue("folder", v)));
	}

	private passwordDesc(): string {
		return this.plugin.settings.hostKey ? t("setPasswordOn") : t("setPasswordOff");
	}

	/** Text field plus Set / Remove buttons; refreshes its own row instead of the whole tab. */
	private renderPassword(setting: Setting): void {
		const s = this.plugin.settings;
		let input: TextComponent | null = null;
		let removeButton: { setDisabled(disabled: boolean): unknown } | null = null;
		const refresh = () => {
			setting.setDesc(this.passwordDesc());
			input?.setValue("").setPlaceholder(s.hostKey ? t("pwNewPlaceholder") : t("pwPlaceholder"));
			removeButton?.setDisabled(!s.hostKey);
		};
		const setPassword = async () => {
			const password = input?.getValue() ?? "";
			if (!password) {
				new Notice(t("pwEnter"));
				return;
			}
			s.hostKey = await derivePasswordKey(password);
			await this.plugin.saveSettings();
			new Notice(t("pwSet"));
			refresh();
		};

		setting
			.addText((text) => {
				input = text;
				text.inputEl.type = "password";
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") void setPassword();
				});
			})
			.addButton((b) => b.setButtonText(t("pwSetButton")).onClick(() => void setPassword()))
			.addButton((b) => {
				removeButton = b;
				b.setButtonText(t("pwRemoveButton")).onClick(async () => {
					s.hostKey = null;
					await this.plugin.saveSettings();
					new Notice(t("pwRemoved"));
					refresh();
				});
			});
		refresh();
	}
}
