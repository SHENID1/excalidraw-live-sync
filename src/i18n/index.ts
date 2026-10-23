import { getLanguage } from "obsidian";
import { en, TextKey } from "./en";
import { ru } from "./ru";

export type { TextKey };

const strings: Record<TextKey, string> = getLanguage() === "ru" ? ru : en;

export function t(key: TextKey, vars: Record<string, string | number> = {}): string {
	return strings[key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Translates a reason that may be a text key from the other peer, or passes plain text (e.g. OS errors) through. */
export function reasonText(reason: string): string {
	return Object.prototype.hasOwnProperty.call(strings, reason) ? t(reason as TextKey) : reason;
}
