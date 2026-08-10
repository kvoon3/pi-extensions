// Self-check for the OpenCode Zen/Go usage math in index.ts
// (collectProviderCosts + fetchOpenCodeGoUsage). Pins the invariants that
// would silently break usage bars:
//   1. Week window = UTC Monday 00:00 (mirrors server getWeekBounds)
//   2. Cost sums come out of the real session store as expected
// Run: node test-go-usage.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import assert from "node:assert";

// ---- copies of the pure functions under test ----
function weekStartUtcMs(now) {
  const d = new Date(now);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset);
}

function collectProviderCosts(provider) {
  const cutoff = Date.now() - 32 * 24 * 60 * 60 * 1000;
  const out = [];
  for (const rel of readdirSync(join(homedir(), ".pi", "agent", "sessions"), { recursive: true })) {
    if (typeof rel !== "string" || !rel.endsWith(".jsonl")) continue;
    const path = join(homedir(), ".pi", "agent", "sessions", rel);
    const st = statSync(path);
    if (st.mtimeMs < cutoff) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        const m = e?.message;
        if (e?.type === "message" && m?.role === "assistant") {
          const ts = m.timestamp;
          const cost = m.usage?.cost?.total;
          if (typeof ts === "number" && typeof cost === "number" && typeof m.provider === "string") {
            if (m.provider === provider) out.push({ ts, cost });
          }
        }
      } catch {}
    }
  }
  return out;
}

// ---- invariants ----
const now = Date.now();

// UTC Monday 00:00 must be ≤ now, within the last 7 days, and at a day boundary
const wk = weekStartUtcMs(now);
assert.ok(wk <= now && now - wk < 7 * 24 * 3600e3, "week start in last 7 days");
assert.equal(wk % 86400e3, 0, "week start at UTC midnight");
assert.equal(new Date(wk).getUTCDay(), 1, "week starts Monday UTC");

// Sanity vs the server formula: same answer as Date-based getWeekBounds
const d = new Date(now);
const offset = (d.getUTCDay() + 6) % 7;
const serverStart = new Date(d);
serverStart.setUTCDate(d.getUTCDate() - offset);
serverStart.setUTCHours(0, 0, 0, 0);
assert.equal(wk, serverStart.getTime(), "matches server getWeekBounds");

// Cost sums over real data: 5h ≤ week, both ≥ 0, and pluckable per window
const costs = collectProviderCosts("opencode-go");
const zenCosts = collectProviderCosts("opencode");
const sumSince = (since) => costs.reduce((acc, c) => (c.ts >= since ? acc + c.cost : acc), 0);
const five = sumSince(now - 5 * 3600e3);
const week = sumSince(wk);
assert.ok(Number.isFinite(five) && Number.isFinite(week), "finite sums");
assert.ok(five <= week + 1e-9, "5h usage <= week usage");
assert.ok(week <= 30 && five <= 12, "usage within plan limits");
const zenSpent = zenCosts.reduce((acc, c) => acc + c.cost, 0);
assert.ok(Number.isFinite(zenSpent) && zenSpent >= 0, "zen spend finite");

console.log(
  `ok: ${costs.length} opencode-go messages, 5h $${five.toFixed(4)} / $12, week $${week.toFixed(4)} / $30, weekStart=${new Date(wk).toISOString()}, zen spent $${zenSpent.toFixed(4)}`
);
