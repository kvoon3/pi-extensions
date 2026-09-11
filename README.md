# Pi Extensions

Personal extensions for [Pi coding agent](https://github.com/earendil-works/pi).

## Packages

### `pi-split-fork`

Forks the current Pi session into a new Pi agent in a right or downward Herdr pane.

```bash
pi install npm:@kvoon/pi-split-fork
```

### `pi-minimal-footer`

Minimal footer with context gauge, model info, and subscription usage bars. Supports Claude Max, Codex, Copilot, Gemini, MiniMax, Kimi Coding, CommandCode, WorkBuddy, OpenRouter.

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

### `pi-workbuddy`

Registers a shared [workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) gateway as a Pi provider, with a live model catalog and a 0600 on-disk cache for offline starts. Credentials come from Pi's own `/login` — the extension never touches the API key. Model catalog only; the credits balance is shown by `pi-minimal-footer` from the gateway's `GET /v1/usage`.

```bash
pi install npm:@kvoon/pi-workbuddy
```

See [setup and behavior](./pi-workbuddy/README.md).
