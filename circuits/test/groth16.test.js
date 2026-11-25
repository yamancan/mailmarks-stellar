// Two Groth16 proofs of one email with the DEV key (circuits/scripts/dev-setup.sh, test circuit). snarkjs draws new
// randomness for each proof, so the proof bytes differ; both must verify and carry the same public signals, so the
// same email always gives the same nullifier. Skipped, with the reason, when the DEV key has not been made.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { requireTools, circuitInputs } from './helpers.js';

const dev = (f) => fileURLToPath(new URL('../build/dev/' + f, import.meta.url));
const FILES = { wasm: dev('release_approval_test_js/release_approval_test.wasm'), zkey: dev('dev.zkey'), vk: dev('dev_vk.json') };
const missing = Object.values(FILES).filter((f) => !existsSync(f));
const REF = {
  projectId: 'mailmarks',
  artifactSha256: 'bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac',
  wallet: 'GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN',
};

// docs/template.md's table of public inputs, as names (wallet_0 ...), and the circuit's outputs in declaration order.
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const templateOrder = [...read('../../docs/template.md').matchAll(/^\| (\d) \| `(\w+)` \|/gm)].map((m) => [Number(m[1]), m[2]]);
const circuitOrder = [...read('../approval.circom').split('template ReleaseApproval(')[1].matchAll(/^\s*signal output (\w+);/gm)].map((m) => m[1]);

after(() => globalThis.curve_bn128?.terminate()); // snarkjs keeps its worker threads otherwise

test('two Groth16 proofs of one email: different proof bytes, both verify, the same public signals and nullifier', {
  skip: missing.length ? 'skipped: no DEV key, run "bash circuits/scripts/dev-setup.sh" (missing ' + missing.join(', ') + ')' : false,
}, async (t) => {
  await requireTools();
  const { testKey, approvalEmail } = await import('../../prover/src/testmail.js');
  const { verifyDkimOffline, dkimKeyHash, nullifierOf } = await import('../../prover/src/dkim.js');
  const { buildSubject, publicSignals } = await import('../../prover/src/encode.js');
  const key = testKey();
  const raw = approvalEmail({ from: 'Approver <approver@mailmarks.test>', to: 'recipient@mailmarks.test', subject: buildSubject(REF),
    domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey });
  const r = await verifyDkimOffline(raw, { 'test._domainkey.mailmarks.test': key.record });
  const input = circuitInputs({ headers: r.headers, signature: r.signature, publicKey: r.publicKey });

  const vk = JSON.parse(readFileSync(FILES.vk, 'utf8'));
  const a = await snarkjs.groth16.fullProve(input, FILES.wasm, FILES.zkey);
  const b = await snarkjs.groth16.fullProve(input, FILES.wasm, FILES.zkey);
  assert.notDeepEqual(a.proof.pi_a, b.proof.pi_a);
  assert.notDeepEqual(a.proof.pi_b, b.proof.pi_b);
  assert.notDeepEqual(a.proof.pi_c, b.proof.pi_c);
  assert.ok(await snarkjs.groth16.verify(vk, a.publicSignals, a.proof), 'first proof verifies');
  assert.ok(await snarkjs.groth16.verify(vk, b.publicSignals, b.proof), 'second proof verifies');
  assert.deepEqual(a.publicSignals, b.publicSignals);

  // public.json order is docs/template.md's: the circuit declares its outputs in the table's order, and the values
  // are the encoder's (shared/encode.js), the pinned key's hash and the signature's nullifier.
  assert.deepEqual(templateOrder.map(([i]) => i), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(circuitOrder.map((n) => n.toLowerCase()), templateOrder.map(([, n]) => n.replaceAll('_', '')));
  assert.deepEqual(a.publicSignals, publicSignals(REF, await dkimKeyHash(r.publicKey), await nullifierOf(r.signature)));
  t.diagnostic('nullifier of both proofs: ' + a.publicSignals[6]);
});
