import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// pi's actual level derivation, imported from the installed pi-ai so this test
// fails if pi ever changes the rule (rather than asserting our own assumption).
const pkgRoot = dirname(fileURLToPath(import.meta.url));
// Dependencies are hoisted to the repository root, not the package dir.
const repoRoot = resolve(pkgRoot, '..');
const compatUrl = pathToFileURL(
  resolve(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js'),
).href;

/**
 * Build models from a fake catalog by driving the same code path the extension
 * uses: its fetchModels() maps gateway entries through reasoningConfig(), and we
 * then ask pi which thinking levels those models end up with.
 */
function levelsFromGateway(models) {
  const script = `
    const pkg = '${pathToFileURL(resolve(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href}';
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

test('reasoning levels are derived from the gateway efforts list', () => {
  const models = [
    { id: 'hy3', context_length: 192000, max_output_tokens: 64000, reasoning_efforts: ['off', 'low', 'high'] },
    { id: 'glm-5.2', context_length: 1000000, max_output_tokens: 48000, reasoning_efforts: ['off', 'high', 'xhigh'] },
    { id: 'flash', context_length: 1000000, max_output_tokens: 128000, reasoning_efforts: ['off', 'low', 'high', 'max'] },
  ];
  const got = levelsFromGateway(models);

  // xhigh/max must be listed explicitly in thinkingLevelMap, so this catches a
  // naive implementation that only records supported levels and drops them.
  assert.deepEqual(got.hy3, { reasoning: true, levels: ['off', 'low', 'high'] });
  assert.deepEqual(got['glm-5.2'], { reasoning: true, levels: ['off', 'high', 'xhigh'] });
  assert.deepEqual(got.flash, { reasoning: true, levels: ['off', 'low', 'high', 'max'] });
});

test('models without reported efforts offer no thinking', () => {
  const got = levelsFromGateway([
    { id: 'auto', context_length: 168000, max_output_tokens: 32000 },
    { id: 'off-only', context_length: 1000, max_output_tokens: 100, reasoning_efforts: ['off'] },
    { id: 'empty', context_length: 1000, max_output_tokens: 100, reasoning_efforts: [] },
  ]);
  for (const id of ['auto', 'off-only', 'empty']) {
    assert.deepEqual(got[id], { reasoning: false, levels: ['off'] }, `${id} should not offer thinking`);
  }
});

test('catalog entries with unexpected levels do not crash the mapping', () => {
  // Defensive: a future upstream might add levels pi does not know about.
  const got = levelsFromGateway([
    { id: 'future', context_length: 1000, max_output_tokens: 100, reasoning_efforts: ['off', 'ULTRA', ' High '] },
  ]);
  assert.deepEqual(got.future, { reasoning: true, levels: ['off', 'high'] });
});
