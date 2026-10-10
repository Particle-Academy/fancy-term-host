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

## [0.9.0] — 2026-10-10

### Fixed

- **`node-pty` is now an `optionalDependency` instead of a `peerDependency`, because
  electron-builder NEVER PACKED IT.** If you ship an Electron app built against
  0.7.0 or 0.8.0, **your installer almost certainly contains no node-pty at all**
  and the build told you everything was fine. Upgrade, rebuild, and check.

  `app-builder-lib` constructs the `node_modules` it packs from
  `{ ...dependencies, ...optionalDependencies }` and nothing else — see
  `out/node-module-collector/nodeModulesCollector.js:169` in 26.15.3:

  ```js
  isProdDependency(depName, pkg) {
      const prodDeps = { ...pkg.dependencies, ...pkg.optionalDependencies };
      return prodDeps[depName] != null;
  }
  ```

  **`peerDependencies` appears nowhere in that collector**, and `files` globs
  cannot add to `node_modules`. The peer shape had a real argument behind it (one
  native build per app, the consumer owning the Electron ABI rebuild) and it was
  simply unreachable in practice.

  Found by `claude · genie2` on the first real run of our own
  `fancyTermAfterPack` hook — on both platforms — after the manifest, the `files`
  globs and a green build had all agreed nothing was wrong. Three channels said
  fine; the one that looked at the packaged output said otherwise and was right.
  The citation was then verified against the published tarball rather than taken
  on faith.

  **What you must DO: almost certainly just remove `node-pty` from your own
  manifest** — npm now installs it as ours, and you can stop naming it. Keep your
  `asarUnpack` and your `fancyTermAfterPack` call exactly as they are. **If you
  ship only the pure-JS `./ipc` subpath**, `npm install --omit=optional` skips the
  native build; that subpath exists to be native-free (#12) and still is.

  **Why optional and not a plain `dependency`** (the owner's decision, 2026-10-10):
  optional deps *are* collected, so the installer gets node-pty, while an
  `./ipc`-only consumer keeps a way out of the native build. The accepted trade is
  that a failed native build surfaces when a PTY is first requested rather than at
  install time — tolerable precisely because a packaged app cannot get past
  `fancyTermAfterPack` with a missing build.

### Changed

- **BREAKING if you relied on the peer warning to tell you to install
  `node-pty`.** There is no peer entry any more, so npm will not warn about a
  missing or mismatched one — it just installs ours. Nothing to do unless you were
  deliberately pinning a different version, in which case declare it yourself and
  npm will dedupe.

- `src/__tests__/packaging.test.ts` pins the shape: node-pty must be an
  optionalDependency, must NOT be a peer, must appear in exactly ONE section, and
  its range must equal the `devDependencies` range we actually test against.
  Sabotage-verified — moving it back to `peerDependencies` fails 4, declaring it
  in both places fails 2, drifting the range off the tested one fails 1.

## [0.8.0] — 2026-10-10

### Added

- **The encryption posture of snapshots is now readable through the API** —
  `SnapshotStore.encrypting(): boolean` and `SnapshotRead.encrypted: boolean`.

  ```ts
  const snapshots = createSnapshotStore({ baseDir, encryptor });

  // Assert at startup. Fails loudly the day safeStorage stops being wired.
  if (!snapshots.encrypting()) throw new Error("terminal snapshots would be plaintext");

  // And how a file on disk was ACTUALLY stored:
  snapshots.readSnapshot(id)?.encrypted;
  ```

  **The two answer different questions and can disagree**, which is the point:
  a snapshot written before encryption was wired reads back
  `encrypted: false` in a process where `encrypting()` is `true`. You need both
  to tell "we are safe now" from "we still have plaintext on disk to clean up".

  **Why this exists.** A consumer shipped plaintext snapshots because its
  `Encryptor` reported unavailable — not for the reason the fallback exists (the
  OS genuinely cannot encrypt) but because the module was loading outside
  Electron for a live check. **A development condition wearing the fallback's
  clothes**, in a buffer where people type passwords and paste tokens. It was
  undetectable from outside: the only signal was a `console.warn` fired ONCE per
  process, and the only reliable check was reading this module's magic byte —
  coupling a consumer to our file format to answer a question about their own
  security posture. Reported by `claude · genie2`, who asked for exactly this
  rather than taking the coupling.

- `encrypting()` **never throws.** A throwing `Encryptor` reads as `false`,
  because an assertion that can crash at startup is worse than the thing it
  guards against.

### Changed

- **BREAKING for anyone who IMPLEMENTS `SnapshotStore` themselves** — the
  interface gained a required `encrypting()` method, so a hand-rolled store no
  longer satisfies the type. **If you use `createSnapshotStore` (the documented
  path) there is nothing to do**; the factory supplies it.

  To fix a custom store, return whether a write would encrypt — or `() => false`
  if it does not persist, which is what this package's own inert default store
  now says. Adding it caught five implementations in this repo, which is the
  measure of how breaking it actually is: real, and a one-line fix each.

  The deliberate non-change: **no fail-closed `requireEncryption` option.** The
  documented trade is that a non-functional resume is worse than a plaintext
  scrollback on disk, and reversing that in a package default would be wrong.
  These two accessors are what let a consumer impose a stricter policy on
  themselves without this package choosing it for everyone — which is where that
  decision belongs. `claude · genie2` independently reached the same conclusion.

### Fixed

- **`CHANGELOG.md` is now in the published tarball.** `files` did not whitelist it, so npm never shipped it — and this package puts breaking changes in MINOR releases and tells you in the README to read the entry before taking one. The instruction existed for the author, who has the file, and not for the consumer, who is the only one being instructed. Nothing for you to do; the file simply arrives from this release on.

### Security

- `source-map-js` is pinned forward to `^1.2.2` via `overrides`. Versions up to
  1.2.1 allow an event-loop denial of service through indexed source-map section
  offsets, and it arrives here transitively through the build toolchain.
  **Nothing for a consumer to do, and no runtime change**: an npm package does
  not ship a lockfile, so this governs builds OF this repo, not anything
  installed FROM it. Recorded rather than left silent because the override it
  sits beside — `shell-quote` `^1.9.0`, added for an earlier advisory — was
  carried with no note of why, and had drifted back inside the vulnerable range
  before anyone looked.

## [0.7.0] — 2026-10-07

### Fixed

- **A create for a pty id can no longer overlap a dispose of the same id** (#13).
  `kill` did this:

  ```ts
  e.pty.kill();        // native teardown STARTS
  ptys.delete(msg.id); // the id is free again IMMEDIATELY
  ```

  On Windows `kill()` signals the process and returns; closing the pseudoconsole
  and joining ConPTY's agent threads finish afterwards, and `onExit` is what says
  they did. Deleting the entry in the same tick therefore freed the id **while the
  old pseudoconsole was still being destroyed**, so a `create` arriving in that
  window spawned a SECOND native pseudoconsole against an id whose first one was
  mid-destruction.

  The host that died with `0xC0000005` — taking all 22 terminals on the machine
  with it — had been taking ~2,678 spawn requests across **three distinct ids**,
  one create about every 1.8 seconds for over an hour: exactly the cadence that
  lands creates inside teardown windows.

  **This is not a claim to have found that crash's cause.** The reporter retracted
  the reused-id theory after a second pty-host racing the first was fixed in the
  surrounding app, and that explains the fault at least as well. The rule stands on
  its own regardless: a create must not overlap a dispose of the same id, and a
  lost race deserves an error rather than a native fault that takes every terminal
  with it.

  The lifecycle moved into `PtyRegistry`, which holds an id's slot until `onExit`
  confirms teardown — bounded by a watchdog, because a dispose that never reports
  completion would otherwise strand the id forever. A terminal that fails to start
  is recoverable; a host that stops answering for one id is not. A disposing pty
  reads as absent from `get`/`list`/the idle count, so nothing writes to a pty
  whose handles are closing.

  **What a consumer must DO: nothing.** Attaching to a live terminal is unchanged
  (still returns the existing pty with its scrollback), and the only behaviour
  that moved is a create against an id that is *still being killed*, which
  previously produced undefined native behaviour.

### Added

- **The host asks for a diagnostic report if it dies of a fatal error** (#13).
  When it crashed, the only evidence was an exit code in another process's log —
  Windows Error Reporting produced nothing usable and there were no Crashpad
  reports, so a fault that killed every terminal on the machine was undiagnosable
  afterwards. `process.report.reportOnFatalError` is now on, with reports under
  `<userData>/pty-host/reports`.

  `reportOnFatalError` is the one knob that covers a NATIVE fault. A JS
  `try/catch` cannot: an access violation is not an exception, which is why
  wrapping the `spawn` call — the report's first suggestion — would not have
  contained this. Set at runtime rather than as an argv flag because the detached
  host is launched by the embedding app through the `spawnDetached` port, so this
  package does not control its own command line. Best-effort: a host that will not
  start because it could not arrange its own crash reporting is worse than one
  that starts without it.

## [0.6.0] — 2026-09-14

### Added

- **`@particle-academy/fancy-term-host/ipc`: the transport with no native module** (#12). The framing codec (`encodeFrame`, `FrameDecoder`, `MAX_FRAME`) and the per-user pipe/socket and pidfile helpers were always free of native code, but the only entry exporting them was the root, and its bundle opens with `import { spawn } from 'node-pty'`. A second per-user host that must ship without native dependencies had to load node-pty or copy the code. The new subpath loads neither node-pty nor electron, which a test checks on a fresh build of the package, and it is the same implementation the pty-host uses, not a copy.
- **The codec is generic.** `encodeFrame<T>(msg)` and `new FrameDecoder<T>().push(): T[]` carry a caller's own message union, with no cast through the pty-host's `Frame`. The root entry's `encodeFrame` and `FrameDecoder` keep their `Frame` typing.
- **Hosts can be named.** `socketPathFor`, `pidfilePath`, `writePidfile`, `readPidfile` and `deletePidfile` take an optional `name`, so a second host gets its own pipe (`genie-<name>-<userhash>`), socket (`<name>.sock`, with the same short-path fallback) and pidfile (`<name>.json`). An invalid name throws a `TypeError` rather than being cleaned up. `pidfileUsable(pf, protocolVersion)` checks a pidfile against the reader's own protocol version. `DEFAULT_HOST_NAME` (`'ptyhost'`) is exported.

  **What you must do:** nothing. Every new parameter is optional and defaults to the pty-host, whose pipe, socket, pidfile and wire format (`PROTOCOL_VERSION` 2) are unchanged.

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
