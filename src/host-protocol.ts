/**
 * Pty-host wire protocol (Tier 3).
 *
 * The detached pty-host (main/terminal/pty-host.ts) and the in-app HostClient
 * (main/terminal/host-client.ts) talk over a local IPC transport — a named pipe
 * on Windows, a unix domain socket on POSIX — using a tiny length-prefixed JSON
 * framing so there's no heavy dependency. This module is PURE (no electron, no
 * node-pty, no net): just the message shapes + the framing typed to them, so it
 * can be imported by both ends AND unit-tested in isolation.
 *
 * The framing itself lives in `ipc/frame.ts`, which the `./ipc` subpath also
 * exports for a second per-user host (#12). What is here only NARROWS it to the
 * pty-host's messages — it is not a second copy of it.
 */

import { encodeFrame as encodeAnyFrame, FrameDecoder as AnyFrameDecoder } from './ipc/frame';

/**
 * Protocol version. Bumped whenever the message shapes change in a way that
 * makes an old host incompatible with a new client (or vice-versa). The client
 * refuses to attach to a host whose pidfile reports a different version and
 * spawns a fresh host instead — see host-client.ts connect-or-spawn.
 */
export const PROTOCOL_VERSION = 2;

/** Requests the client sends to the host. `seq` correlates a reply. */
export type ClientMessage =
    | { kind: 'hello'; seq: number; protocolVersion: number }
    | {
          kind: 'create';
          seq: number;
          opts: {
              id: string;
              cwd: string;
              shell?: string;
              args?: string[];
              cols?: number;
              rows?: number;
              env?: Record<string, string>;
          };
      }
    | { kind: 'write'; id: string; data: string }
    | { kind: 'resize'; id: string; cols: number; rows: number }
    | { kind: 'kill'; id: string }
    | { kind: 'list'; seq: number }
    | { kind: 'set-retained'; id: string; retained: boolean }
    | { kind: 'get-scrollback'; seq: number; id: string }
    | { kind: 'ping'; seq: number }
    | { kind: 'shutdown'; seq: number };

/** Pushes + replies the host sends to the client. */
export type HostMessage =
    | { kind: 'hello-ok'; seq: number; protocolVersion: number; pid: number }
    | {
          kind: 'created';
          seq: number;
          result: {
              id: string;
              pid: number;
              shell: string;
              existing: boolean;
              scrollback: string;
          };
      }
    | {
          kind: 'list-result';
          seq: number;
          terminals: Array<{ id: string; pid: number; shell: string }>;
      }
    | { kind: 'scrollback-result'; seq: number; scrollback: string | null }
    | { kind: 'pong'; seq: number }
    | { kind: 'shutdown-ok'; seq: number }
    | { kind: 'data'; id: string; data: string }
    | { kind: 'exit'; id: string; exitCode: number; signal?: number };

export type Frame = ClientMessage | HostMessage;

/** Encode a pty-host message as a length-prefixed JSON frame. */
export function encodeFrame(msg: Frame): Buffer {
    return encodeAnyFrame(msg);
}

/**
 * The frame decoder, yielding pty-host messages. A subclass rather than an
 * alias so `new FrameDecoder()` keeps returning `Frame[]` for existing callers;
 * the behaviour (partial reads, skipped corrupt frames, the `MAX_FRAME` desync)
 * is entirely the base class's.
 */
export class FrameDecoder extends AnyFrameDecoder<Frame> {}
