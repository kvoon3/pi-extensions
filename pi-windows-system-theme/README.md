# pi-windows-system-theme

Sync [Pi](https://github.com/earendil-works/pi)'s theme with the Windows system app mode (light/dark).

## Why

Pi's `"theme": "light/dark"` auto-detection queries the terminal via DSR 996 / OSC 11. Terminal multiplexers such as **herdr** don't forward those queries to the outer terminal, so detection times out and Pi falls back to `"dark"` — dark tool/user-message blocks appear while the rest of the UI follows the terminal's light colors.

## How

Spawns a PowerShell watcher that uses the Win32 `RegNotifyChangeKeyValue` API to block until the `Personalize` registry key changes — **pure event-driven, no polling** (no WMI/WQL dependency, which is broken on some installs and forces `herdr-theme`'s watcher into a 10s poll fallback).

Each line the watcher prints is the new mode (`"light"` / `"dark"`), the first being the initial sync. The matching side of the configured light/dark theme pair is applied as a `Theme` instance (in-memory only), so the `"light/dark"` pair setting in `settings.json` is preserved.

## Install

```bash
pi install npm:@kvoon/pi-windows-system-theme
```

Requires PowerShell 7+ (`pwsh`) on `PATH`.

## Platform

Windows only. The factory returns without subscribing on any other platform, and the package declares `"os": ["win32"]` so npm skips it elsewhere.
