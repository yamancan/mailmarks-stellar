// Writes the two fixtures that tie the page's encoding to the contract:
//   docs/fixtures/approval-proof.sample.json  a format sample (curve generator points, NOT a real proof) whose key hash
//                                             and nullifier are the native tests' fixed(0x11) and fixed(0x21);
//   contracts/approval-registry/tests/fixtures/page-calls.json
//                                             the page's `submit` arguments and approval key for that sample, as XDR.
// contracts/approval-registry/tests/page_encoding.rs decodes the second and calls the registry with it;
// web/test/fixtures.test.ts fails when either file differs from what this code produces now.
// Run: npm run contract-fixture --prefix web
import { writeFileSync } from 'node:fs';
import { xdr } from '@stellar/stellar-sdk';
import { BN254_P, buildApprovalProof, toSorobanArgs } from '../../shared/approval-proof.js';
import { publicSignals } from '../../shared/encode.js';
import { approvalKey, submitArgs } from '../src/chain.ts';

export const SAMPLE_PATH = new URL('../../docs/fixtures/approval-proof.sample.json', import.meta.url);
export const PAGE_CALLS_PATH = new URL('../../contracts/approval-registry/tests/fixtures/page-calls.json', import.meta.url);

/** contracts/approval-registry/tests/common: `fixed(tag)` = 0x01 then 31 × tag (canonical, below r). */
const fixed = (tag: number) => BigInt('0x01' + tag.toString(16).padStart(2, '0').repeat(31));

export function sample() {
  const fields = {
    projectId: 'mailmarks',
    artifactSha256: 'bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac',
    wallet: 'GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN',
  }; // docs/public-input-vectors.json vector 0
  const g2 = [
    ['10857046999023057135944570762232829481370756359578518086990519993285655852781', '11559732032986387107991004021392285783925812861821192530917403151452391805634'],
    ['8495653923123431417604973247489272438418190587263600148770280649306958101930', '4082367875863433681332203403145435568316851327593401208105741076214120093531'],
    ['1', '0'],
  ];
  // a = G1 generator, b = G2 generator, c = −G1 generator: valid points, so the contract reaches the pairing check.
  const proof = { pi_a: ['1', '2', '1'], pi_b: g2, pi_c: ['1', String(BN254_P - 2n), '1'], protocol: 'groth16', curve: 'bn128' };
  return buildApprovalProof({
    fields,
    publicSignals: publicSignals(fields, fixed(0x11), fixed(0x21)),
    proof,
    note: 'NOT A REAL PROOF: format fixture (curve generator points); it does not verify. docs/approval-proof.md',
  });
}

export function pageCalls(ap: unknown) {
  const a = toSorobanArgs(ap);
  return {
    note: 'Written by web/scripts/contract-fixture.ts from docs/fixtures/approval-proof.sample.json; do not edit.',
    submitArgs: xdr.ScVal.scvVec(submitArgs(a)).toXdr('base64'),
    approvalKey: approvalKey(a.artifactHash).toXdr('base64'),
  };
}

export const asFile = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

if (import.meta.main) {
  const ap = sample();
  writeFileSync(SAMPLE_PATH, asFile(ap));
  writeFileSync(PAGE_CALLS_PATH, asFile(pageCalls(ap)));
  console.log('wrote', SAMPLE_PATH.pathname, PAGE_CALLS_PATH.pathname);
}
