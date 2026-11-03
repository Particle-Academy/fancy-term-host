# Packaging for a desktop app (Electron)

`fancy-term-host` runs its PTYs on **`@particle-academy/fancy-pty`**: a small helper
executable per pty plus pure JavaScript. There is no native addon, so no rebuild,
no ABI to match, no signing step and no install script. It is a plain `dependency`,
which `electron-builder` packs.

What can still be wrong is where it lands. **A file inside an asar has no path the OS
can execute**, and `child_process.spawn` is not redirected the way `fs` reads are.

## The one line, and the check

```js
// electron-builder.config.js  (or the "build" block in package.json)
const { fancyTermAfterPack } = require('@particle-academy/fancy-term-host/electron');

module.exports = {
  // All of fancy-pty, not just bin/. See below.
  asarUnpack: ['**/node_modules/@particle-academy/fancy-pty/**'],
  // Nothing here needs a rebuild.
  npmRebuild: false,
  afterPack: async (context) => {
    const r = await fancyTermAfterPack(context);
    console.log(`[fancy-term-host] ${r.platform}: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);
    if (!r.ok) throw new Error(`fancy-term-host packaging check failed: ${r.detail}`);
  },
};
```

**Unpack all of fancy-pty when you use the detached host.** `resolveHostScript` runs
`pty-host.js` from `app.asar.unpacked` when it is there, and from there it can only
load a fancy-pty whose JavaScript is unpacked too. If you unpack only `bin/` the
in-process backend works and the detached host cannot start. The hook reports that
case as `ok: false` when it can see the host script in the unpacked tree. If your host
runs from anywhere else, whether it can load fancy-pty is your packaging's to check.

**The helper resolves in place, and the hook never moves it.** Do not copy it to a temp
directory: an updater's sweep of the install folder cannot see it there, so one stuck
helper can block an upgrade with nothing able to say what is holding it.

It is **idempotent** (safe on every build) and **never throws**. It returns an
`AfterPackResult`. **Branch on `ok`, never on `action`**, which is for the log:

| situation | result |
|---|---|
| Windows: the helper for the target arch is unpacked | `{ action: 'already-present', ok: true }` |
| Linux, macOS: the same, and it made sure the helper is executable | `{ action: 'fixed', ok: true }` |
| the helper for the target arch is not there | `{ action: 'failed', ok: false }` |
| the host is unpacked and fancy-pty's JavaScript is not | `{ action: 'failed', ok: false }` |
| no engine found under the packed app | `{ action: 'skipped', ok: false }` |

The arch comes from `context.arch`, or `{ arch: 'x64' }` to force it. A `universal`
build needs both helpers. If your packager puts fancy-pty somewhere unusual, pass
`{ fancyPtyDir }`.

## Windows consoles

**Nothing here allocates a console per shell.** The detached host starts one kind of
child, the helper, and fancy-pty spawns it with `detached` (`DETACHED_PROCESS`, so it
has no console at all) and `windowsHide`. The helper's only child runs on the
pseudoconsole, whose own conhost is headless: ConPTY creates a hidden window for it and
never shows it. There is no agent process. That is what `useConptyDll` was set to get
from node-pty (#4), and it needs no option now.

What has and has not been measured, because it is easy to round up:

- `npm run verify:flash` in fancy-pty watches for any console being SHOWN, with a
  positive control, across spawn/kill cycles. Measured on an interactive desktop,
  against a helper from before it was started `detached`.
- This package's live suite runs a real host hidden, not detached, so it never has a
  windowless parent.
- **A truly detached host on Windows, on this engine, has not been run for this
  change.** The argument above is from the code. Your `spawnDetached` is yours: use
  `detached: true`, and `windowsHide: true` as well.

## If you ship node-pty yourself

`node-pty` is no longer a dependency. If you inject it as `ptySpawn` on the in-process
backend, it comes from your own `dependencies`, and three known breakages still apply.
The hook fixes them when it finds a node-pty in the packed app, as it always did:

| OS | Symptom | Cause | The hook |
|---|---|---|---|
| **Windows** | `Cannot find conpty.dll at …/build/Release/conpty/conpty.dll` | `conpty.dll` and `OpenConsole.exe` ship only under `prebuilds/<plat>/conpty/` and `third_party/conpty/`. | copies them in, for the target arch |
| **macOS (arm64)** | shell child never starts | `spawn-helper` ships unsigned, and the kernel kills it on exec | ad-hoc signs it |
| **Linux** | shell child never starts | `spawn-helper` must stay executable | `chmod +x` |

Keep it out of the asar with `asarUnpack: ['**/node_modules/node-pty/**']`, and pass
`{ nodePtyDir }` if it is somewhere else, or `{ arch }` or `{ conptySource }` to choose
the `conpty.dll`. Both `arch` and `conptySource` are read only after a present-files
check: node-pty's `postinstall` copies a **host-arch** dll, so on a cross-arch build
remove `build/Release/conpty/` first or you get `already-present` over the wrong dll.
Set `npmRebuild: false`: node-pty 1.x is a Node-API addon that ships prebuilds, and the
default rebuild needs Python and MSVC. A fresh Windows also has no VC++ redistributable,
which every `.node` addon needs.

If fancy-pty is not unpacked in that build, your node-pty's result decides `ok`, and
`detail` warns that the default engine and the detached host cannot start.

## Where the runtime still matters

It no longer has to match anything. The detached host needs a Node of the supported
version: Electron-as-Node with `ELECTRON_RUN_AS_NODE=1` as the README shows, or, for
the T3+ per-user service, a standalone Node (see [`docs/service.md`](./service.md)),
which is what stops a running host pinning your app's executable. What must line up
is platform and arch, and fancy-pty ships a helper for `win32`, `darwin` and `linux`
on `x64` and `arm64`. On any other, `create` fails with an error naming the platform.
