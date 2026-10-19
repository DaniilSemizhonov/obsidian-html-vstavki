import { App, Component, FileView, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, debounce, Notice } from "obsidian";
import { buildSrcdoc, isFrameMessage, StorageData, Theme } from "./frame";

const VIEW_TYPE = "html-vstavki-view";
const EXTENSIONS = ["html", "htm"];

interface Settings {
	theme: "obsidian" | "system";
	saveStorage: boolean;
}

interface Data {
	settings: Settings;
	// localStorage страниц, по пути файла.
	storage: Record<string, StorageData>;
}

const DEFAULT_SETTINGS: Settings = { theme: "obsidian", saveStorage: true };

// Внутренний API Obsidian для встраивания файлов через ![[...]].
interface EmbedContext {
	containerEl: HTMLElement;
	sourcePath?: string;
}
interface EmbedRegistry {
	registerExtension(ext: string, creator: (ctx: EmbedContext, file: TFile, subpath?: string) => Component): void;
	unregisterExtension(ext: string): void;
}

// Один iframe с HTML-файлом. Используется и во вставке, и во вкладке.
class HtmlFrame extends Component {
	iframe: HTMLIFrameElement | null = null;

	constructor(
		private plugin: HtmlVstavkiPlugin,
		private parentEl: HTMLElement,
		public file: TFile,
		private mode: "auto" | "fill",
		private fixedHeight: number | null = null,
	) {
		super();
	}

	onload() {
		const win = this.parentEl.win ?? window;
		this.registerDomEvent(win, "message", (e: MessageEvent) => {
			if (!this.iframe || e.source !== this.iframe.contentWindow || !isFrameMessage(e.data)) return;
			const m = e.data;
			if (m.type === "height" && this.mode === "auto" && this.fixedHeight == null) {
				this.iframe.style.height = `${Math.max(40, m.h)}px`;
			} else if (m.type === "storage") {
				this.plugin.setStorage(this.file.path, m.data);
			} else if (m.type === "open") {
				window.open(m.url);
			}
		});
		this.registerEvent(this.plugin.app.vault.on("modify", (f) => {
			if (f === this.file) void this.render();
		}));
		this.registerEvent(this.plugin.app.workspace.on("css-change", () => this.syncTheme()));
		void this.render();
	}

	onunload() {
		this.iframe?.remove();
		this.iframe = null;
	}

	async render() {
		const html = await this.plugin.app.vault.cachedRead(this.file);
		const theme = this.plugin.theme();
		const srcdoc = buildSrcdoc(html, { theme, storage: this.plugin.getStorage(this.file.path), mode: this.mode });

		this.iframe?.remove();
		const iframe = this.parentEl.createEl("iframe", { cls: "html-vstavki-frame" });
		// Без allow-same-origin страница не дотянется до Obsidian и файлов хранилища.
		iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads");
		iframe.setAttribute("title", this.file.basename);
		if (this.mode === "auto") iframe.style.height = `${this.fixedHeight ?? 150}px`;
		this.iframe = iframe;
		this.applyColorScheme(theme);
		iframe.srcdoc = srcdoc;
	}

	// prefers-color-scheme внутри iframe берётся из color-scheme самого элемента iframe.
	private applyColorScheme(theme: Theme) {
		if (this.iframe) this.iframe.style.colorScheme = theme ?? "normal";
	}

	syncTheme() {
		const theme = this.plugin.theme();
		this.applyColorScheme(theme);
		this.iframe?.contentWindow?.postMessage({ __htmlVstavki: 1, type: "theme", theme }, "*");
	}
}

class HtmlEmbed extends Component {
	constructor(private plugin: HtmlVstavkiPlugin, private ctx: EmbedContext, private file: TFile) {
		super();
	}

	// Obsidian вызывает loadFile, когда вставка появляется на экране.
	loadFile() {
		const el = this.ctx.containerEl;
		el.addClass("html-vstavki-embed");
		el.empty();

		const bar = el.createDiv({ cls: "html-vstavki-bar" });
		const open = bar.createEl("button", { text: "Открыть во вкладке", cls: "html-vstavki-open" });
		open.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.plugin.app.workspace.getLeaf("tab").openFile(this.file);
		});

		this.addChild(new HtmlFrame(this.plugin, el, this.file, "auto", parseHeight(el)));
	}
}

// ![[файл.html|600]] — фиксированная высота 600 px.
function parseHeight(el: HTMLElement): number | null {
	for (const attr of ["height", "width", "alt"]) {
		const v = el.getAttribute(attr);
		if (v && /^\d+$/.test(v.trim())) return Number(v);
	}
	return null;
}

class HtmlView extends FileView {
	private frame: HtmlFrame | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: HtmlVstavkiPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getIcon() {
		return "code-xml";
	}

	canAcceptExtension(ext: string) {
		return EXTENSIONS.includes(ext);
	}

	async onLoadFile(file: TFile) {
		this.contentEl.empty();
		this.contentEl.addClass("html-vstavki-view");
		this.frame = this.addChild(new HtmlFrame(this.plugin, this.contentEl, file, "fill"));
	}

	async onUnloadFile() {
		if (this.frame) this.removeChild(this.frame);
		this.frame = null;
		this.contentEl.empty();
	}
}

export default class HtmlVstavkiPlugin extends Plugin {
	data: Data = { settings: { ...DEFAULT_SETTINGS }, storage: {} };
	private saveSoon = debounce(() => void this.saveData(this.data), 1000, true);
	private registered: string[] = [];

	async onload() {
		const loaded = (await this.loadData()) as Partial<Data> | null;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...(loaded?.settings ?? {}) },
			storage: loaded?.storage ?? {},
		};

		this.registerView(VIEW_TYPE, (leaf) => new HtmlView(leaf, this));
		this.registerExtensions(EXTENSIONS, VIEW_TYPE);

		const registry = (this.app as App & { embedRegistry?: EmbedRegistry }).embedRegistry;
		if (registry) {
			for (const ext of EXTENSIONS) {
				try {
					registry.registerExtension(ext, (ctx, file) => new HtmlEmbed(this, ctx, file));
					this.registered.push(ext);
				} catch (e) {
					console.warn(`HTML-вставки: расширение .${ext} уже занято другим плагином`, e);
				}
			}
		} else {
			new Notice("HTML-вставки: эта версия Obsidian не поддерживает встраивание, файлы откроются только во вкладке.");
		}

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			const s = this.data.storage[oldPath];
			if (!s) return;
			delete this.data.storage[oldPath];
			this.data.storage[file.path] = s;
			this.saveSoon();
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (!this.data.storage[file.path]) return;
			delete this.data.storage[file.path];
			this.saveSoon();
		}));

		this.addSettingTab(new HtmlVstavkiSettingTab(this.app, this));
	}

	onunload() {
		const registry = (this.app as App & { embedRegistry?: EmbedRegistry }).embedRegistry;
		for (const ext of this.registered) registry?.unregisterExtension(ext);
		void this.saveData(this.data);
	}

	theme(): Theme {
		if (this.data.settings.theme === "system") return null;
		return document.body.hasClass("theme-dark") ? "dark" : "light";
	}

	getStorage(path: string): StorageData {
		return { ...(this.data.storage[path] ?? {}) };
	}

	setStorage(path: string, data: StorageData) {
		if (!this.data.settings.saveStorage) return;
		if (Object.keys(data).length) this.data.storage[path] = { ...data };
		else delete this.data.storage[path];
		this.saveSoon();
	}

	async saveSettings() {
		await this.saveData(this.data);
	}
}

class HtmlVstavkiSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: HtmlVstavkiPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.data.settings;

		new Setting(containerEl)
			.setName("Тема страниц")
			.setDesc("Светлая или тёмная тема внутри HTML-файлов. Изменения применятся к уже открытым страницам после переключения темы или перезагрузки заметки.")
			.addDropdown((d) => d
				.addOption("obsidian", "Как в Obsidian")
				.addOption("system", "Как в системе")
				.setValue(s.theme)
				.onChange(async (v) => {
					s.theme = v as Settings["theme"];
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Сохранять данные страниц")
			.setDesc("Страницы иногда запоминают прогресс (например, ошибки в тренажёре). Плагин хранит эти данные у себя и синхронизирует вместе с хранилищем.")
			.addToggle((t) => t.setValue(s.saveStorage).onChange(async (v) => {
				s.saveStorage = v;
				await this.plugin.saveSettings();
			}));

		const count = Object.keys(this.plugin.data.storage).length;
		new Setting(containerEl)
			.setName("Очистить сохранённые данные")
			.setDesc(count ? `Сейчас сохранены данные ${count} стр.` : "Сохранённых данных нет.")
			.addButton((b) => b.setButtonText("Очистить").setWarning().setDisabled(!count).onClick(async () => {
				this.plugin.data.storage = {};
				await this.plugin.saveSettings();
				new Notice("Данные страниц очищены. Открытые страницы сбросятся после перезагрузки.");
				this.display();
			}));
	}
}
