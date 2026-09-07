// Self-check for the GLM Coding Plan CN (zai-coding-cn) usage parsing in index.ts.
// Pins the invariants that would silently break usage bars:
//   1. unit/number -> label mapping (3h -> "5h", 6 -> "Week")
//   2. limits array -> RateWindow list (percentage clamp, reset time, skip junk)
// Run: node test-zai-usage.mjs   (hits the live quota API if a key exists)

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import assert from "node:assert";

// ---- copies of the pure logic under test ----
function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function zaiCnWindowLabel(limit) {
  const unit = Number(limit?.unit);
  const number = Number(limit?.number);
  if (unit === 3 && number > 0) return `${number}h`;
  if (unit === 6) return "Week";
  return "Usage";
}

function toWindows(data) {
  const windows = [];
  for (const limit of data?.data?.limits || []) {
    const usedPercent = Number(limit?.percentage);
    if (!Number.isFinite(usedPercent)) continue;
    windows.push({
      label: zaiCnWindowLabel(limit),
      usedPercent: clampPercent(usedPercent),
      resetsIn: limit?.nextResetTime ? new Date(Number(limit.nextResetTime)) : undefined,
    });
  }
  return windows;
}

// ---- invariants ----
assert.equal(zaiCnWindowLabel({ unit: 3, number: 5 }), "5h", "5h window");
assert.equal(zaiCnWindowLabel({ unit: 6, number: 1 }), "Week", "weekly window");
assert.equal(zaiCnWindowLabel({ unit: 99, number: 2 }), "Usage", "unknown unit fallback");

const live = toWindows({
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 361, remaining: 1638, percentage: 18, nextResetTime: 1788764624065 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 3682, remaining: 6317, percentage: 36, nextResetTime: 1789183765998 },
    ],
  },
});
assert.equal(live.length, 2, "both windows parsed");
assert.deepEqual(live.map((w) => w.label), ["5h", "Week"]);
assert.deepEqual(live.map((w) => w.usedPercent), [18, 36]);
assert.ok(live.every((w) => w.resetsIn instanceof Date && !isNaN(w.resetsIn)), "reset times parsed");
assert.equal(toWindows({ data: { limits: [{ percentage: "x" }, { unit: 3, number: 5 }] } }).length, 0, "junk entries skipped");
assert.equal(clampPercent(150), 100, "percentage clamped high");
assert.equal(clampPercent(-5), 0, "percentage clamped low");

// ---- live check against the real API (uses ~/.pi/agent/auth.json) ----
const authPath = join(homedir(), ".pi", "agent", "auth.json");
if (existsSync(authPath)) {
  const auth = JSON.parse(readFileSync(authPath, "utf-8"));
  const key = typeof auth["zai-coding-cn"] === "object" ? auth["zai-coding-cn"].key : auth["zai-coding-cn"];
  if (key) {
    const res = await fetch("https://open.bigmodel.cn/api/monitor/usage/quota/limit", {
      headers: { Authorization: key, "Content-Type": "application/json" },
    });
    assert.equal(res.status, 200, "live API HTTP 200");
    const windows = toWindows(await res.json());
    assert.ok(windows.length >= 1, "live API returned at least one window");
    console.log(`ok: GLM Coding live -> ${windows.map((w) => `${w.label} ${w.usedPercent}%`).join(", ")}`);
  } else {
    console.log("ok (pure checks only; no zai-coding-cn key in auth.json)");
  }
} else {
  console.log("ok (pure checks only; no auth.json)");
}
