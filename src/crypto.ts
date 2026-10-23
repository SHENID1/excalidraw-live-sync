import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "crypto";

/**
 * A session password stretched with scrypt (both fields base64). It is all a
 * peer ever stores: it proves knowledge of the password and seeds the traffic
 * keys, but the password itself can't be read back from it.
 */
export interface PasswordKey {
	salt: string;
	key: string;
}

/** ~100 ms and 32 MiB per derivation: cheap once per connect, costly for guessing. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TAG_LENGTH = 16;

export function derivePasswordKey(password: string, salt = randomBytes(16).toString("base64")): Promise<PasswordKey> {
	return new Promise((resolve, reject) => {
		scrypt(password.normalize("NFC"), Buffer.from(salt, "base64"), 32, SCRYPT, (err, key) => {
			if (err) reject(err);
			else resolve({ salt, key: key.toString("base64") });
		});
	});
}

export function makeNonce(): string {
	return randomBytes(16).toString("base64");
}

/** HMAC over both handshake nonces; `role` keeps the host's answer from being replayed as the client's. */
export function makeProof(key: PasswordKey, role: "client" | "host", hostNonce: string, clientNonce: string): string {
	return createHmac("sha256", Buffer.from(key.key, "base64"))
		.update(`excalidraw-live|${role}|${hostNonce}|${clientNonce}`)
		.digest("base64");
}

export function proofMatches(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(expected, "base64");
	const b = Buffer.from(actual, "base64");
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * AES-256-GCM for one direction of a connection. The IV is a frame counter
 * both ends keep in step, so a dropped, replayed or reordered frame fails to
 * decrypt instead of slipping through.
 */
export class FrameCipher {
	private counter = 0;

	constructor(private key: Buffer) {}

	seal(plain: Buffer): Buffer {
		const c = createCipheriv("aes-256-gcm", this.key, this.nextIv());
		return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
	}

	open(sealed: Buffer): Buffer {
		if (sealed.length < TAG_LENGTH) throw new Error("frame too short");
		const d = createDecipheriv("aes-256-gcm", this.key, this.nextIv());
		d.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
		return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LENGTH)), d.final()]);
	}

	private nextIv(): Buffer {
		const iv = Buffer.alloc(12);
		iv.writeUInt32BE(Math.floor(this.counter / 2 ** 32), 4);
		iv.writeUInt32BE(this.counter >>> 0, 8);
		this.counter++;
		return iv;
	}
}

export interface CipherPair {
	send: FrameCipher;
	recv: FrameCipher;
}

/** Fresh per-connection keys, one per direction, so no IV is ever reused under the same key. */
export function sessionCiphers(key: PasswordKey, hostNonce: string, clientNonce: string, role: "client" | "host"): CipherPair {
	const ikm = Buffer.from(key.key, "base64");
	const salt = Buffer.concat([Buffer.from(hostNonce, "base64"), Buffer.from(clientNonce, "base64")]);
	const derive = (info: string) => Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
	const toHost = new FrameCipher(derive("excalidraw-live client->host"));
	const toClient = new FrameCipher(derive("excalidraw-live host->client"));
	return role === "host" ? { send: toClient, recv: toHost } : { send: toHost, recv: toClient };
}
