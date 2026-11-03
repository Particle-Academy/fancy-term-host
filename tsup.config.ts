import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries: the library barrel + the detached pty-host script (Tier 3),
  // which consumers resolve via `ptyHostScriptPath()` and spawn as a child.
  entry: {
    index: "src/index.ts",
    "pty-host": "src/pty-host.ts",
    // Per-user OS-service layer (launchd / systemd --user / Windows task). A
    // subpath so server/web consumers never pull in the desktop service code.
    service: "src/service/index.ts",
    // Electron-builder packaging helpers (the afterPack check). A subpath so
    // non-desktop consumers never pull in the packaging code.
    electron: "src/electron/index.ts",
    // The IPC transport with no native dependency (#12): the framing codec and
    // the per-user pipe/pidfile helpers, for a second host that starts nothing
    // native. Nothing it reaches may import a pty engine or electron.
    ipc: "src/ipc/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Node-only backend. Node builtins stay external.
  platform: "node",
  // `@particle-academy/fancy-pty` MUST NOT be bundled.
  //
  // Bundled, fancy-pty's `packageRoot()` would resolve relative to THIS package's
  // `dist/`, so the helper lookup would go to
  // `fancy-term-host/bin/<platform>-<arch>/`, which does not exist — and every
  // consumer would get "no helper binaries are present" from a package that
  // installed perfectly, and ship a duplicate copy of its JS. That is a real
  // failure and it did happen: with a bare `require()`, esbuild inlined the module
  // (measured).
  //
  // `pty-host.ts` imports it statically, so this entry is load-bearing for that
  // file, together with tsup's default of leaving `dependencies` external.
  // `manager.ts` loads it through `createRequire(import.meta.url)`, a call on a
  // LOCAL variable esbuild cannot follow, so that path cannot be bundled either
  // way. `host-live.test.ts` and `default-engine.test.ts` check the built output.
  external: ["@particle-academy/fancy-pty", /^node:/],
  treeshake: true,
});
