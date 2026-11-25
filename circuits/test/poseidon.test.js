// circuits 6.3.4 PoseidonLarge(121, 17) equals helpers 6.4.2 poseidonLarge(x, 9, 242) (docs/toolchain.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { poseidonLarge } from '@zk-email/helpers/dist/hash.js';
import { toCircomBigIntBytes } from '@zk-email/helpers/dist/binary-format.js';
import { readFileSync, readdirSync } from 'node:fs';
import { requireTools, compile } from './helpers.js';

test('circuit PoseidonLarge(121, 17) equals the prover poseidonLarge(x, 9, 242)', async () => {
  await requireTools();
  const c = await compile('poseidon_large_test.circom');
  const values = [0n, 1n, (1n << 2048n) - 1n, (1n << 2057n) - 1n];
  for (let i = 0; i < 8; i++) values.push(BigInt('0x' + randomBytes(256).toString('hex')));
  for (const x of values) {
    const w = await c.calculateWitness({ in: toCircomBigIntBytes(x) }, true);
    await c.checkConstraints(w);
    assert.equal(String(w[1]), String(await poseidonLarge(x, 9, 242)), x.toString(16));
  }
});

// The DKIM registry is deployed with each pinned record's keyHash; the circuit's public signal 5 must equal it.
test('each pinned key record\'s keyHash (prover/keys) is the circuit\'s pubkeyHash of its modulus', async () => {
  await requireTools();
  const { keyFromTxt } = await import('../../prover/src/prove.js');
  const c = await compile('poseidon_large_test.circom');
  const dir = new URL('../../prover/keys/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('trionlabs.dev-google.json'), 'the delivery key record is pinned');
  for (const f of files) {
    const rec = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    const w = await c.calculateWitness({ in: toCircomBigIntBytes(keyFromTxt(rec.txt).n) }, true);
    assert.equal(String(w[1]), rec.keyHash, f);
  }
});
