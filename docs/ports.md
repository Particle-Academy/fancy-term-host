# Implementing the four ports

`fancy-term-host`'s core is **runtime-agnostic**: it never imports `electron`, a
database, or any host framework. Everything host-specific is injected through
four small ports. You implement them once for your environment; the core does
snapshot/replay, retained PTYs, the detached host, and the OSC-7 cwd hook on top.

```ts
import type {
  SettingsProvider,
  Encryptor,
  SnapshotStoreConfig, // { baseDir, encryptor }
  HostSpawner,
} from "@particle-academy/fancy-term-host";
```

The reference implementation is Genie's Electron adapter (`genie-adapter.ts` +
`ipc.ts` in the [genie](https://github.com/Renaissance-Analytics/genie) repo) —
the *one* place that imports `electron` + the DB and builds these ports. The
annotated excerpts below are drawn from it; alongside each is the **plain-Node**
shape you'd write for a non-Electron host.

---

## 1. `SettingsProvider` — read-only config

Gates the OSC-7 cwd hook (`track_cwd`, default on) and T3 (`detached_terminals`,
default off), plus the default-shell resolution keys (`terminal_shell`,
`terminal_custom_cmd`).

```ts
export interface SettingsProvider {
  get(key: string): string | undefined;
}
```

**Genie (over its SQLite settings table):**

```ts
export function dbSettingsProvider(): SettingsProvider {
  return {
    get: (key) => {
      try {
        return (getAllSettings() as Record<string, string | undefined>)[key];
      } catch {
        return undefined;       // db not ready → best-effort defaults
      }
    },
  };
}
```

**Plain Node** — a literal, env, or JSON file is enough:

```ts
const settings: SettingsProvider = {
  get: (k) => ({ track_cwd: "on", detached_terminals: "off" })[k],
};
```

> A missing key returns `undefined`, and the core applies its own default — so a
> `{ get: () => undefined }` provider is a valid (all-defaults) starting point.

---

## 2. `Encryptor` — at-rest cipher for snapshots (T1)

Wraps whatever encryption your host has. `isAvailable()` decides whether
snapshots are encrypted or fall back to **plaintext gzip** (the store handles the
fallback for you, exactly as before).

```ts
export interface Encryptor {
  isAvailable(): boolean;
  encrypt(b: Buffer): Buffer;
  decrypt(b: Buffer): Buffer;
}
```

**Genie (over Electron `safeStorage`):**

```ts
export function electronEncryptor(): Encryptor {
  return {
    isAvailable: () => {
      try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
    },
    encrypt: (b) => safeStorage.encryptString(b.toString("utf8")),
    decrypt: (b) => Buffer.from(safeStorage.decryptString(b), "utf8"),
  };
}
```

**Plain Node** — a passthrough (plaintext) to start, or libsodium/`node:crypto`
for real at-rest encryption:

```ts
const passthrough: Encryptor = {
  isAvailable: () => false,   // → snapshots stored as plaintext gzip
  encrypt: (b) => b,
  decrypt: (b) => b,
};
```

You don't construct the store by hand — pass `{ baseDir, encryptor }` to
`createSnapshotStore(...)`. It appends `/sessions` under `baseDir` and writes
`<id>.snap`, matching the historical on-disk layout.

```ts
const snapshots = createSnapshotStore({ baseDir: userDataDir, encryptor });
```

---

## 3. `SnapshotStoreConfig` — where snapshots live

Just the two inputs the store needs (the cipher above + a base directory). The
store itself is the core's `createSnapshotStore`.

```ts
export interface SnapshotStoreConfig {
  baseDir: string;     // was app.getPath("userData")
  encryptor: Encryptor;
}
```

**Genie** builds it once and shares the instance between the core backends and
its quit-time snapshot flow:

```ts
snapshotStore = createSnapshotStore({
  baseDir: app.getPath("userData"),
  encryptor: electronEncryptor(),
});
```

**Plain Node** — any writable directory you control:

```ts
const snapshots = createSnapshotStore({ baseDir: "/var/app/state", encryptor });
```

---

## 4. `HostSpawner` — launch the detached pty-host (T3)

Only three OS-specific operations are injected; the *connect-or-spawn-or-fall-
back* logic is core.

```ts
export interface HostSpawner {
  resolveHostScript(): string | null;          // path to the pty-host script
  spawnDetached(scriptPath: string, env: Record<string, string>): void;
  userDataDir(): string;                        // pidfile/socket live here
}
```

**Genie (Electron — runs the host as plain Node via `ELECTRON_RUN_AS_NODE`):**

```ts
export function electronHostSpawner(dirname: string): HostSpawner {
  return {
    resolveHostScript: () => resolveHostScriptAt(dirname),
    userDataDir: () => app.getPath("userData"),
    spawnDetached: (scriptPath, env) => {
      const child = spawn(process.execPath, [scriptPath], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
      });
      child.unref();
    },
  };
}
```

**Plain Node** — use the package's own `ptyHostScriptPath()` to locate the
bundled host, and `process.execPath` (the node binary) to run it:

```ts
import { ptyHostScriptPath } from "@particle-academy/fancy-term-host";
import { spawn } from "node:child_process";

const hostSpawner: HostSpawner = {
  resolveHostScript: () => ptyHostScriptPath(),
  userDataDir: () => "/var/app/state",
  spawnDetached: (scriptPath, env) => {
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    child.unref();
  },
};
```

---

## Composition

Wire the ports once, before spawning any terminal:

```ts
import {
  configureInProcessBackend,
  inProcessBackend,
  configureHostLifecycle,
} from "@particle-academy/fancy-term-host";

// T1/T2: settings (cwd-hook gating) + snapshot store (cold-spawn restore).
configureInProcessBackend({ settings, snapshots });

// The core EMITS 'cwd' (from OSC-7) instead of writing a DB directly — subscribe
// and persist it yourself if you want live-cwd to survive a restart.
inProcessBackend().on("cwd", (id, cwd) => persistLiveCwd(id, cwd));

// T3 (optional): spawner + settings + snapshot store + a host-status sink.
configureHostLifecycle({
  spawner: hostSpawner,
  settings,
  snapshots,
  onHostStatus: (s) => notify(s.level, s.message),
});
```

Genie's `wireTerminalAdapter()` is exactly this, plus DB persistence of the
emitted `cwd` events and a `BrowserWindow` broadcast for host-status — a useful
template for any host that needs to durably mirror live state.
