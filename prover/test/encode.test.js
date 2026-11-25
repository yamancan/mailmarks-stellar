import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubject, parseSubject, encodeFields, publicSignals, packAscii31 } from '../src/encode.js';

import { readFileSync } from 'node:fs';
import { REF } from './ref.js';

test('encoding matches docs/public-input-vectors.json (Python-computed, shared with the contract tests)', () => {
  const { order, vectors } = JSON.parse(readFileSync(new URL('../../docs/public-input-vectors.json', import.meta.url)));
  assert.deepEqual(order, ['wallet_0', 'wallet_1', 'project_id', 'artifact_hi', 'artifact_lo', 'dkim_key_hash', 'nullifier']);
  assert.ok(vectors.length >= 2);
  for (const { fields, signals } of vectors) {
    assert.deepEqual(publicSignals(fields, 1n, 2n), [...order.slice(0, 5).map((k) => signals[k]), '1', '2']);
  }
});

test('subject round trip and exact format', () => {
  const s = buildSubject(REF);
  assert.equal(s, `emailmark mailmarks ${REF.artifactSha256} ${REF.wallet}`);
  assert.deepEqual(parseSubject(s), REF);
});

test('malformed subjects are rejected', () => {
  const good = buildSubject(REF);
  for (const bad of [
    good.replace('emailmark', 'Emailmark'),
    good.replace('emailmark', 'EMAILMARK'),
    good.replace('emailmark ', 'APPROVE RELEASE '), // the SOW's prefix, before the owner's 21 Nov decision
    good.replace('emailmark ', 'emailmark  '),
    'Re: ' + good,
    good.replace('mailmarks ', 'mailmarks  '),
    good + ' ',
    good.replace('mailmarks', 'Mailmarks'),
    good.replace('mailmarks', '-mailmarks'),
    good.replace('mailmarks', 'x'.repeat(32)),
    good.replace(REF.artifactSha256, REF.artifactSha256.toUpperCase()),
    good.replace(REF.artifactSha256, REF.artifactSha256.slice(1)),
    good.replace(REF.wallet, REF.wallet.slice(0, -1) + 'A'), // bad strkey checksum
    good.replace(REF.wallet, 'C' + REF.wallet.slice(1)),
  ]) assert.throws(() => parseSubject(bad), undefined, bad);
});

test('missing fields and non-bigint hashes are rejected, never serialized as "undefined"', () => {
  assert.throws(() => buildSubject({ ...REF, projectId: undefined }), /must be strings/);
  assert.throws(() => publicSignals(REF, undefined, 1n), /must be bigint/);
  assert.throws(() => publicSignals(REF, 1n, '5'), /must be bigint/);
});

test('packAscii31 bounds', () => {
  assert.throws(() => packAscii31(''));
  assert.throws(() => packAscii31('a'.repeat(32)));
  assert.equal(packAscii31('a'), 0x61n << 240n);
});

test('shared strkey check agrees with stellar-sdk StrKey', async () => {
  const { Keypair, StrKey } = await import('@stellar/stellar-sdk');
  const { isAccountStrkey } = await import('../../shared/encode.js');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const cases = [];
  for (let k = 0; k < 50; k++) {
    const kp = Keypair.random();
    const g = kp.publicKey();
    cases.push(g, flip(g, k % 56), g.slice(0, -1), g + 'A', g.slice(0, 55) + '=', kp.secret()); // valid, flipped, short, long, bad char, S version
    cases.push(StrKey.encodeContract(kp.rawPublicKey()), StrKey.encodeMed25519PublicKey(Buffer.concat([kp.rawPublicKey(), Buffer.alloc(8)])));
  }
  for (const s of cases) assert.equal(isAccountStrkey(s), StrKey.isValidEd25519PublicKey(s), s);
  assert.ok(cases.filter((s) => isAccountStrkey(s)).length >= 50);
});
