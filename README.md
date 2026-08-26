# Pi Extensions

Personal extensions for [Pi coding agent](https://github.com/earendil-works/pi).

## Packages

### `pi-split-fork`

Forks the current Pi session into a new Pi agent in a right or downward Herdr pane.

```bash
pi install npm:@kvoon/pi-split-fork
```

### `pi-minimal-footer`

Minimal footer with context gauge, model info, and subscription usage bars. Supports Claude Max, Codex, Copilot, Gemini, MiniMax, Kimi Coding, CommandCode, OpenRouter.

```bash
pi install npm:@kvoon/pi-minimal-footer
```

### `pi-macos-notify`

Sends a macOS notification at the end of each Pi session with a summary: turn count, tools used, errors, token usage, cost, and duration.

```bash
pi install npm:@kvoon/pi-macos-notify
```

### `pi-windows-system-theme`

Syncs Pi's theme with Windows system app mode (light/dark), event-driven via `RegNotifyChangeKeyValue`. Fixes dark tool/user-message blocks in herdr where OSC 11 / DSR 996 detection times out.

```bash
pi install npm:@kvoon/pi-windows-system-theme
```
