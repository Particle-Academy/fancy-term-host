# AGENTS.md — fancy-term-host

The headless Node terminal backend for `fancy-term`: it owns the PTYs and the
T1/T2/T3 persistence engine. `CLAUDE.md` symlinks here. This file describes
**this package's code**; process rules live in the envelope's `RULES.md`.

## Where things live

- `src/manager.ts` — the in-process backend: spawns ptys, forwards output,
  keeps each pty's scrollback.
- `src/host-client.ts` / `src/pty-host.ts` / `src/host-protocol.ts` — the
  detached pty-host (T3): the client in the app, the host process, and the
  messages between them. The client keeps its own copy of the host's scrollback.
- `src/scrollback.ts` — `Scrollback`, a capped chunk list. **All three
  scrollback copies use it** (manager, host-client, pty-host).
- `src/fancy-pty.ts` / `src/backend.ts` — the pty engine. Both backends use the one
  adapter in `src/fancy-pty.ts`. `src/manager.ts` loads fancy-pty lazily and takes an
  injected `ptySpawn`. `src/pty-host.ts` imports it statically and has no other engine.
- `src/electron/after-pack.ts` — checks the helper for the target is on disk. It never
  moves it: fancy-pty's helper resolves in place. It still applies the node-pty fixes
  if a consumer ships their own.
- `src/types.ts` — `CreateTerminalOpts` and friends; `src/ports.ts` — the four
  injected ports.

## Invariants

- **No per-chunk copy of the scrollback.** Until 0.11.0 every chunk rebuilt a
  1,000,000-char string (`buf + data`, then `slice`), in three places. Moving
  100 MiB through one pty took 13-52 s of CPU; now it takes about 80 ms. Append
  to a `Scrollback`; join only when something reads it (`toString()`, cached
  until the next write).
- **The kept content is exactly the last `scrollbackMax` UTF-16 code units.**
  `src/__tests__/scrollback-contract.test.ts` pins it, including that a cut can
  split a surrogate pair or an escape sequence (as before 0.11.0). Change that
  deliberately, with a changelog entry, or not at all.
- **`scrollbackMax` is per pty and fixed at spawn.** It defaults to 1,000,000,
  and `0` keeps nothing. It travels to the host as an optional protocol field, so
  an older host ignores it.
- **An exit is always delivered.** In `InProcessBackend`'s `onExit`, the
  bookkeeping and the `exit` emit sit in a `finally` behind the synchronous
  `cwd` flush. The adapter's final decoder flush in `src/fancy-pty.ts` sits the
  same way in front of the exit listeners. A listener that throws there must
  not cost the exit: fancy-pty swallows a throwing exit listener into a process
  warning, so a lost exit is otherwise silent (0.11.1,
  `src/__tests__/exit-delivery.test.ts`).
- **An exit from a pty that is no longer the registered one is ignored**, so a
  killed-and-replaced id is not clobbered. A killed pty that was not replaced
  still emits `exit`.
- **`windowsVerbatimArguments` fails loudly at any layer that cannot honour it.**
  Those layers would otherwise quote the line and say nothing, which is the bug
  the option fixes. An injected engine declares `honoursWindowsVerbatimArguments`,
  and a host advertises it in `hello-ok`'s `capabilities`. Do not move it into
  "an older host ignores it" like `scrollbackMax`, and do not bump
  `PROTOCOL_VERSION` for it: a mismatched host is reaped, with its terminals.
  A new pass-through option has to be added in four places on the host path:
  `CreateTerminalOpts`, the `create` message, both inline option types in
  `pty-host.ts`, and the `spawnPty` call there. On the in-process path the option list in `manager.ts` and the one
  in `fancy-pty.ts` are allow-lists, so a field missing from either vanishes.
- **A failed create on the host always ends.** The client's `create()` returns before
  the host answers, so a failure comes back as `create-failed`: as the reply when the
  engine threw, and pushed with no `seq` when the helper reported it after `open()`
  returned (`pty.childPid` still undefined). The client then has to leave no mirror
  entry and fire `exit`. A host that never answers gets the same at the request timeout,
  because a host older than 0.13.0 does exactly that. `error` is not used for this: it
  means the connection is gone, and it makes lifecycle abandon the host.
- **`PROTOCOL_VERSION` stays 2 across the engine move, and a running host is not
  replaced.** A bump would reap running hosts and their terminals on upgrade. An old
  host keeps node-pty until it is ended; the `fancy-pty` capability is how a client
  tells (`hostEngine()`).
- **`pid` from the host is fancy-pty's helper, not the shell**, as on the in-process
  backend since 0.10.0. Killing it takes the whole tree. An old host still reports the
  shell's.
- **Frames on one connection run one at a time.** `create` is async, and a frame run
  beside it finds no pty yet, so a write or kill in the same read is lost.

## Checking a change

`npm test` (vitest), `npm run lint` (tsc), `npm run build` (tsup).
`src/__tests__/host-live.test.ts` runs the built host in its own process with a real
engine. Its first half runs everywhere. Its program-lookup half, like
`src/__tests__/verbatim-live.test.ts`, is Windows only, so CI (ubuntu-latest) skips it:
run them on Windows when touching those paths.

**Any test that starts a real host needs a private pipe** (`fixtures/private-pipe.cjs`,
or patch `os.hostname` first as `verbatim-host.test.ts` does): the default Windows pipe
is machine-wide and belongs to whatever real host an app there is running. **The host
tests here are hidden, not detached.** Do not run a truly detached host on a desktop to
check something; see `docs/packaging.md`. The lookup half removes
`NoDefaultCurrentDirectoryInExePath` and checks it did: agent shells set it, and with it
set a lookup bug can pass. The scrollback benchmark is `node --expose-gc bench/scrollback.mjs <distDir> --mb
100 --chunk 4096`, also run in `.github/workflows/bench.yml`. Only compare
numbers from the same run: the same build varied 8.5-13 s across CI runners.

Lost-exit stress with REAL ptys: `node bench/exit-stress.mjs [--from <dir>]
--n 120 --runs 5 [--mode argv|typed|typednow] [--shell <exe>]`. It exits 1 on
any lost exit, any pty still listed afterwards, or any process warning.
