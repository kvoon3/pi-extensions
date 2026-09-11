# @kvoon/pi-workbuddy

[WorkBuddy](https://github.com/Sliverkiss/workbuddy2api) provider for [pi](https://github.com/earendil-works/pi).

The gateway is a **shared service on the LAN** — this extension only registers it as a provider and keeps its model catalog live. It does not start, stop, or manage the gateway, and it never reads or stores the API key itself.

## Quick start

```text
/login          → pick "WorkBuddy" → paste the gateway API key
```

That's the whole setup. The key is stored by pi in `~/.pi/agent/auth.json`, and the model catalog is fetched immediately, so models are available without a restart. `/logout` removes it.

## What it does

- **Provider registration** — `workbuddy` pointed at the gateway, with `authHeader` so pi sends `Authorization: Bearer <key>`.
- **Login via pi** — no custom auth code. Registering without an `oauth` block makes pi's own `/login` offer a "WorkBuddy" entry that prompts for the key.
- **Live model catalog** — fetches `/v1/models` before initial model selection, so cold starts and `--list-models` see real models.
- **Thinking levels from the gateway** — maps the gateway's `reasoning_efforts` onto pi thinking levels, so new models come with correct levels instead of hand-maintained overrides.
- **Refresh after login** — pi re-syncs credentials with network access disabled, which would leave the list empty right after logging in. This extension detects a credential and fetches anyway, so logging in is enough to get models.
- **Cached fallback** — snapshots to `<agentDir>/workbuddy-models-cache.json` (mode 0600). An unreachable gateway falls back to the cache instead of leaving you with zero models.
- **`/workbuddy-refresh`** — force a model refresh.

## Configuration

Optional environment variables:

| Variable              | Default                          | Purpose                                        |
| --------------------- | -------------------------------- | ---------------------------------------------- |
| `WORKBUDDY_BASE_URL`  | `http://192.168.1.13:7863/v1`    | Point at a different gateway host or port      |
| `WORKBUDDY_API_KEY`   | —                                | Supply the key without `/login` (scripts, CI)  |
| `PI_OFFLINE`          | —                                | Skip all network work; cached models only      |

## Model overrides

Reasoning levels are derived automatically. The gateway reports each model's
supported thinking levels in `/v1/models` as `reasoning_efforts`, and the
extension maps them onto pi's thinking levels (the two vocabularies are
identical, so no conversion table is needed). When the gateway adds or removes
a model, its levels follow automatically — nothing to maintain here.

A model is treated as non-reasoning when the gateway reports no efforts, or
only `off`. That is deliberate: an unreported list means "not reported", not
"does not support thinking".

`models.json` `modelOverrides` still works and takes precedence, so you can
pin a model's levels by hand if the gateway's list ever needs overriding:

```json
{
  "providers": {
    "workbuddy": {
      "modelOverrides": {
        "hy3": { "reasoning": true, "thinkingLevelMap": { "low": "low", "high": "high" } }
      }
    }
  }
}
```

No `baseUrl` or `apiKey` is needed there — the extension supplies both.

## Behavior notes

- Model IDs and token limits come from the gateway; invalid or duplicate IDs fail loudly rather than registering a broken catalog.
- A failed refresh keeps the previous catalog, so a transient gateway outage never empties your model list.
- Without a stored key, startup logs one line explaining that `/login` is needed — it does not spam 401s.

## Credits / usage

Balance display lives in [`@kvoon/pi-minimal-footer`](../pi-minimal-footer), which reads the gateway's `GET /v1/usage` and shows the pool's credits in `/usage` and in the footer. This package handles the model catalog only.

## Install

```bash
pi install npm:@kvoon/pi-workbuddy
```

Or via git (this repo):

```json
{
  "source": "git:github.com/kvoon3/pi-extensions",
  "extensions": ["pi-workbuddy/index.ts"]
}
```
