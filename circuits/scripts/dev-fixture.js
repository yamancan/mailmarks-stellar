// DEV end-to-end fixture: a test-key approval email -> witness -> snarkjs Groth16 proof (DEV key from
// scripts/dev-setup.sh) -> snarkjs verify -> approval-proof.json (shared/approval-proof.js) + the verifying key in
// soroban-sdk bytes (every G2, VK beta/gamma/delta and proof B, written c1‖c0 by the same shared code).
// Writes contracts/approval-registry/tests/fixtures/circom-dev.json; contracts/approval-registry/tests/circom.rs
// submits it through the SDF verifier copy and the registry. Not the delivery key or circuit.
// Run: node circuits/scripts/dev-fixture.js   (after bash circuits/scripts/dev-setup.sh)
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { testKey, approvalEmail } from '../../prover/src/testmail.js';
import { verifyDkimOffline } from '../../prover/src/dkim.js';
import { buildSubject } from '../../prover/src/encode.js';
import { buildApprovalProof, g1Hex, g2Hex } from '../../shared/approval-proof.js';
import { circuitInputs } from '../../prover/src/inputs.js';

const dir = new URL('../build/dev/', import.meta.url);
const wasm = fileURLToPath(new URL('release_approval_test_js/release_approval_test.wasm', dir));
const zkey = fileURLToPath(new URL('dev.zkey', dir));
const OUT = new URL('../../contracts/approval-registry/tests/fixtures/circom-dev.json', import.meta.url);
for (const f of [wasm, zkey]) if (!existsSync(f)) throw new Error('missing ' + f + ': run "bash circuits/scripts/dev-setup.sh" first');

const fields = {
  projectId: 'mailmarks',
  artifactSha256: 'bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac',
  wallet: 'GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN',
}; // docs/template.md reference approval

const key = testKey();
const raw = approvalEmail({ from: 'Approver <approver@mailmarks.test>', to: 'recipient@mailmarks.test', subject: buildSubject(fields),
  domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey });
const r = await verifyDkimOffline(raw, { 'test._domainkey.mailmarks.test': key.record });
const input = circuitInputs({ headers: r.headers, signature: r.signature, publicKey: r.publicKey });

const wtns = { type: 'mem' };
let t = performance.now();
await snarkjs.wtns.calculate(input, wasm, wtns);
const witnessS = (performance.now() - t) / 1000;
t = performance.now();
const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, wtns);
const proveS = (performance.now() - t) / 1000;
const vk = await snarkjs.zKey.exportVerificationKey(zkey);
if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error('snarkjs did not verify the proof');
const peakGB = process.resourceUsage().maxRSS / 1024 / 1024;

const ap = buildApprovalProof({ fields, publicSignals, proof, note: 'DEV proof: test-key email, DEV zkey (scripts/dev-setup.sh); not a delivery proof' });
const affine1 = (p) => p.slice(0, 2);
const affine2 = (p) => p.slice(0, 2);
const fixture = {
  note: 'DEV fixture written by circuits/scripts/dev-fixture.js: circuits/test/release_approval_test.circom (sender approver@mailmarks.test), DEV zkey with one contribution (scripts/dev-setup.sh; machine and times in circuits/build/dev/times.txt and docs/circuit.md). Not the delivery circuit or key. Do not edit.',
  vk: {
    alpha: g1Hex(affine1(vk.vk_alpha_1), 'vk.alpha'),
    beta: g2Hex(affine2(vk.vk_beta_2), 'vk.beta'),
    gamma: g2Hex(affine2(vk.vk_gamma_2), 'vk.gamma'),
    delta: g2Hex(affine2(vk.vk_delta_2), 'vk.delta'),
    ic: vk.IC.map((p, i) => g1Hex(affine1(p), 'vk.ic[' + i + ']')),
  },
  approvalProof: ap,
};
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
console.log(JSON.stringify({ wrote: fileURLToPath(OUT), verified: true, witnessS: +witnessS.toFixed(1), proveS: +proveS.toFixed(1), peakGB: +peakGB.toFixed(1) }));
process.exit(0); // snarkjs keeps worker threads alive
