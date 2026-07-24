# Pi Extensions

Personal extensions for [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Packages

### `pi-minimal-footer`

Minimal footer with context gauge, model info, and subscription usage bars. Supports CommandCode, Claude Max, Codex, Copilot, Gemini, MiniMax, Kimi Coding.

```bash
pi install npm:@kvoon/pi-minimal-footer
```

## Extensions

### `macos-notify.ts`

Sends a macOS notification at the end of each Pi session with a summary: turn count, tools used, errors, token usage, cost, and duration. Uses `osascript` `display notification`.

**Installation**: copy to `~/.pi/agent/extensions/`.
