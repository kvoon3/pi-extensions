import { test, assert } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseGhHosts, parseRemoteHost, resolveHostAccounts } from '../github.js';

// Same shape gh writes to ~/.config/gh/hosts.yml
const HOSTS = `github.com:
    git_protocol: https
    users:
        kvoon3:
        kvoon9:
    user: kvoon3
`;

test('parseGhHosts reads the active user and the account list', () => {
  const hosts = parseGhHosts(HOSTS);
  const github = hosts.get('github.com');
  assert.deepEqual(github, { user: 'kvoon3', accounts: ['kvoon3', 'kvoon9'] });
});

test('parseGhHosts keeps hosts separate', () => {
  const hosts = parseGhHosts(`github.com:
    users:
        kvoon3:
    user: kvoon3
ghe.corp.example.com:
    users:
        kvoon-work:
    user: kvoon-work
`);
  assert.equal(hosts.get('github.com')?.user, 'kvoon3');
  assert.deepEqual(hosts.get('ghe.corp.example.com'), { user: 'kvoon-work', accounts: ['kvoon-work'] });
});

test('parseGhHosts tolerates comments and missing users block', () => {
  const hosts = parseGhHosts(`# leading comment
github.com:
    user: kvoon9
`);
  assert.deepEqual(hosts.get('github.com'), { user: 'kvoon9', accounts: [] });
});

test('parseRemoteHost handles https, scp-like and ssh URLs', () => {
  assert.equal(parseRemoteHost('https://github.com/kvoon3/pi-extensions.git'), 'github.com');
  assert.equal(parseRemoteHost('git@github.com:kvoon9/dotfiles.git'), 'github.com');
  assert.equal(parseRemoteHost('ssh://git@ghe.example.com:22/team/repo.git'), 'ghe.example.com');
  assert.equal(parseRemoteHost('git://github.com/kvoon3/repo'), 'github.com');
});

test('parseRemoteHost rejects filesystem remotes', () => {
  assert.equal(parseRemoteHost(null), null);
  assert.equal(parseRemoteHost(''), null);
  assert.equal(parseRemoteHost('/Users/kvoon/code/repo'), null);
  assert.equal(parseRemoteHost('../sibling'), null);
  assert.equal(parseRemoteHost('C:\\code\\repo'), null);
  assert.equal(parseRemoteHost('C:/code/repo'), null);
});

test('resolveHostAccounts prefers the remote host and puts the active account first', () => {
  assert.deepEqual(resolveHostAccounts(HOSTS, 'git@github.com:kvoon9/dotfiles.git'), {
    host: 'github.com', active: 'kvoon3', accounts: ['kvoon3', 'kvoon9'],
  });
});

test('resolveHostAccounts falls back to github.com outside a repo, dedupes, and tolerates missing config', () => {
  assert.deepEqual(resolveHostAccounts(HOSTS, null), { host: 'github.com', active: 'kvoon3', accounts: ['kvoon3', 'kvoon9'] });
  // Active account missing from the users list must not be duplicated.
  assert.deepEqual(resolveHostAccounts('github.com:\n    users:\n        kvoon3:\n    user: kvoon3\n', null), {
    host: 'github.com', active: 'kvoon3', accounts: ['kvoon3'],
  });
  assert.deepEqual(resolveHostAccounts(null, null), { host: 'github.com', active: null, accounts: [] });
});

// ============ Footer rendering (real pi loader, temp HOME) ============

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

/** Boot the real extension through pi's loader with a temp HOME/gh config and
 *  an optional origin remote, then render the footer at 200 columns. */
function renderFooter({ hosts, remote, env = {} }: { hosts: string | null; remote: string | null; env?: Record<string, string> }): string[] {
  const home = mkdtempSync(join(tmpdir(), 'pi-footer-github-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pi-footer-cwd-'));
  try {
    if (hosts !== null) {
      mkdirSync(join(home, '.config', 'gh'), { recursive: true });
      writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), hosts);
    }
    if (remote) {
      spawnSync('git', ['init', '-q'], { cwd });
      spawnSync('git', ['remote', 'add', 'origin', remote], { cwd });
    }

    const loader = pathToFileURL(installedPackage('node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href;
    const script = `
      const { loadExtensions, createExtensionRuntime } = await import(${JSON.stringify(loader)});
      const loaded = await loadExtensions([${JSON.stringify(resolve(pkgRoot, 'index.ts'))}], process.cwd(), undefined, createExtensionRuntime());
      if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
      const handlers = loaded.extensions[0].handlers.get('session_start') ?? [];
      if (!handlers.length) throw new Error('session_start not registered');
      let footerFactory = null;
      const ctx = {
        hasUI: true,
        cwd: process.cwd(),
        model: null,
        ui: { theme: { fg: (_color, text) => text }, notify() {}, setStatus() {}, setFooter(factory) { footerFactory = factory; } },
        sessionManager: { getEntries: () => [], getLeafId: () => null },
      };
      await handlers[0]({}, ctx);
      if (!footerFactory) throw new Error('setFooter was not called');
      const theme = { fg: (_color, text) => text };
      const footer = footerFactory({ requestRender() {} }, theme, { onBranchChange: () => () => {} });
      console.log(JSON.stringify(footer.render(200)));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, GH_CONFIG_DIR: join(home, '.config', 'gh'), ...env },
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('footer shows the active gh account', () => {
  const lines = renderFooter({ hosts: HOSTS, remote: null });
  assert.ok(lines.some((line) => line.includes('gh:kvoon3')), lines.join('\n'));
});

test('footer follows the remote host to a different gh host entry', () => {
  const hosts = `github.com:
    users:
        kvoon3:
    user: kvoon3
ghe.corp.example.com:
    users:
        kvoon-work:
    user: kvoon-work
`;
  const lines = renderFooter({ hosts, remote: 'git@ghe.corp.example.com:team/repo.git' });
  assert.ok(lines.some((line) => line.includes('gh:kvoon-work')), lines.join('\n'));
});

test('footer omits the badge without gh config and honors the env toggle', () => {
  const noConfig = renderFooter({ hosts: null, remote: 'https://github.com/kvoon3/pi-extensions.git' });
  assert.ok(!noConfig.join('\n').includes('gh:'), noConfig.join('\n'));
  const disabled = renderFooter({ hosts: HOSTS, remote: null, env: { PI_MINIMAL_FOOTER_SHOW_GITHUB: '0' } });
  assert.ok(!disabled.join('\n').includes('gh:'), disabled.join('\n'));
});
