/**
 * `/gh` command + `alt+g` shortcut — switch the active GitHub account.
 *
 * Mirrors `gh auth switch`: shows the accounts authenticated for the host the
 * current repo targets (active first) in a selector, then runs
 * `gh auth switch --hostname <host> --user <user>`. The footer badge refreshes
 * through the `onSwitched` callback.
 *
 * Like `/usage`, this never appends a message to the session or model context.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ghHostsPaths, readGhHostsText, readOriginRemoteUrl, resolveHostAccounts } from "./github.js";

export const GITHUB_ACCOUNT_SHORTCUT = "alt+g";

interface SwitchResult {
  ok: boolean;
  message: string;
}

/** Keep error output to one readable line; gh errors can be multi-line usage dumps. */
function firstLine(text: string, fallback: string): string {
  const line = text.trim().split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** A missing gh terminates with code 1 and no output, so point at mise instead
 *  of showing a bare "exit code 1". */
function describeGhFailure(result: { code: number; stderr: string; stdout: string }): string {
  const detail = firstLine(result.stderr || result.stdout, "");
  if (detail) return detail;
  return `gh exited with code ${result.code} — is the GitHub CLI installed? (mise use -g gh@latest)`;
}

export function registerGitHubAccountCommand(
  pi: ExtensionAPI,
  options: { onSwitched?: () => void } = {}
): void {
  let switching = false;

  /** Non-blocking: pi.exec spawns gh without freezing the TUI. */
  async function runSwitch(host: string, user: string, ui: ExtensionUIContext): Promise<void> {
    if (switching) {
      ui.notify("A GitHub account switch is already in progress.", "info");
      return;
    }
    switching = true;
    try {
      let result: SwitchResult;
      try {
        const exec = await pi.exec("gh", ["auth", "switch", "--hostname", host, "--user", user], { timeout: 15_000 });
        result = exec.killed
          ? { ok: false, message: "timed out" }
          : { ok: exec.code === 0, message: exec.code === 0 ? "" : describeGhFailure(exec) };
      } catch (error) {
        // Defensive: pi.exec resolves rather than rejects today, but never crash the command.
        result = { ok: false, message: firstLine(error instanceof Error ? error.message : String(error), "could not run gh") };
      }

      if (!result.ok) {
        ui.notify(`gh auth switch failed: ${result.message}`, "error");
        return;
      }
      options.onSwitched?.();
      ui.notify(`Active GitHub account: ${user} (${host})`, "info");
    } finally {
      switching = false;
    }
  }

  function helpText(): string {
    const { host, active, accounts } = resolveHostAccounts(readGhHostsText(), readOriginRemoteUrl());
    const list = accounts.map((name) => (name === active ? `${name} (active)` : name)).join(", ");
    return [
      `Usage: /gh [username]   (shortcut ${GITHUB_ACCOUNT_SHORTCUT})`,
      `Switches the active GitHub account for ${host} via gh auth switch.`,
      list ? `Accounts: ${list}` : `No accounts found in ${ghHostsPaths().join(" or ")}.`,
    ].join("\n");
  }

  async function pickAccount(ui: ExtensionUIContext, cwd: string): Promise<void> {
    const { host, active, accounts } = resolveHostAccounts(readGhHostsText(), readOriginRemoteUrl(cwd));
    if (!accounts.length) {
      ui.notify(`No GitHub accounts in gh config (${ghHostsPaths().join(" or ")})`, "warning");
      return;
    }

    const labels = accounts.map((name) => (name === active ? `${name} (active)` : name));
    const choice = await ui.select(`GitHub account · ${host}`, labels);
    if (choice === undefined) return; // cancelled

    const index = labels.indexOf(choice);
    const user = index >= 0 ? accounts[index] : choice;
    if (user === active) {
      ui.notify(`Already using ${user} on ${host}.`, "info");
      return;
    }
    await runSwitch(host, user, ui);
  }

  pi.registerCommand("gh", {
    description: `Switch the active GitHub account. /gh [username] (shortcut ${GITHUB_ACCOUNT_SHORTCUT})`,
    getArgumentCompletions: (prefix) => {
      const { accounts } = resolveHostAccounts(readGhHostsText(), readOriginRemoteUrl());
      const items = accounts
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
      const help = "--help".startsWith(prefix) ? [{ value: "--help", label: "--help" }] : [];
      const all = [...help, ...items];
      return all.length ? all : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const input = args.trim();

      if (input === "--help" || input === "help") {
        ctx.ui.notify(helpText(), "info");
        return;
      }

      if (!input) {
        await pickAccount(ctx.ui, ctx.cwd);
        return;
      }

      const { host, active, accounts } = resolveHostAccounts(readGhHostsText(), readOriginRemoteUrl(ctx.cwd));
      const user = accounts.find((name) => name.toLowerCase() === input.toLowerCase());
      if (!user) {
        ctx.ui.notify(`Unknown GitHub account: ${input}\n\n${helpText()}`, "warning");
        return;
      }
      if (user === active) {
        ctx.ui.notify(`Already using ${user} on ${host}.`, "info");
        return;
      }
      await runSwitch(host, user, ctx.ui);
    },
  });

  pi.registerShortcut(GITHUB_ACCOUNT_SHORTCUT, {
    description: "Switch GitHub account",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await pickAccount(ctx.ui, ctx.cwd);
    },
  });
}
