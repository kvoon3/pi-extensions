import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function run(args, { auth = {}, responses = {}, sessions = [], hasUI = true, concurrent = false, columns = 134 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pi-usage-command-'));
  try {
    const agent = join(home, '.pi', 'agent');
    mkdirSync(join(agent, 'sessions'), { recursive: true });
    writeFileSync(join(agent, 'auth.json'), JSON.stringify(auth));
    writeFileSync(join(agent, 'sessions', 'test.jsonl'), sessions.map(JSON.stringify).join('\n'));
    const loader = pathToFileURL(resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href;
    const script = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.execSync = () => { throw new Error('credential helpers disabled'); };
      syncBuiltinESMExports();
      const responses = ${JSON.stringify(responses)};
      Object.defineProperty(process.stdout, "columns", { value: ${columns} });
      let requests = 0;
      globalThis.fetch = async (url) => {
        requests++;
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
      const loaded = await loadExtensions([${JSON.stringify(resolve('pi-minimal-footer/index.ts'))}], process.cwd(), undefined, runtime);
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
      console.log(JSON.stringify({ notifications, statuses, mutations, requests }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex') }, timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.mutations, [], 'usage must not write any session/model messages');
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

test('default hides unconfigured providers; --all shows all 11', () => {
  const empty = run('');
  assert.match(empty.notifications[0].message, /No configured providers/);
  assert.equal(empty.requests, 0);
  const all = run('--all');
  assert.equal((all.notifications[0].message.match(/Not configured/g) ?? []).length, 11);
  assert.deepEqual(all.statuses.at(-1), ['usage', null]);
});

test('partial failure preserves balances and does not write session messages', () => {
  const result = run('', { auth, responses });
  const report = result.notifications[0].message;
  assert.match(report, /HTTP 429/);
  assert.match(report, /\$16\.75 left/);
  assert.equal(result.requests, 2);
  assert.deepEqual(result.statuses.at(-1), ['usage', null]);
});

test('provider filtering, aliases, help, and unknown arguments', () => {
  const selected = run('anthropic', { auth, responses });
  assert.equal(selected.requests, 1);
  assert.match(selected.notifications[0].message, /Claude/);
  assert.doesNotMatch(selected.notifications[0].message, /OpenRouter/);
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
  assert.doesNotMatch(report, /secret-token|test-key/);
});

test('non-UI mode performs no queries or writes', () => {
  const result = run('', { auth, responses, hasUI: false });
  assert.equal(result.requests, 0);
  assert.deepEqual(result.notifications, []);
  assert.deepEqual(result.statuses, []);
});

test('local estimates include only the last 30 days for Zen', () => {
  const message = (days, cost) => ({ type: 'message', message: {
    role: 'assistant', provider: 'opencode', timestamp: Date.now() - days * 86400000,
    usage: { cost: { total: cost } },
  } });
  const result = run('', { sessions: [message(2, 1.25), message(31, 50)] });
  assert.match(result.notifications[0].message, /\$1\.25 \/ 30d/);
  assert.doesNotMatch(result.notifications[0].message, /Local/);
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
  assert.doesNotMatch(lines[0], /↻/);
});

test('MiniMax CN is no longer selectable or listed', () => {
  const result = run('minimax-cn');
  assert.equal(result.requests, 0);
  assert.match(result.notifications[0].message, /Usage: \/usage/);
  assert.doesNotMatch(run('--all').notifications[0].message, /MiniMax CN/);
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
  const positions = (line, pattern) => [...line.matchAll(pattern)].map((match) => match.index);
  const columns = positions(table[0], /│/g);
  for (const line of table) assert.deepEqual(positions(line, /[│┼]/g), columns);
  const rows = lines.filter((line) => /^(Claude|Codex)\s/.test(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(positions(rows[0], /%/g), positions(rows[1], /%/g));
  assert.deepEqual(positions(rows[0], /↻/g), positions(rows[1], /↻/g));
});
