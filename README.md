# Excalidraw Live Sync

[Русская версия](README.ru.md)

Live collaboration for the [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) plugin in Obsidian:
several people draw on the same board in real time and see each other's cursors and laser pointer.

There is no server: one participant **hosts**, the others connect to them directly over TCP.
Any network where participants can reach each other's IP works:

- a regular LAN or Wi‑Fi;
- Radmin VPN (`26.x.x.x` addresses), Hamachi (`25.x.x.x`), ZeroTier, Tailscale;
- any tunnel that forwards the host's TCP port.

Desktop only: mobile Obsidian has no Node.js networking API.

## Network use

This plugin talks to the network — that is its whole purpose. To be explicit:

- **When you host**, it opens a TCP server on the port from the settings (`47321` by default) on all network
  interfaces of your computer, so participants on your LAN or VPN can connect.
- **When you join**, it opens a TCP connection to the address you enter.
- Only the participants of a session exchange data: drawing elements, embedded images and cursor positions
  of the drawing that is being shared. No other vault content is sent.
- There are no third-party services, accounts, telemetry or analytics. Nothing leaves your machine
  unless you start or join a session.
- The host window lists your computer's network interfaces (`os.networkInterfaces()`) only to show which
  addresses participants can use; they are not sent anywhere. Its “Copy” button writes the chosen address
  to the clipboard; the plugin never reads the clipboard.
- Without a session password, traffic is not encrypted. Set a password when the network is shared with
  people you don't trust (for example, a public Hamachi network) — see below.

## Installation

Everyone in a session needs the plugin, and the versions must match. The Excalidraw plugin must be enabled.

**With BRAT** (updates arrive automatically)
1. *Settings → Community plugins → Browse* → install and enable **BRAT**.
2. *BRAT → Add Beta plugin* → enter `SHENID1/excalidraw-live-sync`.
3. Enable **Excalidraw Live Sync** in the list of community plugins.

**Manually**
Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/SHENID1/excalidraw-live-sync/releases/latest)
into `<vault>/.obsidian/plugins/excalidraw-live-sync/`, then enable the plugin.

**From source**

```bash
npm install
npm run build
npm run install-plugin -- "C:/path/to/vault"
```

## Usage

**Host**
1. Open an Excalidraw drawing.
2. Command palette → “Start live session (host)” (or the radio tower icon in the ribbon, or click `Live: off` in the status bar).
3. A window lists your addresses — send participants the one on a network you share with them (for example, Radmin VPN).
4. If Windows asks about the firewall, allow Obsidian on private networks.

**Participant**
1. “Join live session”, enter `IP` or `IP:port`, your name and the password (if the host set one).
2. Choose where to join:
   - *New drawing* — a file is created in the `Excalidraw Live` folder (configurable);
   - *Current drawing (replace its contents)* — the open drawing is replaced with the host's;
   - *Current drawing (merge with the host's)* — your elements are added to the host's board.

Everyone works on their own copy of the file in their own vault; Excalidraw autosaves the changes.
The session ends when you close the drawing tab or open another file in it.
After disconnecting, each participant keeps their copy as a regular local file.

The interface follows Obsidian's language: Russian when Obsidian is set to Russian, English otherwise.

## Settings

Cursor name and color, port (default `47321`), session password, folder for new drawings.
A fresh install starts with a random name like “Guest 4821” — change it in the settings or in the join dialog.

## Password and encryption

When the host sets a password:

- the settings store a key derived from it (`scrypt` with a random salt), not the password itself;
- the password never goes over the network: the host sends the salt and a one-time nonce,
  the participant answers with an HMAC of it, and the host proves the password back the same way;
  a captured answer is useless for the next connection;
- after that, all traffic (drawing, images, cursors) is encrypted with AES-256-GCM using fresh keys per connection;
- participants remember the key for the host's address, so the password is typed once;
- if a participant entered a password but the host doesn't ask for one, the connection is refused
  rather than silently falling back to plaintext.

Without a password anyone on the network can join, and traffic is not encrypted.

## How it works

- `src/net.ts` — TCP server and client: a JSON-lines handshake, then length-prefixed frames
  (encrypted when a password is set) with keepalive. The host relays clients' messages to everyone else.
- `src/crypto.ts` — the password key, password proofs and frame encryption.
- `src/session.ts` — binds to the open `ExcalidrawView`: wraps its `onChange` / `onPointerUpdate`,
  sends changed elements and merges incoming ones by Excalidraw's own rule
  (higher `version` wins, ties go to the lower `versionNonce`), so all scenes converge.
  Remote changes don't enter the undo history.
- Images (`files`) are sent whole; cursors are shown through Excalidraw's `collaborators`.

## Releasing

Bump `version` in `manifest.json` and `package.json`, commit, and push a tag with the same number:

```bash
git tag 0.3.2
git push origin 0.3.2
```

A GitHub Action builds the plugin, attests the build provenance and publishes a release with `main.js`, `manifest.json` and `styles.css`.

## Limitations

- Without a password, traffic is not encrypted.
- Plugin versions 0.1 and 0.2+ can't connect to each other — update everyone.
- If the host disconnects, the session ends for everyone; reconnecting is manual.
- Embedded links to vault files (`[[...]]`, embeddables) open for other participants only if they have those files too.

## License

[MIT](LICENSE)
