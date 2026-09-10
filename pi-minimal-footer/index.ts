/**
 * Context Gauge Extension
 *
 * Custom footer with context gauge + subscription usage bars.
 * Auto-detects provider from current model and shows relevant usage.
 *
 * Supports: Claude Max, Codex, Copilot, Gemini, MiniMax Token Plan, Kimi Coding, GLM Coding Plan CN (zai-coding-cn), CommandCode, OpenCode Go, OpenCode Zen, OpenRouter
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { registerUsageCommand } from "./usage-command.js";
import { detectProvider, fetchUsageForProvider, type RateWindow, type UsageSnapshot } from "./usage.js";

// ============ Types ============

interface GitCache {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

// ============ Usage Cache ============

const USAGE_REFRESH_INTERVAL = 5 * 60_000; // 5 minutes
const usageCache = new Map<string, UsageSnapshot>(); // keyed by provider

// ============ Env Flags ============

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;

  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

// ============ Identity Cache ============

let codexEmailPrefix: string | null | undefined; // undefined = not yet resolved

// ============ Git Cache ============

let gitCache: GitCache | null = null;

function parseGitStatus(output: string): GitCache {
  let branch: string | null = null;
  let dirty = false;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head && head !== "(detached)" ? head : null;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = parseInt(match[1], 10) || 0;
        behind = parseInt(match[2], 10) || 0;
      }
      continue;
    }

    if (!line.startsWith("# ")) dirty = true;
  }

  return { branch, dirty, ahead, behind };
}

function sameGitCache(a: GitCache | null, b: GitCache | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.branch === b.branch && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind;
}

function refreshGitCache(): boolean {
  let next: GitCache | null = null;

  // Windows: execSync routes through cmd.exe, where the POSIX `2>/dev/null`
  // redirect fails and cmd prints the error straight to the console
  // (bypassing the captured pipes) — it lands on pi's input row. Use spawnSync
  // with stdio instead, which spawns git directly with no shell involved.
  try {
    const result = spawnSync("git", ["status", "--porcelain=v2", "--branch"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      next = parseGitStatus((result.stdout ?? "").trimEnd());
    }
  } catch {
    next = null;
  }

  const changed = !sameGitCache(gitCache, next);
  gitCache = next;
  return changed;
}

// ============ Extension ============

export default function (pi: ExtensionAPI) {
  registerUsageCommand(pi);

  const CTX_GAUGE_WIDTH = 12;

  // Thin bar characters (same style for both context and usage)
  const BAR_FILLED = "━";
  const BAR_EMPTY = "─";

  // Optional visibility toggles (default: enabled)
  const showCwd = parseBooleanEnv(process.env.PI_MINIMAL_FOOTER_SHOW_CWD, true);
  const showBranch = parseBooleanEnv(process.env.PI_MINIMAL_FOOTER_SHOW_BRANCH, true);

  function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (tokens >= 1_000) {
      return `${Math.round(tokens / 1_000)}k`;
    }
    return `${tokens}`;
  }

  function fitFooterSegment(width: number, variants: string[]): string {
    const safeWidth = Math.max(1, width);

    for (const variant of variants) {
      if (visibleWidth(variant) <= safeWidth) return variant;
    }

    return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
  }

  function wrapFooterSegments(segments: string[], width: number, sep: string): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    let current = "";

    for (const segment of segments.filter(Boolean)) {
      const fitted = truncateToWidth(segment, safeWidth);

      if (!current) {
        current = fitted;
        continue;
      }

      const candidate = current + sep + fitted;
      if (visibleWidth(candidate) <= safeWidth) {
        current = candidate;
        continue;
      }

      lines.push(truncateToWidth(current, safeWidth));
      current = fitted;
    }

    if (current) lines.push(truncateToWidth(current, safeWidth));
    return lines;
  }

  function renderContextGauge(
    percentage: number,
    theme: any,
    used?: number,
    total?: number,
    options?: { barWidth?: number; includeCounts?: boolean }
  ): string {
    const barWidth = Math.max(4, options?.barWidth ?? CTX_GAUGE_WIDTH);
    const clamped = Math.max(0, Math.min(100, percentage));
    const filled = Math.round((clamped / 100) * barWidth);
    const empty = barWidth - filled;

    let color: string;
    if (clamped >= 90) color = "error";
    else if (clamped >= 70) color = "warning";
    else if (clamped >= 50) color = "accent";
    else color = "success";

    const bar = theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
    const pct = `${Math.round(clamped)}%`;
    const counts =
      options?.includeCounts === false || used === undefined || !total
        ? ""
        : ` ${formatTokenCount(used)}/${formatTokenCount(total)}`;

    return theme.fg("dim", "ctx ") + bar + " " + theme.fg("dim", pct + counts);
  }

  function renderUsageBar(usedPercent: number, barWidth: number, theme: any): string {
    const clamped = Math.max(0, Math.min(100, usedPercent));
    const filled = Math.round((clamped / 100) * barWidth);
    const empty = barWidth - filled;

    let color: string;
    if (clamped >= 92) color = "error";
    else if (clamped >= 85) color = "warning";
    else color = "success";

    return theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
  }

  function renderUsageWindow(
    window: RateWindow,
    theme: any,
    options?: { barWidth?: number; includeReset?: boolean }
  ): string {
    const dim = (s: string) => theme.fg("dim", s);
    const bar = renderUsageBar(window.usedPercent, Math.max(4, options?.barWidth ?? 10), theme);
    const pct = dim(`${Math.round(window.usedPercent)}%`);
    const timeStr = options?.includeReset === false || !window.resetsIn ? "" : " " + dim(window.resetsIn);
    return `${dim(window.label)} ${bar} ${pct}${timeStr}`;
  }

  function renderUsageLine(usage: UsageSnapshot, width: number, theme: any): string[] {
    if (!usage.windows.length) return [];

    const dim = (s: string) => theme.fg("dim", s);
    const sep = " " + dim(">") + " ";
    const segments: string[] = [theme.fg("accent", usage.provider)];

    for (const w of usage.windows) {
      // Money labels ($X.XX/$Y) show just the label; rate limits keep the bar
      if (w.label.startsWith("$")) {
        segments.push(dim(w.label));
      } else {
        segments.push(
          fitFooterSegment(width, [
            renderUsageWindow(w, theme, { barWidth: 10, includeReset: true }),
            renderUsageWindow(w, theme, { barWidth: 8, includeReset: true }),
            renderUsageWindow(w, theme, { barWidth: 8, includeReset: false }),
            renderUsageWindow(w, theme, { barWidth: 6, includeReset: false }),
            renderUsageWindow(w, theme, { barWidth: 4, includeReset: false }),
          ])
        );
      }
    }

    return wrapFooterSegments(segments, width, sep);
  }

  function getThinkingLevel(ctx: any): string {
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const context = buildSessionContext(entries, leafId);
    return context.thinkingLevel || "off";
  }

  function getContextInfo(ctx: any): { percentage: number; used: number; total: number } {
    const model = ctx.model;
    const contextWindow = model?.contextWindow ?? 0;
    if (contextWindow === 0) return { percentage: 0, used: 0, total: 0 };

    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const context = buildSessionContext(entries, leafId);
    const messages = context.messages;

    const lastAssistant = messages
      .slice()
      .reverse()
      .find((m: any) => m.role === "assistant" && m.stopReason !== "aborted") as any;

    const usage = lastAssistant?.usage;
    if (!usage) return { percentage: 0, used: 0, total: contextWindow };
    const contextTokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

    return { percentage: (contextTokens / contextWindow) * 100, used: contextTokens, total: contextWindow };
  }

  // Track usage state for rendering
  let latestUsage: UsageSnapshot | null = null;
  let activeProvider: string | null = null; // internal provider key for the current model
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Store tui reference for triggering re-renders from event handlers
  let tuiRef: { requestRender: () => void } | null = null;

  function refreshGitFooter(): void {
    if (refreshGitCache()) tuiRef?.requestRender();
  }

  /** Fetch usage for the active provider. Shows cached data immediately,
   *  then fetches fresh in the background. Discards results if provider
   *  changed while the fetch was in flight. */
  function fetchUsage(modelProvider: string): void {
    const provider = detectProvider(modelProvider);
    if (!provider) {
      activeProvider = null;
      latestUsage = null;
      stopRefreshTimer();
      tuiRef?.requestRender();
      return;
    }

    activeProvider = provider;

    // Show cached data immediately if available
    const cached = usageCache.get(provider);
    if (cached && cached.windows.length > 0) {
      latestUsage = cached;
      tuiRef?.requestRender();
    }

    // Fetch fresh in background — keep cached data on transient errors
    fetchUsageForProvider(provider)
      .then((u) => {
        if (!u || activeProvider !== provider) return;
        if (u.windows.length === 0 && u.error && cached?.windows.length) return;
        usageCache.set(provider, u);
        latestUsage = u;
        tuiRef?.requestRender();
      })
      .catch(() => {});
  }

  /** Start (or restart) the periodic refresh timer. */
  function startRefreshTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (activeProvider) {
        const provider = activeProvider;
        const cached = usageCache.get(provider);
        fetchUsageForProvider(provider)
          .then((u) => {
            if (!u || activeProvider !== provider) return;
            if (u.windows.length === 0 && u.error && cached?.windows.length) return;
            usageCache.set(provider, u);
            latestUsage = u;
            tuiRef?.requestRender();
          })
          .catch(() => {});
      }
    }, USAGE_REFRESH_INTERVAL);
  }

  function stopRefreshTimer(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshGitCache();

    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      tuiRef = tui;

      const unsub = footerData.onBranchChange(() => {
        refreshGitFooter();
      });

      // Initial fetch inside factory — tui is guaranteed available here,
      // so requestRender() will work when the async fetch completes.
      if (ctx.model?.provider) {
        fetchUsage(ctx.model.provider);
        startRefreshTimer();
      }

      return {
        dispose: () => {
          unsub();
          tuiRef = null;
          stopRefreshTimer();
        },
        invalidate() {},
        render(width: number): string[] {
          const { percentage, used: ctxUsed, total: ctxTotal } = getContextInfo(ctx);

          // Build parts for status line
          let pwd = ctx.cwd;
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          let branchStr = "";
          if (showBranch && gitCache?.branch) {
            const branchColor = gitCache.dirty ? "warning" : "success";
            branchStr = theme.fg(branchColor, gitCache.branch);
            if (gitCache.dirty) branchStr += theme.fg("warning", " *");
            if (gitCache.ahead) branchStr += theme.fg("success", ` ↑${gitCache.ahead}`);
            if (gitCache.behind) branchStr += theme.fg("error", ` ↓${gitCache.behind}`);
          }

          // Model + thinking
          const isCommandCode = ctx.model?.provider === "commandcode";
          const modelName = ctx.model?.id?.split("/").pop() || "no-model";
          const ccTag = isCommandCode ? theme.fg("accent", "[cc] ") : "";
          const plainModelStr = theme.fg("muted", modelName);
          let modelStr = ccTag + plainModelStr;
          if (ctx.model?.reasoning) {
            const thinkingLevel = getThinkingLevel(ctx);
            if (thinkingLevel !== "off") {
              modelStr += " " + theme.fg("dim", ">") + " " + theme.fg("accent", thinkingLevel);
            }
          }

          const sep = " " + theme.fg("dim", ">") + " ";
          const lines: string[] = [];

          const pwdStr = showCwd ? theme.fg("accent", pwd) : "";
          const locationVariants: string[] = [];
          if (pwdStr && branchStr) locationVariants.push(pwdStr + sep + branchStr);
          if (pwdStr) locationVariants.push(pwdStr);
          if (branchStr) locationVariants.push(branchStr);
          const locationBlock = locationVariants.length > 0 ? fitFooterSegment(width, locationVariants) : "";

          const statusBlocks = [
            locationBlock,
            fitFooterSegment(width, modelStr === plainModelStr ? [plainModelStr] : [modelStr, plainModelStr]),
            fitFooterSegment(width, [
              renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
                barWidth: CTX_GAUGE_WIDTH,
                includeCounts: true,
              }),
              renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
                barWidth: 10,
                includeCounts: false,
              }),
              renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
                barWidth: 8,
                includeCounts: false,
              }),
              renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
                barWidth: 6,
                includeCounts: false,
              }),
              renderContextGauge(percentage, theme, ctxUsed, ctxTotal, {
                barWidth: 4,
                includeCounts: false,
              }),
            ]),
          ];

          lines.push(...wrapFooterSegments(statusBlocks, width, sep));

          if (latestUsage && latestUsage.windows.length > 0) {
            lines.push(...renderUsageLine(latestUsage, width, theme));
          }

          return lines.map((line) => truncateToWidth(line, width));
        },
      };
    });

  });

  pi.on("turn_end", async () => {
    refreshGitFooter();
  });

  // Refresh when model changes — fetch immediately, restart timer
  pi.on("model_select", (event, _ctx) => {
    if (!event.model?.provider) return;
    fetchUsage(event.model.provider);
    startRefreshTimer(); // reset the 5min countdown since we just fetched
  });
}
