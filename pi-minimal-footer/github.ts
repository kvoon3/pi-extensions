/**
 * GitHub account resolution from local gh CLI state.
 *
 * The footer shows the active account (`gh:kvoon3`) and `/gh` (alt+g) switches
 * between the accounts authenticated for the host the current repo targets.
 * Everything comes from gh's own config (`hosts.yml`) and the `origin` remote
 * URL — no `gh` call, no network request, no push-permission checks.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============ Types ============

export interface GhHost {
  /** Active account for the host (`user:` in hosts.yml), or null. */
  user: string | null;
  /** All accounts authenticated for the host (`users:` in hosts.yml). */
  accounts: string[];
}

/** Accounts a host has authenticated in gh, plus which one is active. */
export interface HostAccounts {
  host: string;
  /** Active account for the host, or null. */
  active: string | null;
  /** Every authenticated account, active first. */
  accounts: string[];
}

// ============ hosts.yml ============

/**
 * Minimal parser for gh's `hosts.yml`, which gh writes as:
 *
 *   github.com:
 *       git_protocol: https
 *       users:
 *           kvoon3:
 *           kvoon9:
 *       user: kvoon3
 *
 * Only the pieces this extension needs are parsed: the per-host active `user`
 * and the `users` list. Unknown keys are skipped.
 */
export function parseGhHosts(text: string): Map<string, GhHost> {
  const hosts = new Map<string, GhHost>();
  let current: GhHost | null = null;
  let usersIndent: number | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      // Host key, e.g. "github.com:"
      current = line.endsWith(":") ? { user: null, accounts: [] } : null;
      if (current) hosts.set(unquote(line.slice(0, -1)), current);
      usersIndent = null;
      continue;
    }

    if (!current) continue;

    if (line === "users:") {
      usersIndent = indent;
      continue;
    }

    if (line.startsWith("user:")) {
      current.user = unquote(line.slice("user:".length).trim()) || null;
      usersIndent = null;
      continue;
    }

    if (usersIndent !== null && indent > usersIndent && line.endsWith(":")) {
      const name = unquote(line.slice(0, -1));
      if (name) current.accounts.push(name);
    }
  }

  return hosts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ============ Remotes ============

/** Host of a git remote URL ("github.com", "ghe.corp.example.com"), or null for local paths. */
export function parseRemoteHost(url: string | null | undefined): string | null {
  const value = url?.trim();
  if (!value) return null;
  // Windows drive paths (C:\repo, C:/repo) are filesystem remotes.
  if (/^[A-Za-z]:[\\/]/.test(value)) return null;

  let host: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      host = new URL(value).hostname;
    } catch {
      return null;
    }
  } else if (value.includes(":") && !value.startsWith("/")) {
    // scp-like: git@github.com:owner/repo.git — also bare "github.com:owner/repo".
    host = value.slice(0, value.indexOf(":")).split("@").pop() ?? "";
  } else {
    return null; // relative or absolute filesystem path
  }

  return host.includes(".") ? host.toLowerCase() : null;
}

// ============ gh CLI config (IO) ============

export function ghHostsPaths(): string[] {
  const explicit = process.env.GH_CONFIG_DIR;
  if (explicit) return [join(explicit, "hosts.yml")];

  const paths: string[] = [];
  if (process.platform === "win32" && process.env.APPDATA) {
    paths.push(join(process.env.APPDATA, "GitHub CLI", "hosts.yml"));
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  paths.push(join(configHome, "gh", "hosts.yml"));
  return paths;
}

export function readGhHostsText(): string | null {
  for (const path of ghHostsPaths()) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function readOriginRemoteUrl(cwd?: string): string | null {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      ...(cwd ? { cwd } : {}),
    });
    if (result.status !== 0) return null;
    const url = (result.stdout ?? "").trim();
    return url || null;
  } catch {
    return null;
  }
}

// ============ Account list ============

/** Authenticated accounts for the host the current repo targets, falling back
 *  to github.com outside a repo. The active account comes first. */
export function resolveHostAccounts(hostsText: string | null, remoteUrl: string | null): HostAccounts {
  const host = parseRemoteHost(remoteUrl) ?? "github.com";
  const entry = parseGhHosts(hostsText ?? "").get(host);
  const accounts = [...new Set([...(entry?.user ? [entry.user] : []), ...(entry?.accounts ?? [])])];
  return { host, active: entry?.user ?? null, accounts };
}
