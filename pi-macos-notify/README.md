# @kvoon/pi-macos-notify

Sends a macOS notification at the end of each Pi session with a summary: turn count, tools used, errors, token usage, cost, and duration.

## Install

```bash
pi install npm:@kvoon/pi-macos-notify
```

## Notification format

```
Pi — 3 turns · 12 tools · 45k tokens · $0.1234 · 2m30s ✓
```

With errors:

```
Pi — ⚠️ 3 turns · 12 tools · 2 errors · 45k tokens · 2m30s
```

Transient errors that Pi's auto-retry recovers from do not trigger a notification — the notification fires once, after the final settled outcome.
