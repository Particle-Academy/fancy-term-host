# Changelog

Notable changes to `@particle-academy/fancy-term-host`.

**BREAKING** marks anything that can stop working on upgrade. This package is
pre-1.0, so breaking changes land in MINOR releases — read those entries before
upgrading.

> Entries below **1.0** were reconstructed from git history when this file was
> introduced, so they summarise commit subjects rather than consumer impact.
> Everything from the next release onward is written by hand, in the same commit
> as the change.

---

## [Unreleased]

## 0.3.1 — 2026-07-15

### Fixed

- **electron:** afterPack picks conpty.dll by target arch (#9)

## 0.3.0 — 2026-07-15

### Added

- **electron:** ship an afterPack node-pty packaging fix (#7)

### Fixed

- **host:** reap a wedged/stale pty-host so a fresh one reclaims the pipe (#8)
- **shells:** real macOS login shell + full zsh startup chain (#5, #6)

## 0.2.3 — 2026-06-29

### Fixed

- **pty-host:** set useConptyDll on the DETACHED host spawn (closes #4)

## 0.2.2 — 2026-06-29

### Changed

- Set $TERM via node-pty `name` so the pty advertises Ms (OSC 52 clipboard)

## 0.2.1 — 2026-06-28

### Changed

- Use node-pty bundled ConPTY (useConptyDll) to stop stray console windows

## 0.2.0 — 2026-06-14

### Added

- run the pty-host as a per-user OS service (#2)

## 0.1.2 — 2026-06-14

### Added

- **host:** graceful shutdownHost() — clean detached-host teardown (#2)

## 0.1.1 — 2026-06-14

### Fixed

- native-convert + validate spawn cwd (Git Bash MSYS path → Windows 267)

## 0.1.0 — 2026-06-14

### Added

- initial release — headless Node terminal backend for fancy-term
