// The page bundles these modules (Vite builds them); here: only relative imports, no Node globals, and
// they run with Buffer removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));

test('shared modules import only each other and use no Node globals', () => {
  assert.deepEqual(files.sort(), ['approval-proof.js', 'encode.js']);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const [, spec] of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) assert.match(spec, /^\.\/[a-z-]+\.js$/, `${f} imports ${spec}`);
    assert.doesNotMatch(src, /\b(Buffer|process|require|__dirname|global)\b/, f);
  }
});

test('shared modules work with Buffer removed', async () => {
  const saved = globalThis.Buffer;
  globalThis.Buffer = undefined;
  try {
    const { toSorobanArgs } = await import('../approval-proof.js');
    const sample = readFileSync(new URL('../docs/fixtures/approval-proof.sample.json', dir), 'utf8');
    assert.equal(toSorobanArgs(sample).projectId, 'mailmarks');
  } finally {
    globalThis.Buffer = saved;
  }
});

test('package.json lists no dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[k], undefined, k);
});
