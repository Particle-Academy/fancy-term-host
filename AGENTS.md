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
- `src/fancy-pty.ts` / `src/backend.ts` — the pty engine. The fancy-pty engine
  (0.10.0) covers the **in-process backend only**: `src/pty-host.ts` still
  imports `node-pty`.
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

## Known, not fixed

- **A late exit can clobber a reused id.** If a pty is killed and a new one is
  created with the same id, the old pty's exit handler deletes the new one's
  entries by id. Genie never reuses ids, so it is not urgent. The fix is to
  ignore an exit whose pty instance is no longer the registered one.

## Checking a change

`npm test` (vitest), `npm run lint` (tsc), `npm run build` (tsup). The
scrollback benchmark is `node --expose-gc bench/scrollback.mjs <distDir> --mb
100 --chunk 4096`, also run in `.github/workflows/bench.yml`. Only compare
numbers from the same run: the same build varied 8.5-13 s across CI runners.
