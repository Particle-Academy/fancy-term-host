/**
 * Bounded per-pty scrollback: the last `cap` UTF-16 code units of a stream.
 *
 * WHY THIS EXISTS. Through 0.10.0 every copy of the scrollback (the in-process
 * backend, the HostClient mirror, the detached pty-host) was a plain string
 * updated on every chunk as `buf + data`, then `slice(-cap)` once over the cap.
 * The concatenation is cheap in V8 (a rope), but the slice FLATTENS the rope,
 * so once a pty's buffer was full every chunk copied ~1,000,000 code units. A
 * chatty background process therefore cost O(cap) per chunk on the consumer's
 * main thread -- reported by Genie (F5, 2.0.0-beta.33) while fighting UI lag.
 *
 * THE SHAPE. A list of sealed, flat chunks plus a small pending tail:
 *
 *   - append is amortised O(chunk): small writes (interactive echo, one
 *     character at a time) accumulate in `pending` and are joined into one flat
 *     chunk every COALESCE code units, so the list never holds a million
 *     one-character strings; larger writes are sealed as they arrive.
 *   - trim drops whole chunks off the front and records a partial cut of the
 *     first chunk as an OFFSET, never by copying it. Chunks are at least
 *     COALESCE long (except the tail), so the list stays ~cap/COALESCE long.
 *   - toString joins once and caches the result until the next append, so
 *     repeated reads with no output between them are free.
 *
 * THE CONTRACT IS 0.10.0's, EXACTLY, quirks included, and
 * `scrollback-contract.test.ts` pins it: the result is the last `cap` code
 * units of everything appended. That means a cut can land between the halves
 * of a surrogate pair (leaving a lone low surrogate first) or inside an escape
 * sequence (leaving its tail first). Both were true before and are preserved
 * rather than quietly changed; a replay already starts mid-stream, so the
 * renderer has always had to tolerate a partial first sequence.
 */

/** ~1 MB per pty. Enough for an hour of typical dev output without runaway memory. */
export const DEFAULT_SCROLLBACK_MAX = 1_000_000;

/** Small writes are joined into one flat chunk once this many code units accumulate. */
const COALESCE = 8192;

/**
 * Resolve a requested cap. A finite number >= 0 is used (floored); anything
 * else -- undefined, NaN, negative, Infinity -- is the default. `0` is honoured
 * and keeps nothing: a consumer that never replays a pty can opt out of
 * holding its output at all.
 */
export function resolveScrollbackMax(requested: number | undefined): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) {
        return DEFAULT_SCROLLBACK_MAX;
    }
    return Math.floor(requested);
}

export class Scrollback {
    readonly cap: number;
    /** Sealed chunks, oldest first. `chunks[0]` is cut at `headOffset`. */
    private chunks: string[] = [];
    private headOffset = 0;
    /** Small writes not yet sealed into a chunk. */
    private pending: string[] = [];
    private pendingLen = 0;
    /** Retained length, in code units (always <= cap). */
    private len = 0;
    /** The joined value, valid until the next append. */
    private cached: string | null = '';

    constructor(cap: number = DEFAULT_SCROLLBACK_MAX, initial = '') {
        this.cap = resolveScrollbackMax(cap);
        if (initial) this.append(initial);
    }

    get length(): number {
        return this.len;
    }

    append(data: string): void {
        if (!data) return;
        this.cached = null;
        if (data.length >= this.cap) {
            // Everything retained so far falls off the front; keep only the
            // tail of this one write. Same result as appending then trimming,
            // without walking the list to discard it.
            this.chunks = this.cap > 0 ? [data] : [];
            this.headOffset = this.cap > 0 ? data.length - this.cap : 0;
            this.pending = [];
            this.pendingLen = 0;
            this.len = this.cap;
            return;
        }
        if (data.length >= COALESCE) {
            this.seal();
            this.chunks.push(data);
        } else {
            this.pending.push(data);
            this.pendingLen += data.length;
            if (this.pendingLen >= COALESCE) this.seal();
        }
        this.len += data.length;
        this.trim();
    }

    toString(): string {
        if (this.cached !== null) return this.cached;
        const parts =
            this.headOffset > 0 && this.chunks.length > 0
                ? [this.chunks[0].slice(this.headOffset), ...this.chunks.slice(1)]
                : this.chunks.slice();
        for (const p of this.pending) parts.push(p);
        const joined = parts.join('');
        // Hold the joined value AS the storage, not beside it: one copy in
        // memory rather than two, and the next trim cuts it by offset as usual.
        this.chunks = joined ? [joined] : [];
        this.headOffset = 0;
        this.pending = [];
        this.pendingLen = 0;
        this.cached = joined;
        return joined;
    }

    private seal(): void {
        if (this.pendingLen === 0) return;
        this.chunks.push(this.pending.length === 1 ? this.pending[0] : this.pending.join(''));
        this.pending = [];
        this.pendingLen = 0;
    }

    private trim(): void {
        while (this.len > this.cap) {
            if (this.chunks.length === 0) this.seal();
            const first = this.chunks[0];
            const avail = first.length - this.headOffset;
            const excess = this.len - this.cap;
            if (avail <= excess) {
                this.chunks.shift();
                this.headOffset = 0;
                this.len -= avail;
            } else {
                this.headOffset += excess;
                this.len -= excess;
            }
        }
    }
}
