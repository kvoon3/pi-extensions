# @kvoon/pi-split-fork

Fork the current Pi session into a new Pi agent in a Herdr pane, tab, or workspace.

## Requirements

- `herdr` available on `PATH`
- Pi running inside Herdr

## Install

```bash
pi install npm:@kvoon/pi-split-fork
```

Or from this repository:

```bash
pi install ./pi-split-fork
```

## Usage

```text
/split-fork
/split-fork down
/split-fork right Continue by implementing the tests
/split-fork tab Continue by implementing the tests
/split-fork workspace Continue by implementing the tests
/split-fork Continue by implementing the tests
```

The split defaults to `right`. The target is only recognized as the first argument; everything else is sent as the prompt. Type the target prefix and press Tab to complete it.

| Target | Result |
| --- | --- |
| `right` | Split beside the current pane (default) |
| `down` | Split below the current pane |
| `tab` | Create a new Herdr tab and fork into its root pane |
| `workspace` | Create a new Herdr workspace and fork into its root pane |

The fork copies the current active session branch. If the original agent is busy, only entries already committed to the session are copied.
