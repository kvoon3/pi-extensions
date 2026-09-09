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

### `pi-kitty-notify`

Sends a notification when Pi finishes a response, with a plain-text preview of the last reply. Uses Herdr's notification API inside Herdr, or OSC 99 directly in kitty.

```bash
pi -e ./pi-kitty-notify/index.ts
```

See [setup and behavior](./pi-kitty-notify/README.md).

### `pi-windows-system-theme`

Syncs Pi's theme with Windows system app mode (light/dark), event-driven via `RegNotifyChangeKeyValue`. Fixes dark tool/user-message blocks in herdr where OSC 11 / DSR 996 detection times out.

```bash
pi install npm:@kvoon/pi-windows-system-theme
```
