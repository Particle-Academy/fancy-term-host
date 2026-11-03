/**
 * `@particle-academy/fancy-term-host/electron` — Electron packaging helpers.
 *
 * A subpath so server / web consumers never pull in the desktop packaging code.
 * The headline export is {@link fancyTermAfterPack}, an electron-builder
 * `afterPack` hook that checks a packaged app can start a terminal on Windows /
 * macOS / Linux (see after-pack.ts / docs/packaging.md). (#7)
 */

export {
    fancyTermAfterPack,
    nodeAfterPackIo,
    resolveFancyPtyDir,
    resolveNodePtyDir,
} from './after-pack';
export type {
    AfterPackContext,
    AfterPackOptions,
    AfterPackResult,
    AfterPackAction,
    AfterPackIo,
} from './after-pack';
