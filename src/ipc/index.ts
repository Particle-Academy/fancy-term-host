/**
 * `@particle-academy/fancy-term-host/ipc` — the local IPC transport, with no
 * native dependency.
 *
 * The length-prefixed JSON framing and the per-user pipe/socket and pidfile
 * helpers the pty-host runs on, for a SECOND per-user background process that
 * must ship without node-pty (#12). Same code the pty-host uses, not a copy:
 * `host-protocol.ts` narrows this codec to its own messages.
 *
 * Nothing reachable from this file may import node-pty or electron. A test
 * builds the package and checks the output, because the root entry's source was
 * pure too and its bundle still opened with a node-pty import.
 */

export { encodeFrame, FrameDecoder, MAX_FRAME } from './frame';

export {
    DEFAULT_HOST_NAME,
    socketPathFor,
    pidfilePath,
    writePidfile,
    readPidfile,
    deletePidfile,
    pidfileUsable,
    isPidAlive,
    terminateHost,
    awaitPidGone,
    userHash,
} from '../host-locate';
export type { Pidfile } from '../host-locate';
