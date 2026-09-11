import { test, assert } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Resolve relative to the package root, not cwd: running from pi-minimal-footer/
// would otherwise build pi-minimal-footer/pi-minimal-footer/index.ts and fail.
// pi-coding-agent is either nested in the package (dev install) or hoisted to
// the repo root, so accept whichever exists — publish never ships either.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function installedPackage(relativePath: string): string {
  const found = [pkgRoot, resolve(pkgRoot, '..')]
    .map((root) => resolve(root, relativePath))
    .find(existsSync);
  if (!found) throw new Error(`installed dependency not found: ${relativePath} — run npm install`);
  return found;
}

interface RunOptions {
  auth?: Record<string, unknown>;
  responses?: Record<string, { status?: number; body: unknown }>;
  models?: Record<string, unknown>;
  sessions?: unknown[];
  hasUI?: boolean;
  concurrent?: boolean;
  columns?: number;
  env?: Record<string, string>;
}

interface RunResult {
  notifications: { message: string; type: string }[];
  statuses: [string, string | null][];
  mutations: [string, unknown[]][];
  requests: number;
  requestAuth: (string | null)[];
}

function run(args: string, { auth = {}, responses = {}, models = {}, sessions = [], hasUI = true, concurrent = false, columns = 134, env = {} }: RunOptions = {}): RunResult {
  const home = mkdtempSync(join(tmpdir(), 'pi-usage-command-'));
  try {
    const agent = join(home, '.pi', 'agent');
    mkdirSync(join(agent, 'sessions'), { recursive: true });
    writeFileSync(join(agent, 'auth.json'), JSON.stringify(auth));
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: models }));
    writeFileSync(join(agent, 'sessions', 'test.jsonl'), sessions.map((session) => JSON.stringify(session)).join('\n'));
    const loader = pathToFileURL(installedPackage('node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href;
    const script = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.execSync = () => { throw new Error('credential helpers disabled'); };
      syncBuiltinESMExports();
      const responses = ${JSON.stringify(responses)};
      let requests = 0;
      const requestAuth = [];
      Object.defineProperty(process.stdout, "columns", { value: ${columns} });
      globalThis.fetch = async (url, init) => {
        requests++;
        requestAuth.push((init?.headers ?? {})['Authorization'] ?? null);
        const entry = responses[url];
        if (!entry) throw new Error('unexpected network request: secret-token');
        return new Response(JSON.stringify(entry.body), { status: entry.status ?? 200 });
      };
      const { loadExtensions, createExtensionRuntime } = await import(${JSON.stringify(loader)});
      const mutations = [];
      const runtime = createExtensionRuntime();
      for (const method of ['sendMessage', 'sendUserMessage', 'appendEntry']) {
        runtime[method] = (...args) => mutations.push([method, args]);
      }
      const loaded = await loadExtensions([${JSON.stringify(resolve(pkgRoot, 'index.ts'))}], process.cwd(), undefined, runtime);
      if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
      const command = loaded.extensions[0].commands.get('usage');
      if (!command) throw new Error('/usage not registered');
      const notifications = [];
      const statuses = [];
      const ctx = {
        hasUI: ${hasUI},
        ui: {
          theme: { fg: (_color, text) => text, bold: (text) => text },
          notify: (message, type) => notifications.push({ message, type }),
          setStatus: (key, value) => statuses.push([key, value ?? null]),
        },
        sessionManager: new Proxy({}, { get() { throw new Error('Session access is forbidden'); } }),
      };
      const first = command.handler(${JSON.stringify(args)}, ctx);
      if (${concurrent}) await command.handler(${JSON.stringify(args)}, ctx);
      await first;
      console.log(JSON.stringify({ notifications, statuses, mutations, requests, requestAuth }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), ...env }, timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepStrictEqual(output.mutations, [], 'usage must not write any session/model messages');
    return output;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const auth = { openrouter: { key: 'test-key' }, anthropic: { access: 'test-token' } };
const responses = {
  'https://openrouter.ai/api/v1/credits': { body: { data: { total_credits: 20, total_usage: 3.25 } } },
  'https://api.anthropic.com/api/oauth/usage': { status: 429, body: {} },
};

test('default hides unconfigured providers; --all shows every supported provider', () => {
  const empty = run('');
  assert.match(empty.notifications[0].message, /No configured providers/);
  assert.equal(empty.requests, 0);
  const all = run('--all');
  const listed = all.notifications[0].message.match(/Not configured/g) ?? [];
  const help = run('--help').notifications[0].message;
  // Provider list comes from /usage --help; --all must render one row per provider.
  const supported = (help.split('Providers: ')[1] ?? '').split(',').length;
  assert.equal(listed.length, supported);
  assert.deepStrictEqual(all.statuses.at(-1), ['usage', null]);
});

test('partial failure preserves balances and does not write session messages', () => {
  const result = run('', { auth, responses });
  const report = result.notifications[0].message;
  assert.match(report, /HTTP 429/);
  assert.match(report, /\$16\.75 left/);
  assert.equal(result.requests, 2);
  assert.deepStrictEqual(result.statuses.at(-1), ['usage', null]);
});

test('provider filtering, aliases, help, and unknown arguments', () => {
  const selected = run('anthropic', { auth, responses });
  assert.equal(selected.requests, 1);
  assert.match(selected.notifications[0].message, /Claude/);
  assert.notMatch(selected.notifications[0].message, /OpenRouter/);
  assert.match(run('codex').notifications[0].message, /Not configured/);
  for (const input of ['unknown', '--help']) {
    const result = run(input, { auth, responses });
    assert.equal(result.requests, 0);
    assert.match(result.notifications[0].message, /Usage: \/usage/);
  }
});

test('raw network exceptions are redacted; duplicate requests are prevented', () => {
  const result = run('openrouter', { auth, concurrent: true });
  assert.equal(result.requests, 1);
  const report = result.notifications.map((n) => n.message).join('\n');
  assert.match(report, /already in progress/);
  assert.match(report, /query-failed/);
  assert.notMatch(report, /secret-token|test-key/);
});

test('non-UI mode performs no queries or writes', () => {
  const result = run('', { auth, responses, hasUI: false });
  assert.equal(result.requests, 0);
  assert.deepStrictEqual(result.notifications, []);
  assert.deepStrictEqual(result.statuses, []);
});

test('local estimates include only the last 30 days for Zen', () => {
  const message = (days: number, cost: number) => ({ type: 'message', message: {
    role: 'assistant', provider: 'opencode', timestamp: Date.now() - days * 86400000,
    usage: { cost: { total: cost } },
  } });
  const result = run('', { sessions: [message(2, 1.25), message(31, 50)] });
  assert.match(result.notifications[0].message, /\$1\.25 \/ 30d/);
  assert.notMatch(result.notifications[0].message, /Local/);
});

test('multiple quota windows occupy one provider row with reset times', () => {
  const result = run('claude', {
    auth, responses: {
      ...responses,
      'https://api.anthropic.com/api/oauth/usage': { body: {
        five_hour: { utilization: 32, resets_at: new Date(Date.now() + 3600000).toISOString() },
        seven_day: { utilization: 91, resets_at: new Date(Date.now() + 86400000).toISOString() },
      } },
    },
  });
  const lines = result.notifications[0].message.split('\n').filter((line) => line.startsWith('Claude'));
  assert.equal(lines.length, 1);
  // Labels live in the column headers; cells keep only bar + percent + reset.
  assert.match(result.notifications[0].message, /5h Reset.*Week Reset/);
  assert.match(lines[0], /32%.*91%/);
  assert.notMatch(lines[0], /↻/);
});

test('MiniMax CN is no longer selectable or listed', () => {
  const result = run('minimax-cn');
  assert.equal(result.requests, 0);
  assert.match(result.notifications[0].message, /Usage: \/usage/);
  assert.notMatch(run('--all').notifications[0].message, /MiniMax CN/);
});

// WorkBuddy：凭证由 pi 的 /login 存在 auth.json，地址默认局域网网关
// （可用 WORKBUDDY_BASE_URL 覆盖）。测试用同一个环境变量把地址指到假的网关。
const WB_BASE = 'https://gw.example/v1';
// 注意：不能叫 WORKBUDDY_API_KEY 之外的变量——auth.json 是首选真实路径。
const wbAuth = (key = 'gw-key') => ({ workbuddy: { type: 'api_key', key } });

function wbRun(args: string, options: RunOptions = {}): RunResult {
  return run(args, {
    auth: wbAuth(),
    responses: { [`${WB_BASE}/usage`]: { body: { total: { remain: 1090, size: 1100, accounts: 1, ok: 1, failed: 0 } } } },
    ...options,
  });
}

test('WorkBuddy credits land in the Balance column, not a quota bar', () => {
  const result = wbRun('workbuddy', { env: { WORKBUDDY_BASE_URL: WB_BASE } });
  const message = result.notifications[0].message;
  assert.equal(result.requests, 1);
  assert.match(message, /WorkBuddy/);
  assert.match(message, /\$1090 \/ \$1100/);
  // 积分不是 rate window：不能变成一根 bar，也不能出现在 Reset 列。
  assert.notMatch(message, /Credits Reset/);
  const row = message.split('\n').filter((line) => line.startsWith('WorkBuddy'));
  assert.equal(row.length, 1);
  assert.notMatch(row[0], /━/);
});

// 未登录（auth.json 无 workbuddy）→ 不查询，报 Not configured。
test('WorkBuddy without a stored key reports no-auth', () => {
  const result = run('workbuddy', { env: { WORKBUDDY_BASE_URL: WB_BASE } });
  assert.equal(result.requests, 0);
  assert.match(result.notifications[0].message, /Not configured/);
});

// 关键回归：key 必须来自 pi /login 写入的 auth.json，且随请求发出。
// （历史 bug：只读 models.json 导致无 Authorization → 网关 401 → 余额列变 "—"。）
test('WorkBuddy takes the key from auth.json written by /login', () => {
  const result = wbRun('workbuddy', { env: { WORKBUDDY_BASE_URL: WB_BASE } });
  assert.equal(result.requests, 1);
  assert.deepStrictEqual(result.requestAuth, ['Bearer gw-key']);
  assert.match(result.notifications[0].message, /\$1090 \/ \$1100/);
});

// WORKBUDDY_API_KEY 作为无登录环境（CI/脚本）的快捷方式。
test('WORKBUDDY_API_KEY overrides the stored credential', () => {
  const result = run('workbuddy', {
    responses: { [`${WB_BASE}/usage`]: { body: { total: { remain: 42, size: 100, accounts: 1, ok: 1 } } } },
    env: { WORKBUDDY_BASE_URL: WB_BASE, WORKBUDDY_API_KEY: 'env-key' },
  });
  assert.deepStrictEqual(result.requestAuth, ['Bearer env-key']);
  assert.match(result.notifications[0].message, /\$42 \/ \$100/);
});

// 多账号部分失败：只标账号数，不影响余额行渲染。
test('WorkBuddy shows the healthy account ratio when a query fails', () => {
  const result = wbRun('workbuddy', {
    env: { WORKBUDDY_BASE_URL: WB_BASE },
    responses: { [`${WB_BASE}/usage`]: { body: {
      total: { remain: 300, size: 500, accounts: 3, ok: 2, failed: 1 },
    } } },
  });
  assert.match(result.notifications[0].message, /\$300 \/ \$500 · 2\/3 accounts/);
});

test('narrow tables keep a single row per provider', () => {
  const result = run('', { auth, responses, columns: 60 });
  const rows = result.notifications[0].message.split('\n').filter((line) => line.includes('│'));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((line) => line.length <= 56));
});

test('balance and quota windows share one CommandCode row', () => {
  const result = run('commandcode', {
    auth: { commandcode: { type: 'oauth', access: 'test-commandcode-key' } },
    responses: {
      'https://api.commandcode.ai/alpha/whoami': { body: {} },
      'https://api.commandcode.ai/alpha/billing/credits': { body: {
        credits: { monthlyCredits: 8 },
        windowLimits: { fiveHour: { used: 1, cap: 10 }, weekly: { used: 2, cap: 10 } },
      } },
      'https://api.commandcode.ai/alpha/usage/summary': { body: { totalCost: 2 } },
    },
  });
  const rows = result.notifications[0].message.split('\n').filter((line) => line.startsWith('CommandCode'));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /10%.*20%/);
  assert.match(rows[0], /\$2\.00 \/ \$10\.00/);
});

test('quota columns, percentages, and reset markers align across providers', () => {
  const result = run('', {
    auth: { anthropic: { access: 'test-claude' }, 'openai-codex': { access: 'test-codex' } },
    responses: {
      'https://api.anthropic.com/api/oauth/usage': { body: {
        five_hour: { utilization: 9 }, seven_day: { utilization: 91.5 },
      } },
      'https://chatgpt.com/backend-api/wham/usage': { body: { rate_limit: {
        primary_window: { used_percent: 100, reset_at: Math.floor(Date.now() / 1000) + 3600 },
        secondary_window: { used_percent: 2, reset_at: Math.floor(Date.now() / 1000) + 86400 },
      } } },
    },
  });
  const lines = result.notifications[0].message.split('\n');
  const table = lines.filter((line) => /[│┼]/.test(line));
  const positions = (line: string, pattern: RegExp) => [...line.matchAll(pattern)].map((match) => match.index);
  const columns = positions(table[0], /│/g);
  for (const line of table) assert.deepStrictEqual(positions(line, /[│┼]/g), columns);
  const rows = lines.filter((line) => /^(Claude|Codex)\s/.test(line));
  assert.equal(rows.length, 2);
  assert.deepStrictEqual(positions(rows[0], /%/g), positions(rows[1], /%/g));
  assert.deepStrictEqual(positions(rows[0], /↻/g), positions(rows[1], /↻/g));
});
