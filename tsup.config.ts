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
    // Electron-builder packaging helpers (afterPack node-pty fix-ups). A subpath
    // so non-desktop consumers never pull in the packaging code.
    electron: "src/electron/index.ts",
    // The IPC transport with no native dependency (#12): the framing codec and
    // the per-user pipe/pidfile helpers, for a second host that ships without
    // node-pty. Nothing it reaches may import node-pty or electron.
    ipc: "src/ipc/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Node-only backend. node-pty is a native peer (consumer builds it) and node
  // builtins stay external — never bundle either.
  platform: "node",
  external: ["node-pty", /^node:/],
  treeshake: true,
});
