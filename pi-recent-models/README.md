# @kvoon/pi-recent-models

Recency-first model selector for [Pi](https://github.com/earendil-works/pi).

The built-in `/model` selector sorts by current model → default model → provider.
This extension adds a second selector that puts **recently used models first**:

- `ctrl+l` — opens it, replacing the built-in model selector
- `/model-recent` — same selector via command
- Type to fuzzy-filter, `↑`/`↓` to navigate, `enter` to switch, `esc` to cancel
- `ctrl+d` — remove the highlighted model from the recent list (it stays in the
  catalogue under `── other ──`; picking it again re-adds it to recents)

`ctrl+l` is intercepted by replacing the editor component with a `CustomEditor`
subclass that sees raw input before the app keybinding pipeline (`app.model.select`
is a reserved binding that extension shortcuts cannot override).

The list shows models you have actually used (across all sessions, recorded from
model changes) at the top under `── recent ──`, then the rest of the catalogue
under `── other ──`. The current model is marked with `✓`.

## Install

**npm**

```bash
pi install npm:@kvoon/pi-recent-models
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

A git source points at the repository, not a subdirectory, so the git install adds every extension this monorepo ships. Select this one with `pi config`, or narrow the entry in `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/kvoon3/pi-extensions",
  "extensions": ["pi-recent-models/index.ts"]
}
```

## Settings

History lives in `~/.pi/agent/recent-models.json` (last 50 distinct models, most
recent first). Delete the file to reset.
