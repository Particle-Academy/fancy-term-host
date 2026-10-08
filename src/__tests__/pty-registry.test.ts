import { describe, expect, it, vi } from "vitest";
import { PtyRegistry, type PtyEntry, type RegistryPty } from "../pty-registry";

/**
 * A create must never overlap a dispose of the same id (#13).
 *
 * The host used to `kill()` and delete the map entry in the same tick, freeing the
 * id while the native pseudoconsole was still being destroyed. A create arriving
 * in that window spawned a second one against the same id. The host that died
 * with `0xC0000005` had been taking one create every ~1.8s across three ids for
 * over an hour — exactly the cadence that lands creates inside teardown windows.
 *
 * Asserted through `make` CALL COUNTS and ordering rather than through a real
 * pty: the property is "when does the registry let a spawn happen", and a native
 * module cannot be asked that question deterministically.
 */
class FakePty implements RegistryPty {
    killed = false;

    constructor(readonly pid: number) {}

    kill(): void {
        this.killed = true;
    }
}

let nextPid = 1000;

function entry(): PtyEntry<FakePty> {
    return { pty: new FakePty(nextPid++), shell: "bash", scrollback: "" };
}

describe("PtyRegistry", () => {
    it("spawns when the id is free", async () => {
        const reg = new PtyRegistry<FakePty>();
        const make = vi.fn(entry);

        const r = await reg.create("a", make);

        expect(make).toHaveBeenCalledTimes(1);
        expect(r.existing).toBe(false);
        expect(reg.size()).toBe(1);
    });

    it("attaches to a live pty instead of spawning a second one", async () => {
        // The normal reconnect path, and it must stay cheap: re-attaching to a
        // running terminal is not an error.
        const reg = new PtyRegistry<FakePty>();
        const make = vi.fn(entry);

        const first = await reg.create("a", make);
        const second = await reg.create("a", make);

        expect(make).toHaveBeenCalledTimes(1);
        expect(second.existing).toBe(true);
        expect(second.entry.pty.pid).toBe(first.entry.pty.pid);
    });

    it("does NOT spawn while a dispose of the same id is in flight", async () => {
        // THE REGRESSION. Before the fix the entry was deleted in the same tick as
        // kill(), so this create went straight through to a native spawn against an
        // id whose pseudoconsole was still being destroyed.
        const reg = new PtyRegistry<FakePty>();
        const make = vi.fn(entry);

        await reg.create("a", make);
        reg.dispose("a");

        expect(reg.isDisposing("a")).toBe(true);

        let resolved = false;
        const pending = reg.create("a", make).then((r) => {
            resolved = true;
            return r;
        });

        // Give the microtask queue every chance to run it through.
        await Promise.resolve();
        await Promise.resolve();

        expect(resolved, "create resolved while the id was still disposing").toBe(false);
        expect(make, "a second pty was spawned mid-dispose").toHaveBeenCalledTimes(1);

        // Teardown confirmed — now, and only now, may it spawn.
        reg.settle("a");
        const r = await pending;

        expect(make).toHaveBeenCalledTimes(2);
        expect(r.existing).toBe(false);
    });

    it("kills the pty when disposing, and only once", async () => {
        const reg = new PtyRegistry<FakePty>();
        const r = await reg.create("a", entry);

        reg.dispose("a");
        reg.dispose("a");

        expect(r.entry.pty.killed).toBe(true);
        // A second dispose must not re-kill or restart the watchdog, or a
        // repeatedly-disposed id never settles.
        expect(reg.isDisposing("a")).toBe(true);
    });

    it("hides a disposing pty from get/list/size", async () => {
        // A disposing terminal is going away; reporting it as live would have the
        // host write to a pty whose handles are closing.
        const reg = new PtyRegistry<FakePty>();
        await reg.create("a", entry);
        reg.dispose("a");

        expect(reg.get("a")).toBeUndefined();
        expect(reg.entries()).toEqual([]);
        expect(reg.size()).toBe(0);
    });

    it("survives a dispose that never reports completion", async () => {
        // A pty whose onExit never fires would otherwise strand the id forever.
        // A terminal that fails to start is recoverable; a host that stops
        // answering for one id is not.
        vi.useFakeTimers();
        try {
            const reg = new PtyRegistry<FakePty>(1_000);
            const make = vi.fn(entry);

            await reg.create("a", make);
            reg.dispose("a");

            const pending = reg.create("a", make);
            vi.advanceTimersByTime(1_000);

            await pending;
            expect(make).toHaveBeenCalledTimes(2);
            expect(reg.isDisposing("a")).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("settle on an unknown id is a no-op", () => {
        // onExit can arrive after the watchdog already cleaned up.
        const reg = new PtyRegistry<FakePty>();

        expect(() => reg.settle("nope")).not.toThrow();
    });

    it("keeps ids independent", async () => {
        // One terminal disposing must not block a create for any other, which is
        // the whole reason this is keyed rather than a single lock.
        const reg = new PtyRegistry<FakePty>();
        const make = vi.fn(entry);

        await reg.create("a", make);
        reg.dispose("a");

        const b = await reg.create("b", make);

        expect(b.existing).toBe(false);
        expect(make).toHaveBeenCalledTimes(2);
    });
});
