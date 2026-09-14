/**
 * Length-prefixed JSON framing for a local IPC stream.
 *
 * PURE: node's `Buffer` and nothing else — no electron, no node-pty, no net. It
 * is the one implementation of the framing: the pty-host and its client use it
 * through `host-protocol.ts`, and a second per-user host uses it through the
 * `./ipc` subpath (#12). Keep it free of imports, or that subpath starts loading
 * whatever gets imported here.
 *
 * Framing: each message is `[4-byte big-endian uint32 length][utf8 JSON body]`.
 * The length prefix is the byte length of the JSON body. A FrameDecoder buffers
 * partial reads and yields whole messages as they complete — TCP/pipe streams
 * don't preserve message boundaries, so we can't assume one `data` event == one
 * message.
 */

const LENGTH_BYTES = 4;

/** Hard cap on a single frame (16 MB). Guards against a runaway/garbage length
 *  prefix allocating unbounded memory. node-pty data chunks are tiny; a
 *  serialized scrollback is bounded well under this. */
export const MAX_FRAME = 16 * 1024 * 1024;

/** Encode a message as a length-prefixed JSON frame ready for the socket. */
export function encodeFrame<T>(msg: T): Buffer {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.allocUnsafe(LENGTH_BYTES);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

/**
 * Streaming frame decoder. Feed it raw socket chunks via `push`; it returns the
 * complete messages that became available (zero or more), buffering any partial
 * tail until the rest arrives. One decoder per socket.
 *
 * `T` is what the peer is trusted to send. It is a cast, not a check: the body
 * is parsed JSON, so validate it where a malformed message would do harm.
 *
 * Resilient by design: a malformed JSON body is skipped (the frame is consumed
 * but yields nothing) rather than throwing — a corrupt frame must not wedge the
 * whole stream. An absurd length prefix (> MAX_FRAME) is treated as a desync and
 * the buffer is reset; the caller can decide whether to drop the connection.
 */
export class FrameDecoder<T = unknown> {
    private buffer: Buffer = Buffer.alloc(0);

    /** The same cap as {@link MAX_FRAME}, where callers have always read it. */
    static readonly MAX_FRAME = MAX_FRAME;

    /** True when the last push hit an oversized/desynced frame. The caller
     *  should drop the connection — the stream can't be trusted to realign. */
    desynced = false;

    push(chunk: Buffer): T[] {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        const out: T[] = [];
        for (;;) {
            if (this.buffer.length < LENGTH_BYTES) break;
            const len = this.buffer.readUInt32BE(0);
            if (len > MAX_FRAME) {
                // Desync / garbage. Reset and flag — realigning a length-prefixed
                // stream after a bad prefix isn't possible without a sentinel.
                this.desynced = true;
                this.buffer = Buffer.alloc(0);
                break;
            }
            if (this.buffer.length < LENGTH_BYTES + len) break; // wait for more
            const body = this.buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + len);
            this.buffer = this.buffer.subarray(LENGTH_BYTES + len);
            try {
                out.push(JSON.parse(body.toString('utf8')) as T);
            } catch {
                /* skip a corrupt frame; the framing itself is still aligned */
            }
        }
        return out;
    }
}
