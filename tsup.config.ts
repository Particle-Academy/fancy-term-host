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
  // `@particle-academy/fancy-pty` is listed here as BELT-AND-BRACES, and it is
  // worth being exact about that rather than overstating it.
  //
  // WHY IT MATTERS AT ALL: bundled, fancy-pty's `packageRoot()` would resolve
  // relative to THIS package's `dist/`, so the helper lookup would go to
  // `fancy-term-host/bin/<platform>-<arch>/`, which does not exist — and every
  // consumer would get "no helper binaries are present" from a package that
  // installed perfectly. It would also defeat the optionalDependency and ship a
  // duplicate copy of its JS. That is a real failure and it did happen: with a
  // bare `require()`, esbuild inlined the module (measured).
  //
  // WHY IT IS NOW REDUNDANT: `manager.ts` loads the engine through
  // `createRequire(import.meta.url)`, so the bundle emits a call on a LOCAL
  // variable. esbuild does not recognise that as a module reference and cannot
  // follow it, which makes bundling impossible by construction. Measured both
  // ways — with and without this entry — and the output is byte-identical in
  // the respects that matter: the reference survives and nothing is inlined.
  //
  // So it stays for the case where someone converts that call back to a static
  // `import`, where it WOULD be load-bearing again. It is insurance, not the
  // mechanism, and `default-engine.test.ts` says the same thing.
  external: ["node-pty", "@particle-academy/fancy-pty", /^node:/],
  treeshake: true,
});
