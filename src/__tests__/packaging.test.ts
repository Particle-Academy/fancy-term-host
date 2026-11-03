import { describe, expect, it } from "vitest";

import pkg from "../../package.json";

/**
 * How this package declares its pty engine.
 *
 * It is a packaging fact, so no unit test of the backend can reach it, and it has
 * already been wrong in a way that shipped BROKEN INSTALLERS while reporting success.
 *
 * `node-pty` was a `peerDependency` through 0.8.0, and **electron-builder never packs
 * a peer dependency.** From `app-builder-lib@26.15.3`,
 * `out/node-module-collector/nodeModulesCollector.js:169`:
 *
 *     isProdDependency(depName, pkg) {
 *         const prodDeps = { ...pkg.dependencies, ...pkg.optionalDependencies };
 *         return prodDeps[depName] != null;
 *     }
 *
 * `peerDependencies` appears NOWHERE in that collector, and `files` globs cannot add
 * to `node_modules`. So every Genie 2 installer built against 0.7.0/0.8.0 shipped
 * with no node-pty at all and reported green. Measured by `claude · genie2`; the
 * citation was then verified against the published tarball.
 *
 * Both engines were `optionalDependencies` after that, so a consumer of the pure-JS
 * `./ipc` subpath could skip a native BUILD with `--omit=optional`. **fancy-pty is a
 * plain dependency now, because the detached host imports it statically and has no
 * other engine**, and because the reason is gone: it has no build, no install script
 * and no dependencies, so there is nothing to skip. `./ipc` still loads none of it
 * (`ipc-entry.test.ts`); it only sits on disk.
 *
 * `node-pty` is gone from all of it (the owner's decision, 2026-11-03). A consumer may
 * still inject it as `ptySpawn` on the in-process backend, from their own dependencies.
 */

/**
 * Read the manifest through an index, not through the inferred JSON type.
 *
 * Once a section is gone from package.json, reading it is a TYPE error rather than
 * `undefined`, which would mean the assertion that it is absent could not be written
 * at all. The absence has to stay checkable at RUNTIME, because a future edit that
 * re-adds the key is exactly what this guards against.
 */
const manifest = pkg as unknown as Record<string, Record<string, string> | undefined>;
const SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];
const ENGINE = "@particle-academy/fancy-pty";

/** The lowest version a `>=X <2.0` range admits. */
function floor(range: string | undefined): number[] {
    const m = />=(\d+)\.(\d+)\.(\d+) <2\.0/.exec(range ?? "");
    expect(m, `expected a sibling range of the form >=X <2.0, got ${range}`).not.toBeNull();
    return m!.slice(1).map(Number);
}

describe("the engine is declared where a consumer gets it and electron-builder packs it", () => {
    it("is a plain dependency, in exactly that one runtime section", () => {
        expect(manifest.dependencies?.[ENGINE]).toBeTypeOf("string");
        // The defect, pinned: a tidy-up to peer ships installers with no engine, and
        // optional lets an install go without the only engine the host has.
        expect(manifest.peerDependencies?.[ENGINE]).toBeUndefined();
        expect(manifest.optionalDependencies?.[ENGINE]).toBeUndefined();
    });

    it("has the floor the host's safety depends on", () => {
        // 0.4.0 is where a name stops being searched for in the host's own folders,
        // and 0.5.0 is where a batch file's arguments are refused. Below it the move
        // would still pass every test that does not plant a file.
        const [major, minor] = floor(manifest.dependencies?.[ENGINE]);
        expect(major > 0 || minor >= 5, `floor is ${major}.${minor}`).toBe(true);
    });

    it("keeps a caret devDependency, which is what the suite actually ran against", () => {
        expect(manifest.devDependencies?.[ENGINE]).toMatch(/^\^\d/);
    });
});

describe("node-pty is gone", () => {
    it("from every section of the manifest", () => {
        for (const section of SECTIONS) {
            expect(manifest[section]?.["node-pty"], section).toBeUndefined();
        }
    });
});
