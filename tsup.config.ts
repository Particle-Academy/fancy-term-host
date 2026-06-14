import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries: the library barrel + the detached pty-host script (Tier 3),
  // which consumers resolve via `ptyHostScriptPath()` and spawn as a child.
  entry: {
    index: "src/index.ts",
    "pty-host": "src/pty-host.ts",
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
