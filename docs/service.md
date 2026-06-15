# Per-user OS service (`@particle-academy/fancy-term-host/service`)

Run the pty-host as a **per-user OS service on its own standalone Node runtime**,
so an Electron auto-update never pins the consumer's binary and live terminals
survive both quits *and* updates.

This is a **subpath** — server/web consumers that just use the in-process or
detached backends never pull it in. Import it only in the desktop/Electron host.

## The problem it solves

The detached host (T3) is spawned with `process.execPath` + `ELECTRON_RUN_AS_NODE`
so `node-pty`'s native binding matches the Electron ABI. But the running host
then **holds the app's executable open**. On an auto-update (NSIS / Squirrel), the
installer must overwrite that binary — the surviving host pins it, so the update
can't proceed, and killing the host to let it through loses the live sessions.

A service on its **own** runtime is never the app binary, so it's never pinned.

## API

```ts
import {
  ensureHostService,
  installHostService,
  uninstallHostService,
  startHostService,
  stopHostService,
  isServiceInstalled,
  serviceStatus,
  resolveServiceRuntime,
  buildServiceDescriptor,
  isServiceSupported,
  SERVICE_REVISION,
} from "@particle-academy/fancy-term-host/service";
```

### `ensureHostService(config): Promise<EnsureResult>`

The one call most consumers need. It:

1. Resolves a standalone runtime (or returns `{ ok: false }` — never throws).
2. Reads the installed unit's revision.
3. **already running, same revision** → no-op · **installed, stopped** → start ·
   **stale revision** → uninstall + reinstall + start · **absent** → install + start.

```ts
const r = await ensureHostService({
  label: "academy.particle.genie.ptyhost",
  userDataDir: app.getPath("userData"),
  runtime: { nodePath: "/opt/genie/runtime/node", nodePtyDir: "/opt/genie/native" },
});
if (!r.ok) {
  // fall back — the service couldn't be set up (perms / unsupported / no runtime)
  // → use HostSpawner.spawnDetached (survives a normal quit) → in-process.
}
```

`EnsureResult` = `{ ok, installed, running, action, runtime?, error? }`, where
`action` is one of `already-running | started | installed-and-started |
reinstalled | failed | unsupported`.

### Config

```ts
interface HostServiceConfig {
  label: string;            // reverse-DNS-ish, stable per app+user
  userDataDir: string;      // host pidfile / socket / snapshots live here
  hostScript?: string;      // default: ptyHostScriptPath()
  runtime?: ServiceRuntime; // default: resolveServiceRuntime()
  env?: Record<string,string>;
  revision?: string;        // default: SERVICE_REVISION (encodes PROTOCOL_VERSION)
  logDir?: string;          // default: userDataDir
}
```

## The runtime / node-pty ABI question (the important part)

The service must **not** run on the consumer's Electron binary (that reintroduces
the pin). So `node-pty` must load against whatever runtime the service uses.
`resolveServiceRuntime()` picks one, in order:

1. an explicit `nodePath` you pass,
2. `$FANCY_TERM_NODE`,
3. `process.execPath` — only when the current process is **plain Node** (not
   Electron, binary named `node`),
4. a `node` / `node.exe` on `$PATH`.

It **refuses** an Electron binary outright, and returns `null` when nothing safe
is found (so the caller falls back).

You still have to make sure that runtime can load `node-pty`:

- **Ship a standalone Node** with the app and build/prebuild `node-pty` for its
  ABI (`node-gyp` / `prebuild-install`), then point `runtime.nodePath` at it and
  `runtime.nodePtyDir` at the directory holding the ABI-matched `.node` (it's
  added to the service's `NODE_PATH`), **or**
- rely on a system Node that already has a compatible `node-pty` resolvable from
  the host script's own `node_modules`.

> This is deliberately a consumer/CI decision, not something the package bundles:
> shipping prebuilt native binaries for every OS×arch belongs in your app's build
> pipeline. The service layer itself is pure JS.

## What each platform installs

| OS | Mechanism | Unit location | No elevation |
|---|---|---|---|
| macOS | `launchd` LaunchAgent | `~/Library/LaunchAgents/<label>.plist` | ✅ (per-user agent) |
| Linux | `systemd --user` unit | `~/.config/systemd/user/<label>.service` | ✅ (`--user`) |
| Windows | scheduled task (`ONLOGON`) + launcher `.cmd` | task `<label>`, cmd in `userDataDir` | ✅ (`/RL LIMITED`) |

`buildServiceDescriptor(config)` returns the exact unit contents + command argv
for inspection/testing without touching the OS.

## Versioning + handoff

The installed unit carries a revision marker; the default `SERVICE_REVISION`
encodes the host `PROTOCOL_VERSION`. When a consumer update bumps the protocol,
`ensureHostService` sees the mismatch and reinstalls — so you never keep an
incompatible host alive. A reinstall restarts the host, so **snapshot live
sessions (the T1 path) or call `shutdownHost()` first** if you need history to
survive the handoff.

## Graceful fallback

Nothing here is load-bearing for the app to function: `ensureHostService` never
throws. The recommended chain is **service → detached spawn → in-process**:

```ts
const svc = await ensureHostService(cfg);
if (svc.ok) {
  // connect via HostClient as usual
} else {
  // configureHostLifecycle({ spawner, … }); await initTerminalBackend();
  // (detached spawn survives a normal quit; in-process is the final floor)
}
```

## Testing

The lifecycle takes an injected `ServiceIo` (`run` / `writeFile` / `readFile` /
`mkdirp` / `rm` / `exists`), so you can unit-test install/ensure/status against a
fake filesystem + command runner without launchctl/systemctl/schtasks. See
`src/__tests__/service-*.test.ts`.

> **Cross-platform validation.** The descriptor generation + lifecycle logic are
> unit-tested on every platform. The *actual* `launchctl` / `systemctl --user` /
> `schtasks` install paths should still be smoke-tested on real macOS / Linux /
> Windows before you depend on them in production.
