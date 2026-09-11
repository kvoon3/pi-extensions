/**
 * WorkBuddy provider for pi.
 *
 * The gateway (workbuddy2api) is a shared service on the LAN. This extension
 * registers it as a provider and keeps its model catalog live.
 *
 * Credentials come from pi's own `/login` flow — this extension deliberately
 * does not read or store the gateway API key itself, so it plays no part in
 * where the key is kept.
 *
 * Run `/login`, pick "WorkBuddy", and paste the gateway's API key.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "workbuddy";

/**
 * Gateway endpoint.
 *
 * Defaults to the LAN service; override with WORKBUDDY_BASE_URL for a local
 * gateway, a different host, or a tunnel.
 */
const defaultBaseUrl = "http://192.168.1.13:7863/v1";

const modelsTimeoutMs = 6000;

interface GatewayModel {
  id: string;
  context_length?: number;
  max_output_tokens?: number;
}

function baseUrl(): string {
  const raw = process.env.WORKBUDDY_BASE_URL?.trim();
  // Strip a trailing slash so `${base}/models` never doubles up.
  return (raw || defaultBaseUrl).replace(/\/+$/, "");
}

function tokenLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("WorkBuddy returned an invalid token limit.");
  }
  return value;
}

function toModel(gatewayModel: GatewayModel, endpoint: string): Model<"openai-completions"> {
  return {
    id: gatewayModel.id,
    name: gatewayModel.id,
    provider: providerId,
    api: "openai-completions",
    baseUrl: endpoint,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: tokenLimit(gatewayModel.context_length, 128000),
    maxTokens: tokenLimit(gatewayModel.max_output_tokens, 16384),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };
}

/** Fetch the catalog from the gateway. Throws on unusable responses. */
async function fetchModels(endpoint: string, apiKey: string | undefined, signal: AbortSignal): Promise<ModelsStoreEntry> {
  if (!apiKey) throw new Error("No WorkBuddy API key. Run /login and pick WorkBuddy.");

  const response = await fetch(`${endpoint}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(modelsTimeoutMs - 1000)]),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`WorkBuddy model discovery returned HTTP ${response.status}.`);

  const payload = (await response.json()) as { data?: GatewayModel[] };
  if (!Array.isArray(payload?.data) || payload.data.length === 0) {
    throw new Error("WorkBuddy returned an empty or invalid model catalog.");
  }

  const ids = new Set<string>();
  const models = payload.data.map((gatewayModel) => {
    if (!gatewayModel || typeof gatewayModel.id !== "string" || !gatewayModel.id.trim() || ids.has(gatewayModel.id)) {
      throw new Error("WorkBuddy returned an invalid or duplicate model ID.");
    }
    ids.add(gatewayModel.id);
    return toModel(gatewayModel, endpoint);
  });
  return { models, checkedAt: Date.now() };
}

/** True when a cached snapshot matches the endpoint we would fetch from now. */
function matchesEndpoint(entry: ModelsStoreEntry | undefined, endpoint: string): entry is ModelsStoreEntry {
  return Array.isArray(entry?.models) && entry.models.length > 0 &&
    entry.models.every((model) => model.provider === providerId && model.baseUrl === endpoint);
}

async function saveSnapshot(cachePath: string, snapshot: ModelsStoreEntry): Promise<void> {
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** A cached catalog is far more useful than an empty one while offline. */
async function loadCachedSnapshot(cachePath: string, endpoint: string): Promise<ModelsStoreEntry | undefined> {
  try {
    const stored = JSON.parse(await readFile(cachePath, "utf8"));
    if (matchesEndpoint(stored, endpoint)) return stored;
  } catch {
    // A missing or damaged cache is recovered from the gateway.
  }
  return undefined;
}

export default async function workbuddy(pi: ExtensionAPI): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const authPath = join(agentDir, "auth.json");
  const cachePath = join(agentDir, "workbuddy-models-cache.json");
  const endpoint = baseUrl();

  // Read the credential pi already holds; registering without it still makes
  // the provider appear in /login, where the key gets supplied.
  // Read the stored key directly rather than through ModelRuntime.getAuth().
  // getAuth() resolves against the composed provider list, but this extension is
  // still loading when it needs the key — "workbuddy" is not registered yet, so
  // getAuth() returns undefined and the first startup finds no key even after
  // /login. readStoredCredential() is a plain auth.json read with no such
  // dependency. It does not expand $ENV/!command indirection, which is fine
  // here: /login stores a literal key.
  async function resolveApiKey(): Promise<string | undefined> {
    const credential = readStoredCredential(providerId, authPath);
    return credential?.type === "api_key" ? credential.key : undefined;
  }

  let snapshot = await loadCachedSnapshot(cachePath, endpoint);
  const offline = process.env.PI_OFFLINE !== undefined;

  if (!offline) {
    try {
      const signal = AbortSignal.timeout(modelsTimeoutMs);
      const next = await fetchModels(endpoint, await resolveApiKey(), signal);
      await saveSnapshot(cachePath, next);
      snapshot = next;
    } catch (error) {
      console.error(
        `[workbuddy] Model refresh failed; ${snapshot?.models.length ?? 0} cached models available. ` +
          `${error instanceof Error ? error.message : "Unknown error."}`,
      );
    }
  }

  pi.registerProvider(providerId, {
    name: "WorkBuddy",
    baseUrl: endpoint,
    api: "openai-completions",
    authHeader: true,
    models: [...(snapshot?.models ?? [])],
    async refreshModels(context) {
      // pi refreshes with allowNetwork=false right after /login stores a key.
      // Returning early there would leave the model list empty until restart,
      // so fetch anyway once a credential exists — logging in should be
      // enough to get models.
      const key = context.credential?.type === "api_key" ? context.credential.key : await resolveApiKey();
      if (!context.allowNetwork && !key) return [...(snapshot?.models ?? [])];

      const next = await fetchModels(endpoint, key, context.signal);
      if (!(await context.publish({ persist: next }))) return [...(snapshot?.models ?? [])];
      await saveSnapshot(cachePath, next);
      snapshot = next;
      return [...next.models];
    },
  });

  pi.registerCommand("workbuddy-refresh", {
    description: "Fetch the latest WorkBuddy models from the gateway",
    async handler(_args, ctx): Promise<void> {
      const result = await ctx.modelRegistry.refresh({
        providers: [providerId],
        allowNetwork: true,
        force: true,
        signal: AbortSignal.timeout(modelsTimeoutMs),
      });
      const error = result.errors.get(providerId);
      if (error || result.aborted) {
        ctx.ui.notify(`WorkBuddy refresh failed; keeping cached models. ${error?.message ?? "Timed out."}`, "warning");
        return;
      }
      const count = ctx.modelRegistry.getAll().filter((model) => model.provider === providerId).length;
      ctx.ui.notify(`WorkBuddy: refreshed ${count} models.`, "info");
    },
  });
}
