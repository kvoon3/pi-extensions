import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fetchUsageForProvider, PROVIDER_MAP, type RateWindow, type UsageSnapshot } from "./usage.js";

const providers = [...new Set(Object.values(PROVIDER_MAP))];
const help = "Usage: /usage [provider | --all]\nProviders: " + providers.join(", ");

export function registerUsageCommand(pi: ExtensionAPI): void {
  let running = false;
  pi.registerCommand("usage", {
    description: "Show provider usage without adding it to the session. /usage [provider | --all]",
    getArgumentCompletions: (prefix) => {
      const names = [...new Set(["--all", ...providers, ...Object.keys(PROVIDER_MAP)])];
      const items = names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const input = args.trim();
      if (input === "--help" || input === "help") {
        ctx.ui.notify(help, "info");
        return;
      }
      const id = PROVIDER_MAP[input] ?? input;
      const all = input === "--all";
      if (input && !all && !providers.includes(id)) {
        ctx.ui.notify(help, "warning");
        return;
      }
      if (running) {
        ctx.ui.notify("Usage query already in progress.", "info");
        return;
      }
      running = true;
      ctx.ui.setStatus("usage", "Checking provider usage…");
      try {
        const selected = input && !all ? [id] : providers;
        const results = await Promise.all(selected.map(queryProvider));
        const visible = results.filter((result) => input || result.error !== "no-auth");
        // UI notification only: never sendMessage, sendUserMessage, or appendEntry.
        ctx.ui.notify(formatTable(visible, ctx.ui.theme, (process.stdout.columns ?? 120) - 4), "info");
      } finally {
        running = false;
        ctx.ui.setStatus("usage", undefined);
      }
    },
  });
}

interface Result extends UsageSnapshot { id: string }

// Do not expose raw exceptions, which can contain URLs or credential-helper output.
function safeError(error: string): string {
  if (/^HTTP \d{3}(\/\d{3})?$/.test(error)) return error;
  if (["no-auth", "no-usage-data", "unknown-provider"].includes(error)) return error;
  if (/abort|timeout/i.test(error)) return "timeout";
  return "query-failed";
}

async function queryProvider(id: string): Promise<Result> {
  try {
    const result = await fetchUsageForProvider(id);
    const error = result.error ? safeError(result.error) : undefined;
    return { ...result, id, error: error ?? (result.windows.length ? undefined : "no-usage-data") };
  } catch {
    return { id, provider: id, windows: [], error: "query-failed", fetchedAt: Date.now() };
  }
}

function quotaLabel(window: RateWindow): string {
  return window.label === "Weekly" ? "Week" : window.label;
}

function formatQuota(window: RateWindow, theme: Theme, bars: boolean, labelWidth: number, headerLabel: string): string {
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  let color: "success" | "warning" | "error" = "success";
  if (percent >= 90) color = "error";
  else if (percent >= 70) color = "warning";
  const filled = Math.round(percent / 20);
  const bar = bars ? theme.fg(color, "━".repeat(filled)) + theme.fg("dim", "─".repeat(5 - filled)) + " " : "";
  // Label is redundant when it matches the column header — only show outliers.
  const label = quotaLabel(window);
  const prefix = label !== headerLabel ? theme.fg("text", label.padEnd(labelWidth)) + " " : "";
  const percentage = `${Number(percent.toFixed(1))}%`.padStart(5);
  // "0m"/"now" countdowns are noise (window already reset) — omit them.
  const reset = window.resetsIn && window.resetsIn !== "0m" && window.resetsIn !== "now" ? theme.fg("muted", ` ${window.resetsIn}`) : "";
  return `${prefix}${bar}${theme.fg(color, percentage)}${reset}`;
}

function formatMoney(result: Result): string {
  return result.windows.filter((window) => window.money || window.credits).map((window) => {
    // 积分（WorkBuddy 网关）：整数、无货币含义，标 credits 不用 $
    if (window.credits) {
      const { remain, size, accounts, okAccounts } = window.credits;
      const pool = okAccounts < accounts ? ` · ${okAccounts}/${accounts} accounts` : "";
      return size > 0 ? `${remain} / ${size} credits${pool}` : `${remain} credits${pool}`;
    }
    const { used, remaining, limit } = window.money!;
    if (result.id === "commandcode" && limit !== undefined) return `$${used.toFixed(2)} / $${limit.toFixed(2)}`;
    if (remaining !== undefined) return `$${remaining.toFixed(2)} left`;
    return `$${used.toFixed(2)} / 30d`;
  }).join(" · ") || "—";
}

function formatTable(results: Result[], theme: Theme, width: number): string {
  if (!results.length) {
    return "No configured providers found. Use /usage --all to show all supported providers.";
  }
  const quotas = results.map((result) => result.windows.filter((window) => !window.money && !window.credits));
  const quotaCount = Math.max(0, ...quotas.map((windows) => windows.length));
  const labelWidths = Array.from({ length: quotaCount }, (_, index) =>
    Math.max(0, ...quotas.map((windows) => windows[index] ? visibleWidth(quotaLabel(windows[index])) : 0)));
  // Column header = the most common window label at that position (e.g. "5h", "Week").
  const headerLabels = labelWidths.map((_, index) => {
    const counts = new Map<string, number>();
    for (const windows of quotas) {
      const label = windows[index] ? quotaLabel(windows[index]) : undefined;
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Quota";
  });
  const headers = ["Provider", ...headerLabels.map((label) => `${label} Reset`), "Balance / spent", "Status"];
  const rows = results.map((result, resultIndex) => {
    let status = theme.fg("success", "✓");
    if (result.error === "no-auth") status = theme.fg("muted", "Not configured");
    else if (result.error) status = theme.fg("error", result.error);
    const usage = labelWidths.map((labelWidth, index) => {
      const window = quotas[resultIndex][index];
      return window ? formatQuota(window, theme, width >= 110, labelWidth, headerLabels[index]) : theme.fg("dim", "—");
    });
    return [theme.fg("text", result.provider), ...usage, theme.fg("text", formatMoney(result)), status];
  });
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => visibleWidth(row[index]))));
  const separatorWidth = (headers.length - 1) * 3;
  const naturalWidth = widths.reduce((sum, size) => sum + size, 0) + separatorWidth;
  // Keep each provider on one terminal row, including on narrower panes.
  while (widths.reduce((sum, size) => sum + size, 0) + separatorWidth > Math.max(headers.length + separatorWidth, width)) {
    const largest = widths.indexOf(Math.max(...widths));
    widths[largest]--;
  }
  function row(cells: string[]): string {
    return cells.map((cell, index) => {
      const text = truncateToWidth(cell, widths[index]);
      return text + " ".repeat(Math.max(0, widths[index] - visibleWidth(text)));
    }).join(theme.fg("borderMuted", " │ "));
  }
  const rule = theme.fg("borderMuted", widths.map((size) => "─".repeat(size)).join("─┼─"));
  const lines = [
    theme.fg("accent", theme.bold(`Provider usage · ${results.length} provider${results.length === 1 ? "" : "s"}`)),
    "",
    row(headers.map((header) => theme.fg("muted", header))),
    rule,
    ...rows.map(row),
    rule,
  ];
  if (naturalWidth > width) lines.push(theme.fg("dim", "… More detail: /usage <provider> or widen the pane"));
  return lines.join("\n");
}
