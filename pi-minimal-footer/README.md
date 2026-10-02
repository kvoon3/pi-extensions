# @kvoon/pi-minimal-footer

Minimal footer for [pi](https://github.com/earendil-works/pi) that replaces the default footer with a compact display: context gauge, model info, and subscription usage bars.

Forked from `@ogulcancelik/pi-minimal-footer` with more providers support.

## Features

- **Context gauge** — working directory, git branch, model, thinking level, context window usage with token counts
- **Subscription usage bars** — rolling window quotas with reset timers for supported providers
- **`/usage` command** — print usage for all configured providers in the UI without adding messages to the session or model context
- **CommandCode support** — balance display ($3.05/$10) + rate limits (5h, weekly)
- **WorkBuddy support** — gateway pool credits (remain/size + healthy account count) from a local [workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) gateway
- **OpenRouter support** — remaining pay-as-you-go balance from your OAuth-minted or API key
- **Auto-refresh** — fetches usage on startup and model switch, then every 5 minutes
- **Git integration** — branch name, dirty state, ahead/behind counts
- **GitHub account** — the active `gh` CLI account (`gh:kvoon3`), read from `gh`'s own config so it follows `gh auth switch`; resolved per host, so a GHE remote shows that host's account
- **`/gh` command + `alt+g` shortcut** — open an account list (active first) and switch the active GitHub account, like the model picker does for models

## Supported providers

| Provider       | What it shows                                          |
| -------------- | ------------------------------------------------------ |
| CommandCode    | Balance ($spent/$total) + 5h + weekly rolling windows  |
| Claude Max     | 5h + weekly rolling windows                            |
| OpenAI Codex   | Primary + secondary rolling windows                    |
| GitHub Copilot | Premium interactions + chat quotas                     |
| Google Gemini  | Pro + Flash remaining quotas                           |
| MiniMax        | 5h + weekly rolling windows (Token Plan, credit-based)  |
| Kimi Coding    | 5h + weekly rolling windows (Plan)                     |
| GLM Coding CN  | 5h + weekly rolling windows (Zhipu bigmodel.cn)        |
| OpenCode Go    | 5h + weekly rolling windows (local cost accounting)   |
| OpenCode Zen   | Pay-per-use spend, last 30 days (local cost accounting) |
| WorkBuddy      | Gateway pool credits (remain/size + healthy accounts)  |
| OpenRouter     | Remaining credit balance ($X.XX left)                  |
| xAI (Grok)     | Weekly/monthly allowance + on-demand + prepaid balance |

## Install

**npm**

```bash
pi install npm:@kvoon/pi-minimal-footer
```

**GitHub**

```bash
pi install git:github.com/kvoon3/pi-extensions
```

A git source points at the repository, not a subdirectory, so the git install adds every extension this monorepo ships. Select this one with `pi config`, or narrow the entry in `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/kvoon3/pi-extensions",
  "extensions": ["pi-minimal-footer/index.ts"]
}
```

The badge only reads `gh`'s config file, so it works without the `gh` binary. Switching accounts with `/gh` needs `gh` on `PATH` (`mise use -g gh@latest`); without it the extension still renders the badge and `/gh` reports that gh is missing.

## Switch GitHub account

```text
/gh            Open the account list (active first) and switch
/gh kvoon9     Switch to an account directly (case-insensitive)
/gh --help     Show usage and the accounts known to gh
```

The `alt+g` shortcut opens the same list. Accounts come from gh's own config (`hosts.yml`) for the host the current repo targets — the `origin` remote host, otherwise `github.com` — so the list matches `gh auth status`. Switching runs `gh auth switch --hostname <host> --user <user>`; it does not log in and does not touch tokens. The active account is what gh's git credential helper hands to `git push`, and the footer badge updates as soon as the switch succeeds. Picking the already-active account, cancelling the list, or an unknown account never runs `gh`. Failures (gh missing, not logged in) surface as one error notification. Like `/usage`, the command appends nothing to the session or model context.

## Usage command

```text
/usage          Show all configured providers
/usage codex    Show one provider (pi provider names also accepted)
/usage --all    Include providers without credentials or local data
/usage --help   List supported provider IDs
```

Results appear as a UI notification in interactive pi. Neither the report nor a model-facing message is appended to the session, so the report is not restored when reopening a session. No model request is made. The command queries providers concurrently and displays errors per provider. Repeated calls while a query is running do not start another query.

Each provider occupies one table row, with each quota window in a separate aligned column beside its balance or spending. Column headers name the window (e.g. `5h Reset`, `Week Reset`); the value shows a progress bar, the used percentage, and the time until reset. Usage is colored green below 70%, yellow from 70%, and red from 90%. Narrow panes omit progress bars and truncate long cells; query a single provider or widen the pane for more detail.

OpenCode Go and Zen have no usage API, so their numbers are local estimates: they count only pi session costs, not account-wide usage. Zen covers the last 30 days. Go uses the footer's $12/5h and $30/calendar-week limits. Expired credentials must be renewed through the corresponding client; `/usage` does not log in or refresh tokens.

WorkBuddy credits come from the gateway's `GET /v1/usage`. The key is read from `~/.pi/agent/auth.json` — the same credential `/login` stores — so there is no second place to configure, and the endpoint defaults to the LAN gateway (`WORKBUDDY_BASE_URL` overrides it, `WORKBUDDY_API_KEY` supplies the key without `/login`). Without a stored key the row is omitted rather than reporting 401s. Credits render with a `$` prefix (`$1090 / $1100` in the Balance column, a plain `$1090/$1100` segment in the footer; no bar, no reset — it is a balance, not a rolling window). A multi-account pool shows `· 2/3 accounts` when some accounts fail to report. Requires [pi-workbuddy](../pi-workbuddy) for the model catalog.

xAI (Grok) usage comes from the same unofficial consumer-billing endpoints Grok Build uses (`cli-chat-proxy.grok.com`): identity first, then billing with the account id in the `x-userid` header. The credential is the SuperGrok / X Premium OAuth token stored by `/login xai` — plain API keys have no consumer billing, so those accounts stay hidden (Not configured) rather than erroring. The main window is the included allowance for the current weekly or monthly period (live `creditUsagePercent`, falling back to used/limit credits); unified-billing accounts that report no percentage still show the period bar with its reset time. On-demand overage and prepaid credits appear when the account has them.

## Configuration

Environment variables (all optional):

| Variable                        | Description                                              | Default |
| ------------------------------- | -------------------------------------------------------- | ------- |
| `PI_MINIMAL_FOOTER_SHOW_CWD`    | Show current working directory in footer status line     | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_BRANCH` | Show git branch/dirty/ahead/behind in footer status line | `1`     |
| `PI_MINIMAL_FOOTER_SHOW_GITHUB` | Show active GitHub account (`gh:<user>`) in footer status line | `1`     |

Accepted false values: `0`, `false`, `no`, `off` (case-insensitive).

## How it works

Provider authentication and usage queries live in `usage.ts`, shared by the footer and `/usage` command.

The footer reads context usage from the last assistant message's token counts (free — comes with every LLM response). Subscription usage is fetched from each provider's dedicated quota API using your existing auth tokens from `~/.pi/agent/auth.json` or environment variables.

Usage is fetched:

- Once on startup
- Immediately on model switch (Ctrl+P)
- Every 5 minutes after that

Git state is refreshed:

- Once on startup
- When pi reports a branch change
- At the end of each turn

The GitHub account is refreshed on the same schedule, plus immediately after `/gh` switches accounts. It reads the active account for the remote's host from `gh`'s `hosts.yml` (`$GH_CONFIG_DIR`, `~/.config/gh`, or `%APPDATA%\GitHub CLI` on Windows) and the `origin` remote URL — no `gh` call and no network request. Switching accounts with `gh auth switch` outside the extension shows up in the footer at the end of the next turn. Narrow terminals stack lines vertically instead of using the single-line wide layout.

## Known issues

### Claude Max usage bar not showing

Anthropic's OAuth usage endpoint (`/api/oauth/usage`) has been returning persistent 429 (rate limit) errors since late March 2026, affecting all third-party tools that display Claude usage data (CodexBar, oh-my-claudecode, claude-pulse, etc.). This is an Anthropic-side issue — tracked in [claude-code#30930](https://github.com/anthropics/claude-code/issues/30930) and [claude-code#31021](https://github.com/anthropics/claude-code/issues/31021). The usage bar will start working again once Anthropic fixes the endpoint.

## Notes

- Replaces the default pi footer entirely via `ctx.ui.setFooter()`
- Auth tokens are read from `~/.pi/agent/auth.json` (populated by `/login`) or standard env vars (`ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, etc.)
- WorkBuddy uses the same path: the key stored by `/login`, never a copy in `models.json`
- Providers without auth simply don't show a usage bar — no errors
