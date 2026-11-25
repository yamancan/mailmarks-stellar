import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseApprovalProof, buildApprovalProof, toSorobanArgs, ApprovalProofError, MAX_FILE_BYTES, BN254_P } from '../approval-proof.js';
import { BN254_R, publicSignals } from '../encode.js';

const SAMPLE = readFileSync(new URL('../../docs/fixtures/approval-proof.sample.json', import.meta.url), 'utf8');
const sample = () => JSON.parse(SAMPLE);
const toSnarkjs = (ap) => ({
  pi_a: [...ap.proof.a, '1'], pi_b: [...ap.proof.b, ['1', '0']], pi_c: [...ap.proof.c, '1'], protocol: 'groth16', curve: 'bn128',
});
const refused = (ap, re) => assert.throws(() => parseApprovalProof(ap), (e) => e instanceof ApprovalProofError && re.test(e.message));

test('the sample is labelled as not a real proof and parses from text', () => {
  const ap = parseApprovalProof(SAMPLE);
  assert.match(ap.note, /^NOT A REAL PROOF/);
});

test('builder output from snarkjs form equals the sample; reader accepts it', () => {
  const s = sample();
  assert.deepEqual(buildApprovalProof({ fields: s.fields, publicSignals: s.publicSignals, proof: toSnarkjs(s), note: s.note }), s);
});

test('toSorobanArgs returns plain strings: G2 as c1‖c0, hashes as 32-byte hex', () => {
  const s = sample();
  const a = toSorobanArgs(s);
  assert.deepEqual(Object.keys(a), ['wallet', 'projectId', 'artifactHash', 'dkimKeyHash', 'nullifier', 'proof']);
  assert.equal(a.wallet, s.fields.wallet);
  assert.equal(a.artifactHash, s.fields.artifactSha256);
  const h = (d) => BigInt(d).toString(16).padStart(64, '0');
  assert.equal(a.proof.b, h(s.proof.b[0][1]) + h(s.proof.b[0][0]) + h(s.proof.b[1][1]) + h(s.proof.b[1][0]));
  assert.equal(a.proof.a, h(s.proof.a[0]) + h(s.proof.a[1]));
  assert.equal(a.nullifier, h(s.publicSignals[6]));
  for (const v of [a.wallet, a.projectId, a.artifactHash, a.dkimKeyHash, a.nullifier, a.proof.a, a.proof.b, a.proof.c]) assert.equal(typeof v, 'string');
});

test('wrong version or network', () => {
  refused({ ...sample(), version: 2 }, /format version 2/);
  refused({ ...sample(), version: '1' }, /format version "1"/);
  refused({ ...sample(), network: 'mainnet' }, /network "mainnet"/);
});

test('bad field grammar', () => {
  refused({ ...sample(), fields: { ...sample().fields, projectId: 'Mailmarks' } }, /"fields": project_id/);
  refused({ ...sample(), fields: { ...sample().fields, artifactSha256: 'BD' + sample().fields.artifactSha256.slice(2) } }, /artifact_sha256/);
  refused({ ...sample(), fields: { ...sample().fields, wallet: sample().fields.wallet.slice(0, -1) + 'A' } }, /wallet/);
});

test('a signal at or above r', () => {
  const s = sample();
  s.publicSignals[6] = String(BN254_R);
  refused(s, /Public signal 6 \(nullifier\) is too large/);
});

test('signals 0–4 must match the fields', () => {
  for (let i = 0; i < 5; i++) {
    const s = sample();
    s.publicSignals[i] = String(BigInt(s.publicSignals[i]) + 1n);
    refused(s, new RegExp(`Public signal ${i} .* does not match "fields"`));
  }
  // Same signals, other fields: the proof is for another approval.
  refused({ ...sample(), fields: { ...sample().fields, projectId: 'other' } }, /Public signal 2 \(project\) does not match/);
});

test('signals 5–6 must match the Soroban hashes', () => {
  let s = sample();
  s.soroban.dkimKeyHash = '12' + s.soroban.dkimKeyHash.slice(2);
  refused(s, /dkimKeyHash does not match public signal 5/);
  s = sample();
  s.publicSignals[6] = '5';
  refused(s, /nullifier does not match public signal 6/);
});

test('Soroban points must match the snarkjs ones (G2 as c1‖c0)', () => {
  let s = sample();
  const b = s.soroban.b;
  s.soroban.b = b.slice(64, 128) + b.slice(0, 64) + b.slice(128); // x written c0‖c1
  refused(s, /soroban\.b does not match proof\.b/);
  s = sample();
  s.proof.a = ['1', '3'];
  refused(s, /soroban\.a does not match proof\.a/);
  s = sample();
  s.proof.c[1] = String(BN254_P);
  refused(s, /proof\.c\[1\] is too large/);
});

test('wrong lengths or types', () => {
  const cases = [
    [(s) => s.publicSignals.pop(), /exactly 7/],
    [(s) => { s.publicSignals[0] = 1; }, /decimal number written as a string/],
    [(s) => { s.publicSignals[0] = '01'; }, /decimal number/],
    [(s) => { s.soroban.a = s.soroban.a.slice(2); }, /soroban\.a must be 128 lowercase hex/],
    [(s) => { s.soroban.c = s.soroban.c.toUpperCase(); }, /soroban\.c must be 128 lowercase hex/],
    [(s) => { s.proof.b = s.proof.b[0]; }, /proof\.b\[0\] must be a pair/],
    [(s) => { s.proof.a.push('1'); }, /proof\.a must be \[x, y\]/],
    [(s) => { delete s.soroban; }, /missing "soroban"/],
    [(s) => { s.extra = 1; }, /unexpected entry "extra"/],
    [(s) => { s.fields.wallet = null; }, /must be strings/],
    [(s) => { s.note = 5; }, /"note" must be a string/],
  ];
  for (const [mut, re] of cases) {
    const s = sample();
    mut(s);
    refused(s, re);
  }
  refused('{not json', /not JSON/);
  refused(' '.repeat(MAX_FILE_BYTES + 1), /too large/);
  refused([], /must be an object/);
  refused(null, /must be an object/);
});

test('builder refuses non-affine or non-snarkjs proofs', () => {
  const s = sample();
  const sig = publicSignals(s.fields, 1n, 2n);
  const p = toSnarkjs(s);
  assert.throws(() => buildApprovalProof({ fields: s.fields, publicSignals: sig, proof: { ...p, pi_a: ['0', '1', '0'] } }), /point at infinity/);
  assert.throws(() => buildApprovalProof({ fields: s.fields, publicSignals: sig, proof: { ...p, curve: 'bls12381' } }), /groth16 bn128/);
  assert.equal(buildApprovalProof({ fields: s.fields, publicSignals: sig, proof: p }).soroban.nullifier, '0'.repeat(63) + '2');
});
