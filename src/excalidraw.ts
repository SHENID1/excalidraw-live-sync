import { App, normalizePath, TFile, View, WorkspaceLeaf } from "obsidian";
import { t } from "./i18n";
import type { BinaryFile, SceneElement } from "./protocol";

export const EXCALIDRAW_VIEW_TYPE = "excalidraw";
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

/** The parts of Excalidraw's appState we read. */
export interface AppStateLike {
	scrollX?: number;
	scrollY?: number;
	/** `{ value }` in current Excalidraw, a bare number in older builds. */
	zoom?: number | { value: number };
	selectedElementIds?: Record<string, boolean>;
	editingTextElement?: { id: string } | null;
	editingElement?: { id: string } | null;
	newElement?: { id: string } | null;
}

/** The subset of Excalidraw's imperative API we rely on. */
export interface ExcalidrawAPI {
	getSceneElementsIncludingDeleted(): readonly SceneElement[];
	getAppState(): AppStateLike | undefined;
	getFiles(): Record<string, BinaryFile>;
	addFiles(files: BinaryFile[]): void;
	updateScene(scene: {
		elements?: readonly SceneElement[];
		collaborators?: Map<string, unknown>;
		captureUpdate?: "IMMEDIATELY" | "NEVER" | "EVENTUALLY";
		commitToHistory?: boolean;
	}): void;
}

/**
 * The parts of the Excalidraw plugin's ExcalidrawView we touch. The view
 * forwards the React component's onChange / onPointerUpdate props to these
 * instance methods, which is what lets us hook them without patching the plugin.
 * They are typed as function properties because we swap them out per instance.
 */
export interface ExcalidrawViewLike extends View {
	file: TFile | null;
	excalidrawAPI: ExcalidrawAPI | null;
	isLoaded?: boolean;
	semaphores?: { justLoaded?: boolean };
	onChange: (elements: readonly SceneElement[], appState: AppStateLike, files: unknown) => void;
	onPointerUpdate: (payload: PointerPayload) => void;
}

export interface PointerPayload {
	pointer: { x: number; y: number; tool?: string };
	button: "up" | "down";
}

/** What ExcalidrawAutomate, the Excalidraw plugin's scripting API on `window`, offers that we use. */
interface ExcalidrawAutomateLike {
	getAPI?: () => ExcalidrawAutomateLike;
	reset?: () => void;
	create: (opts: { filename: string; foldername: string; silent: boolean }) => Promise<string>;
}

export function isExcalidrawPluginEnabled(app: App): boolean {
	// `app.plugins` is not part of the public API, but it is the only way to ask whether another plugin is on.
	const plugins = (app as App & { plugins?: { enabledPlugins?: Set<string> } }).plugins;
	return !!plugins?.enabledPlugins?.has(EXCALIDRAW_PLUGIN_ID);
}

export function isExcalidrawView(view: View | null | undefined): view is ExcalidrawViewLike {
	return !!view && view.getViewType() === EXCALIDRAW_VIEW_TYPE;
}

export function getActiveExcalidrawView(app: App): ExcalidrawViewLike | null {
	const recent = app.workspace.getMostRecentLeaf();
	if (isExcalidrawView(recent?.view)) return recent.view;
	const leaves = app.workspace.getLeavesOfType(EXCALIDRAW_VIEW_TYPE);
	return leaves.length === 1 && isExcalidrawView(leaves[0].view) ? leaves[0].view : null;
}

export function isViewOpen(app: App, view: View): boolean {
	return app.workspace.getLeavesOfType(EXCALIDRAW_VIEW_TYPE).some((leaf) => leaf.view === view);
}

/** Resolves once the view has mounted Excalidraw and finished loading its file. */
export async function waitForViewReady(view: ExcalidrawViewLike, timeoutMs = 15_000): Promise<ExcalidrawAPI> {
	const start = Date.now();
	for (;;) {
		const api = view.excalidrawAPI;
		if (api && view.isLoaded !== false && !view.semaphores?.justLoaded) return api;
		if (Date.now() - start > timeoutMs) throw new Error(t("excalidrawTimeout"));
		await sleep(100);
	}
}

/** Creates an empty drawing through ExcalidrawAutomate and opens it in a new tab. */
export async function createAndOpenDrawing(app: App, folder: string, name: string): Promise<ExcalidrawViewLike> {
	const automate = (window as Window & { ExcalidrawAutomate?: ExcalidrawAutomateLike }).ExcalidrawAutomate;
	if (!automate) throw new Error(t("noAutomate"));
	const ea = automate.getAPI ? automate.getAPI() : automate;
	ea.reset?.();
	const path = await ea.create({ filename: name, foldername: normalizePath(folder), silent: true });
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error(t("createFailed", { path }));

	const leaf: WorkspaceLeaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: EXCALIDRAW_VIEW_TYPE, state: { file: file.path }, active: true });
	if (!isExcalidrawView(leaf.view)) throw new Error(t("openFailed"));
	await waitForViewReady(leaf.view);
	// The plugin may still push the (empty) file contents into the scene right
	// after mount; give it a beat so it doesn't overwrite what we apply next.
	await sleep(300);
	return leaf.view;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}
