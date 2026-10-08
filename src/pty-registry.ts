/**
 * The live ptys, and the ONE rule that keeps a reused id from racing the native
 * layer (#13).
 *
 * ## The race this exists to close
 *
 * `kill` used to do this:
 *
 * ```ts
 * e.pty.kill();        // native teardown STARTS
 * ptys.delete(msg.id); // the id is free again IMMEDIATELY
 * ```
 *
 * On Windows `kill()` signals the process and returns; closing the pseudoconsole
 * and joining ConPTY's agent threads finish afterwards, and `onExit` is what says
 * they did. Deleting the entry synchronously therefore frees the id **while the
 * old pseudoconsole is still being destroyed** — so a `create` for the same id
 * arriving in that window spawned a SECOND native pseudoconsole against an id
 * whose first one was mid-destruction.
 *
 * The host that died with `0xC0000005` had been taking ~2,678 spawn requests
 * across **three distinct ids**, one create about every 1.8 seconds for over an
 * hour: exactly the cadence that lands creates inside teardown windows.
 *
 * **This does not claim to be the cause of that crash.** The reporter later
 * retracted the reused-id theory — a second pty-host racing the first was fixed
 * in the surrounding app, and that explains the fault at least as well. The rule
 * here stands on its own either way: a create must not overlap a dispose of the
 * same id, whatever else is true, and a lost race deserves an error rather than a
 * native fault that takes every terminal on the machine with it.
 *
 * ## The rule
 *
 * An id is in one of three states, and `create` means something different in each:
 *
 *   - **free**      → spawn
 *   - **live**      → return the existing pty (unchanged: attaching to a running
 *                     terminal is the normal reconnect path, not an error)
 *   - **disposing** → WAIT for teardown to finish, then spawn
 *
 * A dispose that never reports completion would strand the id forever, so the
 * wait is bounded: after `disposeTimeoutMs` the entry is dropped and the create
 * proceeds. A terminal that fails to start is recoverable; a host that stops
 * answering for one id is not.
 */

/** The slice of node-pty's `IPty` this registry needs. Kept minimal so tests need no native module. */
export interface RegistryPty {
    readonly pid: number;
    kill(): void;
}

export interface PtyEntry<P extends RegistryPty = RegistryPty> {
    pty: P;
    shell: string;
    scrollback: string;
}

interface Slot<P extends RegistryPty> {
    entry: PtyEntry<P>;
    /** Set once `kill()` has been called and teardown has not yet been confirmed. */
    disposing: boolean;
    /** Resolved when the slot is gone — by `settle()` or by the watchdog. */
    freed: Promise<void>;
    resolveFreed: () => void;
    watchdog?: ReturnType<typeof setTimeout>;
}

export class PtyRegistry<P extends RegistryPty = RegistryPty> {
    private readonly slots = new Map<string, Slot<P>>();

    constructor(private readonly disposeTimeoutMs = 5_000) {}

    /** Live entries only. A disposing id reads as absent, because it is going away. */
    get(id: string): PtyEntry<P> | undefined {
        const slot = this.slots.get(id);
        return slot === undefined || slot.disposing ? undefined : slot.entry;
    }

    /** Every live entry, for `list`. */
    entries(): Array<[string, PtyEntry<P>]> {
        const out: Array<[string, PtyEntry<P>]> = [];
        for (const [id, slot] of this.slots) {
            if (!slot.disposing) out.push([id, slot.entry]);
        }
        return out;
    }

    /** Live ptys. Drives the idle self-exit, which must not count a disposing one. */
    size(): number {
        return this.entries().length;
    }

    /**
     * Attach to the live pty for `id`, or make one.
     *
     * `make` is only called when the id is genuinely free, and never while a
     * previous pty for the same id is still being torn down — that overlap is the
     * whole point of this class.
     */
    async create(
        id: string,
        make: () => PtyEntry<P>,
    ): Promise<{ entry: PtyEntry<P>; existing: boolean }> {
        const live = this.get(id);
        if (live !== undefined) {
            return { entry: live, existing: true };
        }

        // Not live, but possibly mid-dispose. Waiting here is what serializes the
        // two against the native layer.
        await this.whenFree(id);

        const entry = make();
        const slot = this.slotFor(entry);
        this.slots.set(id, slot);

        return { entry, existing: false };
    }

    /**
     * Begin disposing `id`. The slot stays until {@link settle} confirms the
     * process is gone, so the id cannot be reused underneath the teardown.
     */
    dispose(id: string): void {
        const slot = this.slots.get(id);
        if (slot === undefined || slot.disposing) return;

        slot.disposing = true;
        try {
            slot.entry.pty.kill();
        } catch {
            // Already exited. The slot still waits for `settle`, or the watchdog.
        }

        slot.watchdog = setTimeout(() => this.settle(id), this.disposeTimeoutMs);
        // Never hold the process open just to time out a dead pty.
        slot.watchdog.unref?.();
    }

    /**
     * Teardown is confirmed — call from the pty's `onExit`. Frees the id and
     * releases anything waiting to create it.
     */
    settle(id: string): void {
        const slot = this.slots.get(id);
        if (slot === undefined) return;

        if (slot.watchdog !== undefined) clearTimeout(slot.watchdog);
        this.slots.delete(id);
        slot.resolveFreed();
    }

    /** Resolves once `id` holds no slot. Immediate when it already holds none. */
    whenFree(id: string): Promise<void> {
        const slot = this.slots.get(id);
        return slot === undefined ? Promise.resolve() : slot.freed;
    }

    /** Whether `id` is mid-dispose. For tests and diagnostics. */
    isDisposing(id: string): boolean {
        return this.slots.get(id)?.disposing === true;
    }

    private slotFor(entry: PtyEntry<P>): Slot<P> {
        let resolveFreed!: () => void;
        const freed = new Promise<void>((resolve) => {
            resolveFreed = resolve;
        });

        return { entry, disposing: false, freed, resolveFreed };
    }
}
