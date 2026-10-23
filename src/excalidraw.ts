import { App, TFile, View, WorkspaceLeaf } from "obsidian";
import type { BinaryFile, SceneElement } from "./protocol";

export const EXCALIDRAW_VIEW_TYPE = "excalidraw";
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The subset of Excalidraw's imperative API we rely on. */
export interface ExcalidrawAPI {
	getSceneElementsIncludingDeleted(): readonly SceneElement[];
	getAppState(): any;
	getFiles(): Record<string, BinaryFile>;
	addFiles(files: BinaryFile[]): void;
	updateScene(scene: {
		elements?: readonly SceneElement[];
		appState?: any;
		collaborators?: Map<string, any>;
		captureUpdate?: "IMMEDIATELY" | "NEVER" | "EVENTUALLY";
		commitToHistory?: boolean;
	}): void;
}

/**
 * The parts of the Excalidraw plugin's ExcalidrawView we touch. The view
 * forwards the React component's onChange / onPointerUpdate props to these
 * instance methods, which is what lets us hook them without patching the plugin.
 */
export interface ExcalidrawViewLike extends View {
	file: TFile | null;
	excalidrawAPI: ExcalidrawAPI | null;
	isLoaded?: boolean;
	semaphores?: { justLoaded?: boolean };
	onChange(elements: readonly SceneElement[], appState: any, files: any): void;
	onPointerUpdate(payload: { pointer: { x: number; y: number; tool?: string }; button: "up" | "down" }): void;
}

export function isExcalidrawPluginEnabled(app: App): boolean {
	return !!(app as any).plugins?.enabledPlugins?.has(EXCALIDRAW_PLUGIN_ID);
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
		if (Date.now() - start > timeoutMs) throw new Error("Excalidraw не загрузился вовремя");
		await sleep(100);
	}
}

/** Creates an empty drawing through ExcalidrawAutomate and opens it in a new tab. */
export async function createAndOpenDrawing(app: App, folder: string, name: string): Promise<ExcalidrawViewLike> {
	const automate = (window as any).ExcalidrawAutomate;
	if (!automate) throw new Error("ExcalidrawAutomate недоступен — включен ли плагин Excalidraw?");
	const ea = typeof automate.getAPI === "function" ? automate.getAPI() : automate;
	ea.reset?.();
	const path: string = await ea.create({ filename: name, foldername: folder, silent: true });
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error(`не удалось создать файл ${path}`);

	const leaf: WorkspaceLeaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: EXCALIDRAW_VIEW_TYPE, state: { file: file.path }, active: true });
	if (!isExcalidrawView(leaf.view)) throw new Error("не удалось открыть рисунок в режиме Excalidraw");
	await waitForViewReady(leaf.view);
	// The plugin may still push the (empty) file contents into the scene right
	// after mount; give it a beat so it doesn't overwrite what we apply next.
	await sleep(300);
	return leaf.view;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}
