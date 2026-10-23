import { App, Modal, Notice, Setting } from "obsidian";
import { localAddresses } from "./net";
import type { JoinMode } from "./session";

export class HostInfoModal extends Modal {
	constructor(
		app: App,
		private port: number,
		private hasPassword: boolean,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Сессия запущена");
		contentEl.addClass("excalidraw-live-modal");
		contentEl.createEl("p", {
			text: "Отправь участникам один из адресов — тот, что из общей с ними сети (Radmin VPN, Hamachi, локалка и т.д.).",
		});

		const addrs = localAddresses();
		if (!addrs.length) contentEl.createEl("p", { text: "Не найдено ни одного сетевого интерфейса IPv4." });
		for (const a of addrs) {
			const full = `${a.address}:${this.port}`;
			new Setting(contentEl)
				.setName(full)
				.setDesc(a.label)
				.addButton((b) =>
					b.setButtonText("Копировать").onClick(async () => {
						await navigator.clipboard.writeText(full);
						new Notice(`Скопировано: ${full}`);
					}),
				);
		}

		contentEl.createEl("p", {
			cls: "excalidraw-live-hint",
			text:
				"Если Windows спросит про брандмауэр — разреши Obsidian доступ к частным сетям. " +
				(this.hasPassword ? "Не забудь сообщить пароль." : "Пароль не задан — подключиться может любой в этой сети."),
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface JoinRequest {
	address: string;
	password: string;
	mode: JoinMode;
}

export class JoinModal extends Modal {
	private req: JoinRequest;

	constructor(
		app: App,
		initial: JoinRequest,
		private hasActiveDrawing: boolean,
		private onSubmit: (req: JoinRequest) => void,
	) {
		super(app);
		this.req = { ...initial };
		if (!hasActiveDrawing) this.req.mode = "new";
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Подключиться к live-сессии");
		contentEl.addClass("excalidraw-live-modal");

		new Setting(contentEl)
			.setName("Адрес хоста")
			.setDesc("IP или IP:порт, например 26.15.3.7:47321")
			.addText((t) => {
				t.setPlaceholder("26.15.3.7:47321").setValue(this.req.address);
				t.onChange((v) => (this.req.address = v));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") this.submit();
				});
				window.setTimeout(() => t.inputEl.focus(), 0);
			});

		new Setting(contentEl).setName("Пароль").addText((t) => {
			t.inputEl.type = "password";
			t.setValue(this.req.password).onChange((v) => (this.req.password = v));
		});

		new Setting(contentEl).setName("Куда").addDropdown((d) => {
			d.addOption("new", "Новый рисунок");
			if (this.hasActiveDrawing) {
				d.addOption("replace", "Текущий рисунок (заменить содержимое)");
				d.addOption("merge", "Текущий рисунок (объединить с хостом)");
			}
			d.setValue(this.req.mode).onChange((v) => (this.req.mode = v as JoinMode));
		});

		new Setting(contentEl).addButton((b) => b.setButtonText("Подключиться").setCta().onClick(() => this.submit()));
	}

	private submit(): void {
		if (!this.req.address.trim()) {
			new Notice("Укажи адрес хоста");
			return;
		}
		this.close();
		this.onSubmit(this.req);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
