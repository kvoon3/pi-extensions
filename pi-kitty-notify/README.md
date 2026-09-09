# @kvoon/pi-kitty-notify

Sends a notification through Herdr or kitty when Pi finishes a response, using the last assistant reply as a plain-text preview (up to 200 Unicode code points). Empty replies show “Ready for input”. Failed and aborted responses are skipped, including failures that Pi will retry. Final failures also do not trigger notifications.

## Try locally

From this repository, run Pi in Herdr or kitty:

```bash
pi -e ./pi-kitty-notify/index.ts
```

Or install the local package:

```bash
pi install /absolute/path/to/pi-extensions/pi-kitty-notify
```

## Behavior

- Runs only in Pi's interactive TUI with a TTY.
- Inside Herdr (`HERDR_ENV=1`), calls `herdr notification show` using the installed `herdr` CLI. Delivery follows Herdr's `[ui.toast]` configuration, independently of the pane's terminal environment. Failures are reported as a Pi UI warning.
- Outside Herdr, uses kitty's [OSC 99 desktop notification protocol](https://sw.kovidgoyal.net/kitty/desktop-notifications/) when `TERM=xterm-kitty` or `KITTY_WINDOW_ID` is set. No remote-control setup is needed.
- For direct kitty notifications, clicking focuses the originating kitty window, and each Pi process updates its previous notification. Herdr notifications follow Herdr's delivery behavior.
- Markdown, hyperlinks, and terminal control sequences are cleaned up before sending the preview. Payloads are base64 encoded.
- Direct kitty notifications are sent whether kitty is focused or not; display and sound depend on kitty and OS notification settings. tmux passthrough is not supported.

## Herdr delivery

Herdr supports in-app (`herdr`), outer-terminal (`terminal`), OS (`system`), or disabled (`off`) notification delivery. To use the outer terminal's notifications, set this in your Herdr configuration:

```toml
[ui.toast]
delivery = "terminal"
```

The extension does not change your Herdr configuration. See [Herdr notification configuration](https://herdr.dev/docs/configuration/#notifications).

## Credits

Adapted from [Armin Ronacher's notify.ts](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/notify.ts), licensed under Apache-2.0. This version replaces OSC 777 with kitty OSC 99 and adds Herdr delivery, terminal/retry guards, and Unicode-safe truncation.
