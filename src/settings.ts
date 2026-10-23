import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import * as os from "os";
import { derivePasswordKey, PasswordKey } from "./crypto";
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

		let newPassword = "";
		const setPassword = async () => {
			if (!newPassword) {
				new Notice("Введи пароль");
				return;
			}
			s.hostKey = await derivePasswordKey(newPassword);
			await this.plugin.saveSettings();
			new Notice("Пароль сессии задан");
			this.display();
		};
		new Setting(containerEl)
			.setName("Пароль сессии (когда ты хост)")
			.setDesc(
				s.hostKey
					? "Задан. Хранится только хэш (scrypt), сам пароль не показать — можно задать новый или убрать. " +
							"Пароль по сети не передаётся, весь трафик шифруется."
					: "Не задан — подключиться может любой в сети, трафик не шифруется. " +
							"С паролем участники входят только по нему, а весь трафик шифруется.",
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder(s.hostKey ? "Новый пароль" : "Пароль").onChange((v) => (newPassword = v));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") void setPassword();
				});
			})
			.addButton((b) => b.setButtonText("Задать").onClick(() => void setPassword()))
			.addButton((b) =>
				b
					.setButtonText("Убрать")
					.setDisabled(!s.hostKey)
					.onClick(async () => {
						s.hostKey = null;
						await this.plugin.saveSettings();
						new Notice("Пароль сессии убран");
						this.display();
					}),
			);

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
