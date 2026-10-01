import { test, assert } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Resolve relative to the package root, not cwd: running from pi-minimal-footer/
// would otherwise build pi-minimal-footer/pi-minimal-footer/index.ts. The package
// is either nested in the package (dev install) or hoisted to the repo root.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function installedPackage(relativePath: string): string {
  const found = [pkgRoot, resolve(pkgRoot, '..')]
    .map((root) => resolve(root, relativePath))
    .find(existsSync);
  if (!found) throw new Error(`installed dependency not found: ${relativePath} — run npm install`);
  return found;
}

const HOSTS = `github.com:
    git_protocol: https
    users:
        kvoon3:
        kvoon9:
    user: kvoon3
`;

interface RunOptions {
  args?: string;
  /** Label returned by ui.select; null simulates pressing escape. */
  selection?: string | null;
  /** Make the fake gh exit non-zero. */
  fail?: boolean;
  hosts?: string | null;
  remote?: string | null;
}

interface RunResult {
  notifications: { message: string; type: string }[];
  selectCalls: { title: string; options: string[] }[];
  ghCalls: string[];
}

/**
 * Boot the extension through pi's loader with a temp HOME and a fake `gh` on
 * PATH that records its argv, then run the `/gh` command handler.
 */
function run({ args = '', selection = 'kvoon9', fail = false, hosts = HOSTS, remote = 'git@github.com:kvoon3/pi-extensions.git' }: RunOptions = {}): RunResult {
  const home = mkdtempSync(join(tmpdir(), 'pi-gh-account-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pi-gh-cwd-'));
  const bin = mkdtempSync(join(tmpdir(), 'pi-gh-bin-'));
  const ghLog = join(home, 'gh-calls.log');
  try {
    if (hosts !== null) {
      mkdirSync(join(home, '.config', 'gh'), { recursive: true });
      writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), hosts);
    }
    if (remote) {
      spawnSync('git', ['init', '-q'], { cwd });
      spawnSync('git', ['remote', 'add', 'origin', remote], { cwd });
    }
    const gh = join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\n${fail ? 'echo "error: not logged in to any hosts" >&2\nexit 1\n' : 'echo "Switched account"\n'}`);
    chmodSync(gh, 0o755);

    const loader = pathToFileURL(installedPackage('node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href;
    const script = `
      const { loadExtensions, createExtensionRuntime } = await import(${JSON.stringify(loader)});
      const loaded = await loadExtensions([${JSON.stringify(resolve(pkgRoot, 'index.ts'))}], process.cwd(), undefined, createExtensionRuntime());
      if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
      const command = loaded.extensions[0].commands.get('gh');
      if (!command) throw new Error('/gh not registered');
      const notifications = [];
      const selectCalls = [];
      const ctx = {
        hasUI: true,
        cwd: process.cwd(),
        model: null,
        ui: {
          theme: { fg: (_color, text) => text },
          notify: (message, type) => notifications.push({ message, type }),
          select: async (title, options) => {
            selectCalls.push({ title, options });
            return ${JSON.stringify(selection)} === null ? undefined : ${JSON.stringify(selection)};
          },
          setStatus() {},
        },
        sessionManager: { getEntries: () => [], getLeafId: () => null },
      };
      await command.handler(${JSON.stringify(args)}, ctx);
      console.log(JSON.stringify({ notifications, selectCalls }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        GH_CONFIG_DIR: join(home, '.config', 'gh'),
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { ...JSON.parse(result.stdout), ghCalls };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

test('/gh lists accounts with the active one first and switches on selection', () => {
  const result = run();
  assert.deepEqual(result.selectCalls, [{ title: 'GitHub account · github.com', options: ['kvoon3 (active)', 'kvoon9'] }]);
  assert.deepEqual(result.ghCalls, ['auth switch --hostname github.com --user kvoon9']);
  assert.deepEqual(result.notifications, [{ message: 'Active GitHub account: kvoon9 (github.com)', type: 'info' }]);
});

test('/gh <username> switches without opening the selector', () => {
  const result = run({ args: 'kvoon9' });
  assert.deepEqual(result.selectCalls, []);
  assert.deepEqual(result.ghCalls, ['auth switch --hostname github.com --user kvoon9']);
});

test('cancelling the selector and re-picking the active account never call gh', () => {
  const cancelled = run({ selection: null });
  assert.deepEqual(cancelled.ghCalls, []);
  assert.deepEqual(cancelled.notifications, []);

  const active = run({ args: 'kvoon3' });
  assert.deepEqual(active.ghCalls, []);
  assert.match(active.notifications[0].message, /Already using kvoon3/);
});

test('gh failures surface as one error notification', () => {
  const result = run({ fail: true });
  assert.match(result.notifications[0].message, /^gh auth switch failed: error: not logged in to any hosts/);
  assert.equal(result.notifications[0].type, 'error');
});

test('unknown accounts and missing gh config report without switching', () => {
  const unknown = run({ args: 'nobody' });
  assert.deepEqual(unknown.ghCalls, []);
  assert.match(unknown.notifications[0].message, /Unknown GitHub account: nobody/);
  assert.match(unknown.notifications[0].message, /Accounts: kvoon3 \(active\), kvoon9/);

  const noConfig = run({ hosts: null });
  assert.deepEqual(noConfig.selectCalls, []);
  assert.match(noConfig.notifications[0].message, /No GitHub accounts in gh config/);
});
