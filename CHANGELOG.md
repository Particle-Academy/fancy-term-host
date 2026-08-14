# Changelog

Notable changes to `@particle-academy/fancy-term-host`.

**BREAKING** marks anything that can stop working on upgrade. This package is
pre-1.0, so breaking changes land in MINOR releases — read those entries before
upgrading.

> Entries below **1.0** were reconstructed from git history when this file was
> introduced, so they summarise commit subjects rather than consumer impact.
> Everything from the next release onward is written by hand, in the same commit
> as the change.

---

## [Unreleased]

## [0.5.0] — 2026-08-14

### Fixed

- **Windows: a pty-host death left no trace at all** (#10). The `.cmd` launcher written by `windowsTask()` ran the host with no output redirection and no stdin detach, and consumers on machines where `schtasks /Create` is policy-denied launch it through a hidden `wscript`, which discards the inherited console. Since one host backs every terminal in a session, the symptom downstream was "all terminals froze, no sign of a crash" — with nothing to read afterwards.

  0.4.0 added `logDir` and wired stdio capture for launchd (`StandardOutPath`/`StandardErrorPath`) and systemd (journald); Windows was the one platform never updated, and the only one whose host death was undiagnosable. It now appends to `<logDir>\ptyhost.out.log` / `ptyhost.err.log` and redirects stdin from `nul`, which also hardens against the unexpected-EOF read that produces a silent `EPIPE` exit.

  **What you must do:** nothing in code. The launcher's contents changed, so the service revision differs and the descriptor will be rewritten on next install — expected, not an error.

- **A hung host is now detectable** (#11). The host's `uncaughtException` handler is deliberately non-fatal, so a wedged host keeps its socket **open**: no `'close'`, no `'error'`, and therefore no signal a consumer could bind to. A `ping`/`pong` pair had existed on both sides the whole time — the host answers `ping` — and the client never sent one.

  `HostClient` now heartbeats and treats a missed `pong` as host loss, emitting the existing `'error'` event, so the wedged case reaches the same fallback path a clean death already did.

- **In-flight requests are bounded and are failed on connection loss.** `request()` registered a resolver with no timeout and no rejector, so a pending entry could never be settled by anything but a reply — it leaked on a dead socket and its caller's reconciliation never ran. Requests now time out, and any still in flight are rejected when the socket closes or the client disconnects.

### Added

- **`HostClientOptions`** on `HostClient.connect(socketPath, snapshots, timeoutMs, options)` — `requestTimeoutMs` (default 10s) and `heartbeatIntervalMs` (default 5s; `0` disables the heartbeat). Both are optional and the existing three-argument call is unchanged.

### Notes

- Recovery is still the consumer's job: no descriptor auto-restarts the host (launchd `KeepAlive=false`, systemd `Restart=no`, Windows `ONLOGON` only), and a lost host reverts to the in-process backend without respawning or re-creating ids. This release makes the loss **detectable**, which is the prerequisite; the respawn/reattach stance is a separate decision.

## 0.4.0 — 2026-08-07

### Changed

- **BREAKING — Node 18 is no longer supported.** `engines.node` moves from `>=18` to `>=22`.

  **What you must do:** on Node 22 or newer, nothing. Note npm only *warns* on an `engines` mismatch while **pnpm fails the install**, so this surfaces differently depending on your package manager. Node 18 is end-of-life and 20 is maintenance-only.

### Why

These are the kit 0.5 platform floors, applied across every package at once so a consumer never has to resolve a mix. **No API changed, nothing was removed, nothing was renamed** — only what the package requires.


## 0.3.1 — 2026-07-15

### Fixed

- **electron:** afterPack picks conpty.dll by target arch (#9)

## 0.3.0 — 2026-07-15

### Added

- **electron:** ship an afterPack node-pty packaging fix (#7)

### Fixed

- **host:** reap a wedged/stale pty-host so a fresh one reclaims the pipe (#8)
- **shells:** real macOS login shell + full zsh startup chain (#5, #6)

## 0.2.3 — 2026-06-29

### Fixed

- **pty-host:** set useConptyDll on the DETACHED host spawn (closes #4)

## 0.2.2 — 2026-06-29

### Changed

- Set $TERM via node-pty `name` so the pty advertises Ms (OSC 52 clipboard)

## 0.2.1 — 2026-06-28

### Changed

- Use node-pty bundled ConPTY (useConptyDll) to stop stray console windows

## 0.2.0 — 2026-06-14

### Added

- run the pty-host as a per-user OS service (#2)

## 0.1.2 — 2026-06-14

### Added

- **host:** graceful shutdownHost() — clean detached-host teardown (#2)

## 0.1.1 — 2026-06-14

### Fixed

- native-convert + validate spawn cwd (Git Bash MSYS path → Windows 267)

## 0.1.0 — 2026-06-14

### Added

- initial release — headless Node terminal backend for fancy-term
