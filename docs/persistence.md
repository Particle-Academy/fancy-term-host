# Persistence model (T1 / T2 / T3) + OSC-7 cwd

A terminal is expensive context — scrollback, the running shell, the working
directory. `fancy-term-host` keeps that context alive across three escalating
tiers, all switchable behind one `PtyBackend` interface so the wire code never
changes.

## The one interface

Both implementations satisfy the same `PtyBackend`:

- **`InProcessBackend`** — PTYs live in *this* Node process. The T1/T2 floor.
- **`HostClient`** — PTYs live in a *detached* pty-host process (T3); every call
  is proxied over a local socket.

`create` / `write` / `resize` / `kill` / `list` / `isLive`, the Tier-2 retained
methods, and the `data` / `exit` / `cwd` events are identical on both. The active
backend is chosen once at startup and swapped behind the interface.

## T1 — snapshot & replay

On capture, a terminal's serialized state is (optionally) encrypted via your
[`Encryptor`](./ports.md#2-encryptor--at-rest-cipher-for-snapshots-t1), gzipped,
and written to `<baseDir>/sessions/<id>.snap` by the store from
`createSnapshotStore({ baseDir, encryptor })`. When encryption is unavailable
(`isAvailable() === false`) the bytes are stored as **plaintext gzip** with a
magic marker, so the same file path round-trips either way. A cold start reads
the snapshot back and replays it, so a reopened terminal shows where it was —
even after a full process exit.

## T2 — retained PTYs

Flag a terminal with `backend.setRetained(id, true)` and its PTY is **not killed
when the last window detaches** — the live shell keeps running and its scrollback
replays on reattach (`getScrollback(id)`), instead of degrading to a T1 replay of
stale state. `retainedCount()` / `retainedIds()` let a host cap how many live
shells it keeps. A real quit still tears these down (that's what T3 is for).

## T3 — detached host

The **pty-host** is a separate, headless Node process that owns the PTYs and
their scrollback ring buffers. Because it's a different process, the shells
**survive a full quit** of your app — reopening reattaches to them live.

- **Transport.** Windows: a named pipe `\\.\pipe\…-<userHash>` (per-logon-session
  ACL). POSIX: a unix socket under `userDataDir` (`ptyhost.sock`), per-user by
  directory perms. See `socketPathFor()`.
- **Discovery.** A pidfile (`ptyhost.json`: `{ pid, socketPath, protocolVersion,
  startedAt }`) lets a fresh client find a running host. `pidfileUsable()` checks
  the pid is alive *and* the protocol version matches; a stale/dead/mismatched
  pidfile means spawn a fresh host.
- **Lifecycle.** `configureHostLifecycle({ spawner, settings, snapshots,
  onHostStatus })` then `initTerminalBackend()` does connect-or-spawn-or-fall-
  back: connect to a usable host, else spawn one via your
  [`HostSpawner`](./ports.md#4-hostspawner--launch-the-detached-pty-host-t3), else
  fall back to the in-process backend. T3 is gated by the `detached_terminals`
  setting (default **off**).
- **Self-exit.** The host shuts itself down once it owns zero PTYs and has zero
  connected clients past an idle window, so it never lingers.
- **Graceful shutdown.** `disconnectHostLeaveRunning()` drops the client but
  leaves the host (and its PTYs) running for the next launch — the normal
  before-quit path. When you instead need the host **genuinely gone** — e.g.
  before an Electron auto-update whose installer must overwrite the binary the
  host runs on — call `shutdownHost()`. It asks the host to kill its PTYs, remove
  its pidfile/socket, and exit cleanly, then reverts the active backend to
  in-process. Snapshot first (the normal T1 path) if you want history to survive;
  this is a clean teardown, **not** a SIGKILL-by-pidfile, so the host runs its own
  cleanup. It never throws and no-ops when no host is active.

## T3+ — per-user OS service (`/service`)

The detached host above is launched with the consumer's binary (Electron-as-node,
for node-pty's ABI). That means the running host **pins the app executable**, so
an Electron auto-update can't overwrite it without first killing the host — and
killing it loses the live sessions T3 exists to protect.

`@particle-academy/fancy-term-host/service` fixes that by running the host as a
**per-user OS service on its own standalone Node runtime** — never the consumer's
binary, so an update never pins it. The wire protocol, pidfile, socket, and
`HostClient` are all unchanged; only *who launches the host* moves.

- **macOS** — a `launchd` LaunchAgent (`~/Library/LaunchAgents/<label>.plist`).
- **Linux** — a `systemd --user` unit (`~/.config/systemd/user/<label>.service`).
- **Windows** — a per-user **scheduled task** (`schtasks … /SC ONLOGON /RL LIMITED`,
  no elevation) driving a small launcher `.cmd`.

```ts
import { ensureHostService } from "@particle-academy/fancy-term-host/service";

const result = await ensureHostService({
  label: "academy.particle.genie.ptyhost",
  userDataDir: app.getPath("userData"),
  // A STANDALONE node — never your Electron binary. Auto-resolved from
  // $FANCY_TERM_NODE / PATH if omitted; pass one explicitly to be sure.
  runtime: { nodePath: "/opt/genie/runtime/node", nodePtyDir: "/opt/genie/native" },
});

if (result.ok) {
  // service is installed + running; connect with the usual HostClient path.
} else {
  // graceful fallback — never throws. Drop to the detached spawn (survives a
  // normal quit) or in-process. result.error says why.
}
```

`ensureHostService` install-if-missing-or-stale → start-if-stopped, and is
**revision-stamped** (the default revision encodes the host `PROTOCOL_VERSION`),
so a protocol bump reinstalls the unit instead of leaving an incompatible host
running. Also exported: `installHostService` / `uninstallHostService` /
`startHostService` / `stopHostService` / `isServiceInstalled` / `serviceStatus`,
plus `resolveServiceRuntime` and the pure `buildServiceDescriptor`. Full guide +
the node-pty ABI notes: [`docs/service.md`](./service.md).

> Upgrading the service across a host-protocol bump restarts the host — snapshot
> live sessions (the T1 path) or call `shutdownHost()` first if you need history
> to survive the handoff.

## OSC-7 cwd tracking (Tier 1.5)

So a resumed shell starts in the *right directory*, the host learns each
terminal's cwd from **OSC-7** escape sequences the shell emits on every prompt:

```
ESC ] 7 ; file://HOST/PATH  (BEL | ST)
```

`scanOsc7Cwd(chunk)` parses the last such report out of raw PTY output;
`InProcessBackend` watches its own data stream, debounces, and **emits a `cwd`
event** (rather than writing a DB) so your adapter can persist it. Windows drive
paths (`file:///C:/Users/...`) and percent-encoding are handled.

### Injecting the prompt hook

Shells don't emit OSC-7 unless told to. `cwdHookSpawn(command, settings)` returns
the env + launch-arg additions that make each shell report its cwd — **overlaying
your config, never replacing it** — gated by `track_cwd` (default on):

| Shell | Mechanism |
|---|---|
| **bash** | prepends an OSC-7 `printf` to `PROMPT_COMMAND` (env only) |
| **zsh** | generated `ZDOTDIR`; its `.zshrc` restores `ZDOTDIR`, sources your real `.zshrc`/`.zshenv`, then appends a `precmd` emitter |
| **fish** | generated `vendor_conf.d/osc7.fish` overlaid via `XDG_DATA_DIRS` (hooks `--on-event fish_prompt`) |
| **PowerShell** | dot-sourced profile shim wrapping your existing `prompt`, loaded via appended `-NoExit -Command ". '<shim>'"` |
| **cmd.exe** | `PROMPT` using the `$E` escape — **best-effort**, only where the console interprets VT sequences in the prompt; otherwise degrades to the static cwd |

The manager applies `cwdHookSpawn` automatically on `create()`. Generated shims
live under `os.tmpdir()/fancy-term-host/<userHash>/`. Any shell family that can't
be hooked returns an empty hook, and the terminal simply uses the static `cwd`
you passed to `create()`.
