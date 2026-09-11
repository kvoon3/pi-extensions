import { test, assert } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// pi's actual level derivation, imported from the installed pi-ai so this test
// fails if pi ever changes the rule (rather than asserting our own assumption).
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Dependencies are hoisted to the repository root, but a dev install may nest
// pi-ai under pi-coding-agent — accept either.
const repoRoot = resolve(pkgRoot, '..');
const resolveInstalled = (...paths) => {
  const found = paths.map((p) => resolve(repoRoot, p)).find(existsSync);
  if (!found) throw new Error(`installed dependency not found: ${paths[0]}`);
  return found;
};
const compatUrl = pathToFileURL(resolveInstalled(
  'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js',
  'node_modules/@earendil-works/pi-ai/dist/compat.js',
)).href;
// The loader is reached through pi's real dist entry so aliases/virtual modules behave.
const piRoot = resolveInstalled('node_modules/@earendil-works/pi-coding-agent/dist/index.js');

/**
 * Build models from a fake catalog by driving the same code path the extension
 * uses: its fetchModels() maps gateway entries, and we then ask pi which
 * thinking levels those models end up with.
 */
function levelsFromGateway(models) {
  const script = `
    const pkg = ${JSON.stringify(pathToFileURL(piRoot).href)};
    const { loadExtensions, createExtensionRuntime } = await import(pkg.replace('/dist/index.js', '/dist/core/extensions/loader.js'));
    const { getSupportedThinkingLevels } = await import(${JSON.stringify(compatUrl)});

    const runtime = createExtensionRuntime();
    let cfg; runtime.registerProvider = (n, c) => { if (n === 'workbuddy') cfg = c; };
    // Serve a fake catalog so the extension's own fetchModels() builds the models.
    globalThis.fetch = async (url) => {
      if (String(url).includes('/models')) {
        return new Response(JSON.stringify({ data: ${JSON.stringify(models)} }), { status: 200 });
      }
      throw new Error('unexpected fetch ' + url);
    };
    const loaded = await loadExtensions([${JSON.stringify(resolve(pkgRoot, 'index.ts'))}], '/tmp', undefined, runtime);
    if (loaded.errors.length) { console.error(JSON.stringify(loaded.errors)); process.exit(1); }
    const out = {};
    for (const m of cfg.models) out[m.id] = { reasoning: m.reasoning, levels: getSupportedThinkingLevels(m) };
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000,
  });
  if (r.status !== 0) throw new Error(r.stderr || 'script failed');
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

test('every model offers all thinking levels, reported or not', () => {
  // Upstream reports efforts for only a few models, but the models it omits do
  // honour reasoning_effort, so the reported list must not gate the offering.
  const got = levelsFromGateway([
    { id: 'hy3', context_length: 192000, max_output_tokens: 64000 },                                  // unreported
    { id: 'glm-5.3', context_length: 1000000, max_output_tokens: 48000, reasoning_efforts: ['low', 'high', 'max'] },
    { id: 'auto', context_length: 168000, max_output_tokens: 32000, reasoning_efforts: ['off'] },     // reported as no reasoning
  ]);

  for (const id of ['hy3', 'glm-5.3', 'auto']) {
    assert.equal(got[id].reasoning, true, `${id} should offer thinking`);
    // xhigh/max are included because pi only accepts them when the map lists
    // them explicitly — a naive map of supported levels would drop both.
    assert.deepStrictEqual(got[id].levels, ALL_LEVELS, `${id} levels`);
  }
});

test('the offered levels do not depend on reasoning_efforts', () => {
  const withEfforts = levelsFromGateway([
    { id: 'm', context_length: 1000, max_output_tokens: 100, reasoning_efforts: ['low', 'high'] },
  ]);
  const withoutEfforts = levelsFromGateway([
    { id: 'm', context_length: 1000, max_output_tokens: 100 },
  ]);
  assert.deepStrictEqual(withoutEfforts.m, withEfforts.m);
});

test('a model without reasoning info still gets its other fields', () => {
  const got = levelsFromGateway([{ id: 'plain', context_length: 128000, max_output_tokens: 8192 }]);
  assert.deepStrictEqual(got.plain, { reasoning: true, levels: ALL_LEVELS });
});
