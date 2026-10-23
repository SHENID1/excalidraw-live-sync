import { App, PluginSettingTab, Setting } from "obsidian";
import * as os from "os";
import type ExcalidrawLivePlugin from "./main";
import type { JoinMode } from "./session";

export interface LiveSettings {
	name: string;
	color: string;
	port: number;
	password: string;
	folder: string;
	lastAddress: string;
	joinMode: JoinMode;
}

const PALETTE = ["#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599", "#e8590c", "#c2255c"];

export const DEFAULT_SETTINGS: LiveSettings = {
	name: safeUsername(),
	color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
	port: 47321,
	password: "",
	folder: "Excalidraw Live",
	lastAddress: "",
	joinMode: "new",
};

function safeUsername(): string {
	try {
		return os.userInfo().username || "Аноним";
	} catch {
		return "Аноним";
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
			.setName("Имя")
			.setDesc("Так тебя увидят другие участники рядом с курсором.")
			.addText((t) =>
				t.setValue(s.name).onChange(async (v) => {
					s.name = v.trim() || DEFAULT_SETTINGS.name;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Цвет курсора").addColorPicker((c) =>
			c.setValue(s.color).onChange(async (v) => {
				s.color = v;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName("Порт")
			.setDesc("TCP-порт, который открывает хост. У подключающихся должен совпадать (или указывай адрес:порт).")
			.addText((t) =>
				t.setValue(String(s.port)).onChange(async (v) => {
					const port = Number(v);
					if (Number.isInteger(port) && port > 0 && port < 65536) {
						s.port = port;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Пароль сессии")
			.setDesc("Необязательно. Хост пускает только тех, у кого пароль совпадает. Передаётся без шифрования.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.password).onChange(async (v) => {
					s.password = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Папка для новых рисунков")
			.setDesc("Куда сохранять рисунки, созданные при подключении к чужой сессии.")
			.addText((t) =>
				t.setValue(s.folder).onChange(async (v) => {
					s.folder = v.trim();
					await this.plugin.saveSettings();
				}),
			);
	}
}
