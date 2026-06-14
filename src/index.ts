// Public surface for @particle-academy/fancy-term-host.
//
// The headless Node terminal backend that pairs with the browser-side
// @particle-academy/fancy-term <Terminal>: it owns the PTYs (via node-pty) and
// the T1/T2/T3 persistence engine — snapshot+replay, retained PTYs, and a
// detached pty-host — behind four injected ports. See docs/ports.md.

// ── The four injected ports (implement these in your host) ──────────────────
export type {
  SettingsProvider,
  Encryptor,
  SnapshotStoreConfig,
  HostSpawner,
} from "./ports";

// ── Backend abstraction + the in-process (Tier 1/2) implementation ──────────
export type { PtyBackend, HostStatus } from "./backend";
export type { CreateTerminalOpts, TerminalInfo, AttachResult } from "./types";
export {
  configureInProcessBackend,
  inProcessBackend,
  terminalManager,
  subscribeBackendEvents,
  setActiveBackend,
  defaultShell,
} from "./manager";
export type { BackendDeps, TerminalManager } from "./manager";

// ── Snapshot store (Tier 1: encrypted, gzipped session state to disk) ───────
export { createSnapshotStore } from "./sessions";
export type { SnapshotStore, SnapshotRead } from "./sessions";

// ── Detached host (Tier 3): client + lifecycle + script locator ─────────────
export { HostClient } from "./host-client";
export {
  configureHostLifecycle,
  initTerminalBackend,
  isHostBacked,
  getHostClient,
  disconnectHostLeaveRunning,
} from "./host-lifecycle";
export { ptyHostScriptPath } from "./host-script";

// ── Detached-host transport address + pidfile resolution ────────────────────
export {
  socketPathFor,
  pidfilePath,
  writePidfile,
  readPidfile,
  deletePidfile,
  isPidAlive,
  pidfileUsable,
  userHash,
  resolveHostScript,
} from "./host-locate";
export type { Pidfile } from "./host-locate";

// ── Host wire protocol (for advanced/custom transports) ─────────────────────
export { PROTOCOL_VERSION, encodeFrame, FrameDecoder } from "./host-protocol";
export type { ClientMessage, HostMessage, Frame } from "./host-protocol";

// ── Shell detection + the OSC-7 cwd prompt hooks ────────────────────────────
export {
  detectShells,
  defaultShellId,
  resolveDefaultShell,
  parseCommandLine,
  shellKind,
  cwdHookEnv,
  cwdHookSpawn,
} from "./shells";
export type { ShellInfo, ShellKind, CwdHook } from "./shells";

// ── OSC-7 cwd parsing (used by the manager; exported for reuse) ──────────────
export { parseFileUrl, scanOsc7Cwd } from "./osc7";

// ── Spawn-cwd normalization (MSYS→native + validate-or-home fallback) ────────
export { toNativeCwd, resolveSpawnCwd } from "./cwd";
