import { describe, expect, it } from "vitest";

import pkg from "../../package.json";

/**
 * How this package declares `node-pty`.
 *
 * It is a packaging fact, so no unit test of the backend can reach it — and it
 * was wrong in a way that shipped BROKEN INSTALLERS while reporting success.
 *
 * `node-pty` was a `peerDependency` through 0.8.0. The reasoning was sound in
 * isolation (one native build per app, the consumer owns the Electron ABI
 * rebuild) and wrong in practice, because **electron-builder never packs a peer
 * dependency.** From `app-builder-lib@26.15.3`,
 * `out/node-module-collector/nodeModulesCollector.js:169`:
 *
 *     isProdDependency(depName, pkg) {
 *         const prodDeps = { ...pkg.dependencies, ...pkg.optionalDependencies };
 *         return prodDeps[depName] != null;
 *     }
 *
 * `peerDependencies` appears NOWHERE in that collector, and `files` globs
 * cannot add to `node_modules`. So every Genie 2 installer built against
 * 0.7.0/0.8.0 shipped with no node-pty at all and reported green. Measured by
 * `claude · genie2`; the citation was then verified against the published
 * tarball rather than taken on faith. Our own `fancyTermAfterPack` hook caught
 * it on its first real run on both platforms — after the manifest, the `files`
 * globs and a green build had all said everything was fine.
 *
 * **`optionalDependencies`, not `dependencies`** — the owner's decision on
 * 2026-10-10, and the reason is in that same line: optional deps ARE collected,
 * so an installer gets node-pty, while a consumer of the pure-JS `./ipc`
 * subpath (which exists precisely so a process can ship with no native
 * dependency — issue #12) can still skip the native build with
 * `--omit=optional`. The trade accepted: a failed native build surfaces at
 * runtime rather than as a loud install failure, which is tolerable because a
 * packaged app cannot ship a missing build past `fancyTermAfterPack`.
 */

/**
 * Read the manifest through an index, not through the inferred JSON type.
 *
 * Once `peerDependencies` is gone from package.json, `pkg.peerDependencies` is
 * a TYPE error rather than `undefined` — which would mean the assertion that it
 * is absent could not be written at all. The absence has to stay checkable at
 * RUNTIME, because a future edit that re-adds the key is exactly what this
 * guards against.
 */
const manifest = pkg as unknown as Record<string, Record<string, string> | undefined>;

const peers: Record<string, string> = manifest.peerDependencies ?? {};
const optional: Record<string, string> = manifest.optionalDependencies ?? {};
const devs: Record<string, string> = manifest.devDependencies ?? {};

describe("node-pty is declared where electron-builder can actually see it", () => {
    it("is an optionalDependency", () => {
        expect(optional["node-pty"], "electron-builder only collects dependencies + optionalDependencies").toBeTypeOf(
            "string",
        );
    });

    it("is NOT a peerDependency — that is the shape that shipped empty installers", () => {
        // The specific defect, pinned. A well-meaning "tidy the deps" pass that
        // moves it back here must go red rather than quietly break packaging
        // again, because the symptom is an installer that builds fine.
        expect(peers["node-pty"]).toBeUndefined();
    });

    it("pins the version WE build against, derived rather than typed in", () => {
        // The devDependency is the only node-pty this suite ever runs against,
        // so it is what turns the declared range into a tested claim. Bump the
        // devDependency and this fails until the declared range moves with it.
        expect(devs["node-pty"]).toBeTypeOf("string");
        expect(optional["node-pty"]).toBe(devs["node-pty"]);
    });

    it("declares it in exactly ONE place", () => {
        // Listing it as both a peer and an optional dep is how a manifest starts
        // disagreeing with itself; npm would install it either way and the next
        // reader could not tell which line was load-bearing.
        const places = ["dependencies", "peerDependencies", "optionalDependencies"].filter(
            (section) => manifest[section]?.["node-pty"],
        );
        expect(places).toEqual(["optionalDependencies"]);
    });
});
