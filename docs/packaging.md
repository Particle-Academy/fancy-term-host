# Packaging node-pty for a desktop app (Electron)

`fancy-term-host` owns the PTYs through **`node-pty`**, a native addon. It is
declared here as an **`optionalDependency`** — not a peer, which is the one shape
`electron-builder` never packs (that was this package's own bug through 0.8.0;
see `{ action: 'skipped', ok: false }` below). Bundling
a native addon into a packaged Electron app is then where terminals silently
break: the assets node-pty loads at runtime are left incomplete **per-OS**, so a
standard packaged build spawns **no terminal at all** until you patch it. This
page is the patch — and `fancy-term-host` ships it for you.

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
  // node-pty 1.x is a Node-API addon shipping prebuilds: the default rebuild is
  // pointless AND needs Python + MSVC. See "Turn the rebuild OFF" below.
  npmRebuild: false,
  afterPack: (context) => fancyTermAfterPack(context),
};
```

ESM:

```js
import { fancyTermAfterPack } from '@particle-academy/fancy-term-host/electron';
export default {
  asarUnpack: ['**/node_modules/node-pty/**'],
  npmRebuild: false,
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

**`already-present` bypasses that selection, so CROSS-ARCH builds must pass
`arch` explicitly.** node-pty's own `postinstall` already copies a `conpty.dll`
into `build/Release/conpty/`, and it picks the arch from `npm_config_arch` or
`os.arch()` — **the build HOST's**, which the hook has no way to re-derive once
the files are sitting there. Finding them present is the whole basis for
`already-present`, so packing an **arm64** app on an **x64** Windows host yields
`{ action: 'already-present', ok: true }` over an x64 dll, and the installer is
green with a terminal that cannot start. Same-arch builds (the common case) are
unaffected.

Note that **`arch` and `conptySource` do not help here** — both are read only
*after* the present-files check, so neither can override an inherited dll. If
host arch and target arch differ, remove the directory first and let the hook
make the copy from the target's prebuild:

```js
afterPack: async (context) => {
  // Cross-arch only: drop the host-arch dll node-pty's postinstall left behind,
  // so the hook selects by context.arch instead of reporting already-present.
  if (context.arch !== hostArch) rmSync(conptyDir, { recursive: true, force: true });
  const r = await fancyTermAfterPack(context);
  if (!r.ok) throw new Error(`node-pty packaging fix failed: ${r.detail}`);
},
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

## Turn the rebuild OFF — `npmRebuild: false`

**`node-pty` 1.x does not need an Electron rebuild, and attempting one is how
packaging fails on a machine that is not a CI runner.** Set:

```js
module.exports = {
  npmRebuild: false,
  asarUnpack: ['**/node_modules/node-pty/**'],
  afterPack: (context) => fancyTermAfterPack(context),
};
```

Two separate reasons, and the first is why the second is safe to skip:

- **It is a Node-API addon, so its ABI does not move with the runtime.**
  `node-pty@1.1.0` depends on `node-addon-api` and builds against Node-API,
  which is ABI-stable across Node *and* Electron versions. It also ships
  prebuilt binaries — `prebuilds/{darwin-arm64,darwin-x64,win32-arm64,win32-x64}/`
  — and `lib/utils.js` loads `build/Release` → `build/Debug` →
  `prebuilds/<platform>-<arch>`, so with no `build/Release/*.node` present the
  shipped prebuild is what loads. Rebuilding produces a binary that is not
  more compatible than the one already in the tarball.
- **electron-builder's default `@electron/rebuild` pass rebuilds it from source
  with node-gyp, which needs Python + MSVC.** GitHub's Windows runners have
  both; a clean Windows does not, and the build dies with `Could not find any
  Python installation to use`. Measured by `claude · tynn` on a Windows test VM.

With `npmRebuild: false` the hook reports `{ action: 'already-present', ok: true }`
rather than `fixed`, because node-pty's own `postinstall` has already put
`conpty.dll` + `OpenConsole.exe` in `build/Release/conpty/`. Both are `ok` — this
is exactly why you branch on `ok` and not on `action`.

**Linux has no prebuild**, so there `npm install` itself runs `node-gyp rebuild`
(node-pty's `install` script is `node scripts/prebuild.js || node-gyp rebuild`).
A Linux build host therefore still needs a C++ toolchain at *install* time —
`npmRebuild: false` only removes the *packaging*-time rebuild.

### Clean Windows machines have no VC++ runtime

A fresh Windows 11 ships without the Visual C++ redistributable, and **every**
`.node` addon then fails to load — reported as `Cannot find native binding`,
which reads like a missing file rather than a missing runtime. Install
`vc_redist.x64` on any bare Windows machine you build or test on. (Also measured
on a clean VM by `claude · tynn`; their test-VM provisioning now includes it.)

### Where the ABI still matters

When you run the **detached pty-host** on Electron-as-Node, spawn it with
`ELECTRON_RUN_AS_NODE=1` (see the README). For the **T3+ per-user service** the
host runs on a *standalone* Node — give that runtime its own `node-pty`
(`ServiceRuntime.nodePtyDir`). Node-API keeps these compatible across versions;
what must still line up is platform and arch.
