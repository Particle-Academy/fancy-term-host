<p align="left"><img src="./art/fancy-ui.svg" alt="Fancy UI" height="28"></p>

# @particle-academy/fancy-term-host

**The headless Node terminal backend for [`@particle-academy/fancy-term`](https://www.npmjs.com/package/@particle-academy/fancy-term).**

`fancy-term` is the browser-side React `<Terminal>` — it renders xterm.js and
deliberately **never spawns a shell**. `fancy-term-host` is the other half: the
Node process that **owns the PTYs** (via `node-pty`) and a **T1/T2/T3 persistence
engine** — snapshot+replay, retained PTYs, and a detached pty-host — behind four
small **injected ports**. It runs anywhere Node runs (Electron main, a Laravel
queue worker, a plain server): OS-agnostic by construction, with **zero hard
third-party dependencies** (`node-pty` is a peer the consumer builds).

It can't live inside `fancy-term` or the other UI packages — `node-pty` is a
native addon that would break their browser builds — so it's an independent
sibling you install alongside.

## Install

```bash
npm install @particle-academy/fancy-term-host node-pty
```

`node-pty` is a **peer dependency**: you own its native build (and, under
Electron, the `asar-unpack` so its `.node` binary loads outside the archive).

## Wire it up

You provide four ports (see [`docs/ports.md`](./docs/ports.md)); the core does
the rest. The minimal in-process (Tier 1/2) setup:

```ts
import {
  configureInProcessBackend,
  inProcessBackend,
  createSnapshotStore,
  type SettingsProvider,
  type Encryptor,
} from "@particle-academy/fancy-term-host";

// 1. Settings (gates the cwd hook + T3). Defaults are sensible — track_cwd on.
const settings: SettingsProvider = { get: (k) => undefined };

// 2. A cipher for at-rest snapshots. A passthrough is fine to start with.
const encryptor: Encryptor = {
  isAvailable: () => false, // → snapshots stored as plaintext gzip
  encrypt: (b) => b,
  decrypt: (b) => b,
};

// 3. Snapshot store (T1) rooted under a writable dir (`<dir>/sessions/...`).
const snapshots = createSnapshotStore({ baseDir: "/var/app/userData", encryptor });

// 4. Configure + grab the backend.
configureInProcessBackend({ settings, snapshots });
const backend = inProcessBackend();

// Spawn a shell and stream it to a fancy-term <Terminal> on the client.
const { id, scrollback } = backend.create({ id: "t1", cols: 80, rows: 24 });
backend.on("data", (tid, data) => sendToClient(tid, data)); // → <Terminal output>
backend.on("exit", (tid) => closeOnClient(tid));

// Client keystrokes (fancy-term `onData`) come back here:
onClientData("t1", (d) => backend.write("t1", d));
onClientResize("t1", (cols, rows) => backend.resize("t1", cols, rows));
```

The backend's `create` / `write` / `resize` / `kill` / `list` and its
`data` / `exit` / `cwd` events are the whole surface the wire needs. Pair it
with `fancy-term`'s controlled `output` buffer and `onData` and you have a live
terminal that an agent can also inhabit (via the `registerTerminalBridge` in
`@particle-academy/agent-integrations`).

## Persistence tiers

Switchable behind one `PtyBackend` interface (see [`docs/persistence.md`](./docs/persistence.md)):

- **T1 — snapshot & replay.** Session state is serialized, (optionally)
  encrypted, gzipped, and written to `<baseDir>/sessions/<id>.snap`. A cold
  start replays it so a reopened terminal shows where it was.
- **T2 — retained PTYs.** A PTY flagged `setRetained(true)` survives a window
  detach (the live shell keeps running; scrollback replays on reattach) instead
  of being killed.
- **T3 — detached host.** PTYs live in a separate headless **pty-host** process
  that survives a full quit of the app. The backend proxies calls over a named
  pipe (Windows) / unix socket (POSIX); reopening reattaches to the still-running
  shells.

### Spawning the detached host (T3)

The bundled host script is resolvable without knowing the dist layout:

```ts
import { spawn } from "node:child_process";
import { ptyHostScriptPath } from "@particle-academy/fancy-term-host";

const child = spawn(process.execPath, [ptyHostScriptPath(), userDataDir], {
  detached: true,
  stdio: "ignore",
});
child.unref();
```

Wrap that in a `HostSpawner` and pass it to `configureHostLifecycle(...)` to let
the core connect-or-spawn-or-fall-back automatically. (`require.resolve(
"@particle-academy/fancy-term-host/pty-host")` also resolves the script.)

## cwd tracking (OSC-7)

The host learns each terminal's working directory from **OSC-7** escape
sequences the shell emits on every prompt, so a resumed shell can start where the
old one left off. `fancy-term-host` injects the prompt hook for you, gated by the
`track_cwd` setting (default **on**):

| Shell | Mechanism | Status |
|---|---|---|
| **bash** | prepends an OSC-7 `printf` to `PROMPT_COMMAND` (env) | ✅ |
| **zsh** | generated `ZDOTDIR` whose rc sources yours + adds a `precmd` | ✅ |
| **fish** | generated `vendor_conf.d` via `XDG_DATA_DIRS` (`--on-event fish_prompt`) | ✅ |
| **PowerShell** | dot-sourced profile shim wrapping your `prompt` (appended launch args) | ✅ |
| **cmd.exe** | `PROMPT` with the `$E` escape | ⚠️ best-effort (only where the console honors VT in the prompt) |

Every hook **overlays** your shell config — it never clobbers your prompt or rc.
Any shell that can't be hooked degrades silently to the static `cwd`.

## License

MIT

---

## ⭐ Star Fancy UI

If this package is useful to you, a quick ⭐ on the repo really helps us build a
better kit. Thank you!
