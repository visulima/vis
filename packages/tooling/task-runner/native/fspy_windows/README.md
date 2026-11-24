# fspy_windows

**Status: WIP scaffold.** Windows file-access tracker via Microsoft Detours.

This crate exists so the work has a home and so the module boundaries match the design before any Detours code lands. Nothing here actually hooks anything today — `lib::track_command` errors `Unsupported`, `DllMain` is a no-op stub, and the production runner keeps using its existing fallback in `src/file-access-tracker.ts`.

See [`../../rfc/design-fspy-windows-detours.md`](../../rfc/design-fspy-windows-detours.md) for the full design (IAT hook surface, named-pipe IPC, ARM64 considerations, EDR caveats, MSVC build wiring).

## Module map

| File           | What goes here                                                  |
| -------------- | --------------------------------------------------------------- |
| `src/lib.rs`   | Public NAPI surface (`track_command`, types) + `DllMain`        |
| `src/hooks.rs` | One install / uninstall fn per Windows API hook                 |
| `src/pipe.rs`  | Named-pipe IPC (parent supervisor + DLL sender)                 |
| `src/path.rs`  | `\\?\` / `\\.\` prefix stripping; supervisor-side normalization |
| `src/pe.rs`    | Bounds-checked import-table reader over a mapped PE32+ image    |

## Why not Linux

`hooks.rs`, `pipe.rs` and `DllMain` are `cfg(windows)`-gated; `path.rs` and `pe.rs` are pure logic and their unit tests (`cargo test`) run on any host. Everything that touches Win32 needs an MSVC toolchain + a Windows run.
