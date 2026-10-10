# Packaging node-pty for a desktop app (Electron)

`fancy-term-host` owns the PTYs through **`node-pty`**, a native addon you build
yourself (it's a peer dependency). Bundling a native addon into a packaged
Electron app is where terminals silently break: `electron-builder`'s
`install-app-deps` rebuilds `node-pty`, but the rebuild output is left unusable
**per-OS**, so a standard packaged build spawns **no terminal at all** until you
patch it. This page is the patch — and `fancy-term-host` ships it for you.

## The three breakages

| OS | Symptom | Cause |
|---|---|---|
| **Windows** | Runtime: `Cannot find conpty.dll at …/build/Release/conpty/conpty.dll (code 3)` | The rebuild produces `build/Release/conpty.node` but **not** the `conpty/` subdir it `LoadLibrary`s. `conpty.dll` + `OpenConsole.exe` ship only under `prebuilds/<plat>/conpty/` and `third_party/conpty/`. |
| **macOS (arm64)** | Shell child never starts (cursor, no output); `spawn-helper` SIGKILLed | `node-pty`'s `spawn-helper` ships **unsigned**. All arm64 code must be at least **ad-hoc signed** or the kernel kills it on exec. |
| **Linux** | Shell child never starts | `spawn-helper` must remain **executable** after packaging. |

## Fix it in one line (`afterPack`)

`fancy-term-host` exports an `afterPack` hook that applies the right fix for the
platform being packed. Point your `electron-builder` config at it:

```js
// electron-builder.config.js  (or the "build" block in package.json)
const { fancyTermAfterPack } = require('@particle-academy/fancy-term-host/electron');

module.exports = {
  // node-pty is native — keep it OUT of the asar so its .node + helpers load,
  // and so the afterPack hook can find + fix them.
  asarUnpack: ['**/node_modules/node-pty/**'],
  afterPack: (context) => fancyTermAfterPack(context),
};
```

ESM:

```js
import { fancyTermAfterPack } from '@particle-academy/fancy-term-host/electron';
export default {
  asarUnpack: ['**/node_modules/node-pty/**'],
  afterPack: (context) => fancyTermAfterPack(context),
};
```

It's **idempotent** (safe on every build) and **never throws** — it returns an
`AfterPackResult` you can log:

```js
afterPack: async (context) => {
  const r = await fancyTermAfterPack(context);
  console.log(`[fancy-term-host] ${r.platform}: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);
  if (!r.ok) throw new Error(`node-pty packaging fix failed: ${r.detail}`);
},
```

**Branch on `ok`, never on `action`.** `ok` is the only field that answers "will
a terminal spawn in this build", and the example above is the whole gate you
need.

`action` is one of `fixed` · `already-present` · `skipped` · `failed`, and it is
for the LOG, not for control flow — because **`skipped` has two meanings**:

| situation | result |
|---|---|
| nothing to fix on this platform — e.g. Linux has no `spawn-helper`, since node-pty builds it only on macOS | `{ action: 'skipped', ok: true }` |
| **node-pty not found under the packed app** | `{ action: 'skipped', ok: false }` |

So a CI gate keyed on the string cannot be right in either direction: strict
enough to catch the second case and it fails every legitimate Linux build; loose
enough to pass Linux and the second case sails through. **An earlier version of
this page described only the `ok: false` meaning**, and a consumer reasonably
read that as "skipped means not found" and wrote their gate accordingly — it was
correct only because they had also copied the `!ok` check from the example.

On `{ action: 'skipped', ok: false }`: check your `asarUnpack` glob, or pass an
explicit dir — `fancyTermAfterPack(context, { nodePtyDir })`. And note that
`node-pty` must be reachable to electron-builder's module collector at all,
which means `dependencies` or `optionalDependencies` — **a `peerDependency` is
never packed** (that was this package's own bug through 0.8.0; see the changelog
for 0.9.0).

A future minor will split the benign case out as a distinct `not-found` action so
the log line is self-describing; `ok` will keep working unchanged.

### Windows arch selection

`conpty.dll` is **per-arch machine code** — the x64 and arm64 dlls are not
interchangeable. When `node-pty` ships more than one prebuild
(`prebuilds/win32-x64/`, `prebuilds/win32-arm64/`), the helper copies the one
matching the build's **target arch** (`context.arch`), so an x64 app never gets
the arm64 dll (which would fail `LoadLibrary` and spawn no terminal). Override
the arch or pin the source explicitly if needed:

```js
fancyTermAfterPack(context, { arch: 'x64' });          // force the arch name
fancyTermAfterPack(context, { conptySource: '/abs/dir' }); // pin the source dir
```

### macOS signing note

The hook **ad-hoc** signs `spawn-helper` (`codesign --force --sign -`) so it runs
on Apple Silicon. If you ship a notarized app with your own Developer ID, sign
`spawn-helper` with your identity instead (electron-builder's own signing step,
run after `afterPack`, will typically re-sign the bundle) — the ad-hoc signature
is the floor that keeps unsigned dev / self-distributed builds working.

## What the hook does (equivalent shell)

If you'd rather inline it, this is exactly what the helper runs against the
packaged `node-pty` (`…/Resources/app.asar.unpacked/node_modules/node-pty`):

```sh
# Windows — create the conpty subdir node-pty LoadLibrary's.
# Use YOUR target arch (win32-x64 / win32-arm64) — the dlls are not interchangeable.
mkdir -p build/Release/conpty
cp prebuilds/win32-x64/conpty/conpty.dll      build/Release/conpty/
cp prebuilds/win32-x64/conpty/OpenConsole.exe build/Release/conpty/
# (falls back to third_party/conpty/ when prebuilds/ is absent)

# macOS — ad-hoc sign spawn-helper so arm64 doesn't SIGKILL it
codesign --force --sign - build/Release/spawn-helper

# Linux — keep spawn-helper executable
chmod +x build/Release/spawn-helper
```

## Electron ABI note

`node-pty` is a native addon: it must be built against the **same ABI** as the
runtime that loads it. Run `electron-builder install-app-deps` (or
`electron-rebuild`) so `node-pty` matches your Electron version, and when you run
the **detached pty-host** on Electron-as-Node, spawn it with
`ELECTRON_RUN_AS_NODE=1` so the ABI still matches (see the README). For the
**T3+ per-user service**, the host runs on a *standalone* Node — give that
runtime its own ABI-matched `node-pty` (`ServiceRuntime.nodePtyDir`).
