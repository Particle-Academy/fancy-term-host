/**
 * `windowsVerbatimArguments`, the rules shared by both backends.
 *
 * Pure: no node-pty, no net, so both ends of the host protocol can import it.
 *
 * THE FAILURE THIS FILE GUARDS AGAINST IS SILENCE. Every layer below the public
 * option has a way to not hear it: an injected engine that takes no such option,
 * an older pty-host that ignores an unknown field. Either one quotes the line
 * anyway and `cmd.exe` then reports a program named `\"C:\...\"`, which reads as
 * the caller's quoting being wrong. So a layer that cannot honour the flag on
 * Windows refuses the spawn and says who could not.
 */

/** Refuse a spawn the named layer could not carry out as asked. */
export function checkVerbatimOption(
    value: unknown,
    honoured: boolean,
    who: string,
    platform: string = process.platform,
): void {
    if (value === undefined || value === false) return;
    if (value !== true) {
        // As fancy-pty does. A truthy string must not switch off all quoting.
        throw new TypeError(`windowsVerbatimArguments must be a boolean, got ${typeof value}`);
    }
    // On POSIX `argv` goes straight to exec and there is no line to get wrong, so
    // every layer honours it by doing nothing.
    if (platform === 'win32' && !honoured) {
        throw new Error(
            `${who} cannot honour windowsVerbatimArguments. The line would be quoted and cmd.exe would not run it, so nothing was spawned.`,
        );
    }
}

/**
 * The `args` to give node-pty, which the detached host still runs on.
 *
 * node-pty has no option of this name and does not need one: on Windows a STRING
 * `args` is the rest of the command line, used as is, with only the program quoted
 * if it has whitespace (`argsToCommandLine` in its windowsPtyAgent). That is
 * exactly what fancy-pty's flag does. On POSIX it throws on a string, so the list
 * stays a list there.
 */
export function nodePtyArgs(
    args: string[],
    verbatim: boolean | undefined,
    platform: string = process.platform,
): string[] | string {
    return verbatim === true && platform === 'win32' ? args.join(' ') : args;
}
