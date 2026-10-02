import { test, assert } from 'vitest';
import { detectProvider, PROVIDER_MAP } from '../usage.js';

test('detectProvider maps chatgpt oauth providers to the codex usage source', () => {
  // pi < 1.0.0 served ChatGPT OAuth models through the openai-codex provider.
  assert.equal(detectProvider('openai-codex'), 'codex');
  // pi 1.0.0 serves them as provider "openai" with a direct api.openai.com
  // token; the usage fetch resolves a wham-compatible credential on its own.
  assert.equal(detectProvider('openai'), 'codex');
});

test('detectProvider leaves unmapped providers to the extension default', () => {
  assert.equal(detectProvider('unknown-provider'), null);
  assert.ok(PROVIDER_MAP['anthropic']);
});
