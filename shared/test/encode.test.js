import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSignals, isAccountStrkey } from '../encode.js';

test('docs/public-input-vectors.json through the shared encoder', () => {
  const { order, vectors } = JSON.parse(readFileSync(new URL('../../docs/public-input-vectors.json', import.meta.url)));
  assert.ok(vectors.length >= 2);
  for (const { fields, signals } of vectors) {
    assert.deepEqual(publicSignals(fields, 3n, 4n), [...order.slice(0, 5).map((k) => signals[k]), '3', '4']);
  }
});

test('strkey: non-strings and lowercase are refused (the comparison with stellar-sdk is in prover/test)', () => {
  for (const v of [undefined, null, 5, 'ga4tzt44mm6g4jhk4afshgdmxshw3xjlloewcsbpa7lcput6fyxex2kn']) assert.equal(isAccountStrkey(v), false);
  assert.equal(isAccountStrkey('GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN'), true);
});
