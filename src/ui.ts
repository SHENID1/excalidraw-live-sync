import { App, Modal, Notice, Setting } from "obsidian";
import { localAddresses } from "./net";
import { t } from "./i18n";
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
		this.titleEl.setText(t("hostTitle"));
		contentEl.addClass("excalidraw-live-modal");
		contentEl.createEl("p", {
			text: t("hostIntro"),
		});

		const addrs = localAddresses();
		if (!addrs.length) contentEl.createEl("p", { text: t("hostNoInterfaces") });
		for (const a of addrs) {
			const full = `${a.address}:${this.port}`;
			new Setting(contentEl)
				.setName(full)
				.setDesc(a.label)
				.addButton((b) =>
					b.setButtonText(t("copy")).onClick(async () => {
						await navigator.clipboard.writeText(full);
						new Notice(t("copied", { text: full }));
					}),
				);
		}

		contentEl.createEl("p", {
			cls: "excalidraw-live-hint",
			text: `${t("hostFirewall")} ${this.hasPassword ? t("hostHintPassword") : t("hostHintOpen")}`,
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface JoinRequest {
	name: string;
	address: string;
	password: string;
	mode: JoinMode;
}

export class JoinModal extends Modal {
	private req: JoinRequest;
	private passwordSetting: Setting | null = null;

	constructor(
		app: App,
		initial: JoinRequest,
		private hasActiveDrawing: boolean,
		private hasSavedKey: (address: string) => boolean,
		private onSubmit: (req: JoinRequest) => void,
	) {
		super(app);
		this.req = { ...initial };
		if (!hasActiveDrawing) this.req.mode = "new";
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(t("joinTitle"));
		contentEl.addClass("excalidraw-live-modal");

		new Setting(contentEl)
			.setName(t("joinAddress"))
			.setDesc(t("joinAddressDesc"))
			.addText((text) => {
				text.setPlaceholder("26.15.3.7:47321").setValue(this.req.address);
				text.onChange((v) => {
					this.req.address = v;
					this.describePassword();
				});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") this.submit();
				});
				window.setTimeout(() => text.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.setName(t("joinName"))
			.setDesc(t("setNameDesc"))
			.addText((text) => text.setValue(this.req.name).onChange((v) => (this.req.name = v)));

		this.passwordSetting = new Setting(contentEl).setName(t("joinPassword")).addText((text) => {
			text.inputEl.type = "password";
			text.setValue(this.req.password).onChange((v) => (this.req.password = v));
		});
		this.describePassword();

		new Setting(contentEl).setName(t("joinTarget")).addDropdown((d) => {
			d.addOption("new", t("joinNew"));
			if (this.hasActiveDrawing) {
				d.addOption("replace", t("joinReplace"));
				d.addOption("merge", t("joinMerge"));
			}
			d.setValue(this.req.mode).onChange((v) => (this.req.mode = v as JoinMode));
		});

		new Setting(contentEl).addButton((b) => b.setButtonText(t("joinButton")).setCta().onClick(() => this.submit()));
	}

	private describePassword(): void {
		this.passwordSetting?.setDesc(
			this.hasSavedKey(this.req.address)
				? t("joinPasswordSaved")
				: t("joinPasswordHint"),
		);
	}

	private submit(): void {
		if (!this.req.address.trim()) {
			new Notice(t("joinNeedAddress"));
			return;
		}
		this.close();
		this.onSubmit(this.req);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
