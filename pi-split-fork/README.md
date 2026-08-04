# @kvoon/pi-split-fork

Fork the current Pi session into a new Pi agent in a Herdr pane.

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
/split-fork Continue by implementing the tests
```

The split defaults to `right`. The direction is only recognized as the first argument; everything else is sent as the prompt. Type the direction prefix and press Tab to complete it.

The fork copies the current active session branch. If the original agent is busy, only entries already committed to the session are copied.
