// Copies the built plugin into a vault: npm run install-plugin -- "C:/path/to/vault"
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2];
if (!vault || !existsSync(join(vault, ".obsidian"))) {
	console.error('Usage: npm run install-plugin -- "<path to vault>"  (folder that contains .obsidian)');
	process.exit(1);
}
const target = join(vault, ".obsidian", "plugins", "excalidraw-live-sync");
mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(target, f));
console.log(`Installed to ${target}. Reload Obsidian (or toggle the plugin) to pick it up.`);
