# Pi Extensions

Personal extensions for [Pi coding agent](https://github.com/earendil-works/pi).

Every package is published to npm and can also be installed from GitHub. A git source points at the repository, not a subdirectory, so one git install adds every extension this monorepo ships — pick the ones you want with `pi config`, or narrow the package entry in `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/kvoon3/pi-extensions",
  "extensions": ["pi-minimal-footer/index.ts", "pi-split-fork/index.ts"]
}
```

## Packages

### `pi-split-fork`

Forks the current Pi session into a new Pi agent in a right or downward Herdr pane.

**npm**

```bash
pi install npm:@kvoon/pi-split-fork
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

### `pi-minimal-footer`

Minimal footer with context gauge, model info, and subscription usage bars. Supports Claude Max, Codex, Copilot, Gemini, MiniMax, Kimi Coding, CommandCode, WorkBuddy, OpenRouter, xAI (Grok).

**npm**

```bash
pi install npm:@kvoon/pi-minimal-footer
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

### `pi-kitty-notify`

Sends a notification when Pi finishes a response, with a plain-text preview of the last reply. Uses Herdr's notification API inside Herdr, or OSC 99 directly in kitty.

**npm**

```bash
pi install npm:@kvoon/pi-kitty-notify
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

See [setup and behavior](./pi-kitty-notify/README.md).

### `pi-windows-system-theme`

Syncs Pi's theme with Windows system app mode (light/dark), event-driven via `RegNotifyChangeKeyValue`. Fixes dark tool/user-message blocks in herdr where OSC 11 / DSR 996 detection times out.

**npm**

```bash
pi install npm:@kvoon/pi-windows-system-theme
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

### `pi-recent-models`

Recency-first model selector: `ctrl+l` (replaces the built-in `/model` selector) or `/model-recent` lists recently-used models first, then the rest of the catalogue. History is recorded from model changes into `~/.pi/agent/recent-models.json`.

**npm**

```bash
pi install npm:@kvoon/pi-recent-models
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

### `pi-workbuddy`

Registers a shared [workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) gateway as a Pi provider, with a live model catalog and a 0600 on-disk cache for offline starts. Credentials come from Pi's own `/login` — the extension never touches the API key. Model catalog only; the credits balance is shown by `pi-minimal-footer` from the gateway's `GET /v1/usage`.

**npm**

```bash
pi install npm:@kvoon/pi-workbuddy
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

See [setup and behavior](./pi-workbuddy/README.md).

### `pi-voice`

Voice dictation for Pi using a configurable speech-to-text service. Audio is sent to the configured endpoint; credentials and service settings can be supplied in a private file under `~/.pi/agent/` or through environment variables.

**npm**

```bash
pi install npm:@kvoon/pi-voice
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

See [setup and usage](./pi-voice/README.md).
