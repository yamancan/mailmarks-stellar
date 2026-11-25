// approval-proof.json: the one file that leaves the prover machine (docs/approval-proof.md). The prover writes it with
// buildApprovalProof, the page reads it with parseApprovalProof; both run the same checks. Browser-safe, no dependencies.
import { BN254_R, encodeFields, validateFields } from './encode.js';

// BN254 base field modulus: every point coordinate must be below it.
export const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const MAX_FILE_BYTES = 64 * 1024;
const DEC_RE = /^(0|[1-9][0-9]{0,77})$/;
const SIGNAL_NAMES = ['wallet part 1', 'wallet part 2', 'project', 'artifact hash (first half)', 'artifact hash (second half)', 'DKIM key hash', 'nullifier'];

export class ApprovalProofError extends Error {}
const fail = (msg) => { throw new ApprovalProofError(msg); };

const hex32 = (n) => n.toString(16).padStart(64, '0');
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function keys(obj, where, required, optional = []) {
  if (!isObj(obj)) fail(`${where} must be an object.`);
  for (const k of required) if (!(k in obj)) fail(`${where} is missing "${k}".`);
  for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) fail(`${where} has an unexpected entry "${k}".`);
}

function dec(v, where, max) {
  if (typeof v !== 'string' || !DEC_RE.test(v)) fail(`${where} must be a decimal number written as a string.`);
  const n = BigInt(v);
  if (n >= max) fail(`${where} is too large for the BN254 curve.`);
  return n;
}

function hex(v, where, bytes) {
  if (typeof v !== 'string' || v.length !== bytes * 2 || !/^[0-9a-f]*$/.test(v)) fail(`${where} must be ${bytes * 2} lowercase hex characters.`);
  return v;
}

// snarkjs decimals -> soroban-sdk BN254 bytes: Fp big-endian, G1 = X‖Y, G2 = X‖Y with each Fp2 as c1‖c0
// (snarkjs keeps Fp2 as [c0, c1]).
export function g1Hex(pt, where) {
  if (!Array.isArray(pt) || pt.length !== 2) fail(`${where} must be [x, y].`);
  return pt.map((c, i) => hex32(dec(c, `${where}[${i}]`, BN254_P))).join('');
}
export function g2Hex(pt, where) {
  if (!Array.isArray(pt) || pt.length !== 2) fail(`${where} must be [[x0, x1], [y0, y1]].`);
  return pt.map((fp2, i) => {
    if (!Array.isArray(fp2) || fp2.length !== 2) fail(`${where}[${i}] must be a pair.`);
    const [c0, c1] = fp2.map((c, j) => hex32(dec(c, `${where}[${i}][${j}]`, BN254_P)));
    return c1 + c0;
  }).join('');
}

/** Checks a parsed or raw approval-proof.json; returns the object. Throws ApprovalProofError with a plain message. */
export function parseApprovalProof(input) {
  let ap = input;
  if (typeof input === 'string') {
    if (input.length > MAX_FILE_BYTES) fail('This file is too large to be an approval proof.');
    try { ap = JSON.parse(input); } catch { fail('This file is not an approval proof (it is not JSON).'); }
  }
  keys(ap, 'The approval proof', ['version', 'network', 'fields', 'publicSignals', 'proof', 'soroban'], ['note']);
  if (ap.version !== 1) fail(`This approval proof has format version ${JSON.stringify(ap.version)}; this page reads version 1.`);
  if (ap.network !== 'testnet') fail(`This approval proof is for network ${JSON.stringify(ap.network)}; only "testnet" is supported.`);
  if ('note' in ap && typeof ap.note !== 'string') fail('"note" must be a string.');

  keys(ap.fields, '"fields"', ['projectId', 'artifactSha256', 'wallet']);
  try { validateFields(ap.fields); } catch (e) { fail(`"fields": ${e.message}.`); }

  const sig = ap.publicSignals;
  if (!Array.isArray(sig) || sig.length !== 7) fail('"publicSignals" must list exactly 7 values.');
  const s = sig.map((v, i) => dec(v, `Public signal ${i} (${SIGNAL_NAMES[i]})`, BN254_R));
  const e = encodeFields(ap.fields);
  [e.wallet0, e.wallet1, e.projectId, e.artifactHi, e.artifactLo].forEach((want, i) => {
    if (s[i] !== want) fail(`Public signal ${i} (${SIGNAL_NAMES[i]}) does not match "fields"; the proof is for a different approval.`);
  });

  keys(ap.proof, '"proof"', ['a', 'b', 'c']);
  const a = g1Hex(ap.proof.a, 'proof.a'), b = g2Hex(ap.proof.b, 'proof.b'), c = g1Hex(ap.proof.c, 'proof.c');

  keys(ap.soroban, '"soroban"', ['a', 'b', 'c', 'dkimKeyHash', 'nullifier']);
  const so = ap.soroban;
  if (hex(so.a, 'soroban.a', 64) !== a) fail('soroban.a does not match proof.a.');
  if (hex(so.b, 'soroban.b', 128) !== b) fail('soroban.b does not match proof.b (G2 is written c1‖c0).');
  if (hex(so.c, 'soroban.c', 64) !== c) fail('soroban.c does not match proof.c.');
  if (hex(so.dkimKeyHash, 'soroban.dkimKeyHash', 32) !== hex32(s[5])) fail('soroban.dkimKeyHash does not match public signal 5.');
  if (hex(so.nullifier, 'soroban.nullifier', 32) !== hex32(s[6])) fail('soroban.nullifier does not match public signal 6.');
  return ap;
}

/** Prover side: snarkjs proof and public signals -> a checked approval-proof object (write with JSON.stringify). */
export function buildApprovalProof({ fields, publicSignals, proof, note }) {
  const z1 = (p) => Array.isArray(p) && p.length === 3 && p[2] === '1';
  if (!isObj(proof) || proof.protocol !== 'groth16' || proof.curve !== 'bn128') fail('Expected a snarkjs groth16 bn128 proof.');
  const b2 = proof.pi_b?.[2];
  if (!z1(proof.pi_a) || !z1(proof.pi_c) || !Array.isArray(proof.pi_b) || proof.pi_b.length !== 3 || b2?.[0] !== '1' || b2?.[1] !== '0') {
    fail('Expected snarkjs affine points (z = 1); a point at infinity is not a valid proof.');
  }
  const pr = { a: proof.pi_a.slice(0, 2), b: proof.pi_b.slice(0, 2), c: proof.pi_c.slice(0, 2) };
  if (!Array.isArray(publicSignals) || publicSignals.length !== 7) fail('Expected 7 public signals.');
  const s = publicSignals.map((v, i) => dec(v, `Public signal ${i} (${SIGNAL_NAMES[i]})`, BN254_R));
  const ap = {
    version: 1,
    network: 'testnet',
    ...(note === undefined ? {} : { note }),
    fields: { projectId: fields?.projectId, artifactSha256: fields?.artifactSha256, wallet: fields?.wallet },
    publicSignals: [...publicSignals],
    proof: pr,
    soroban: { a: g1Hex(pr.a, 'proof.a'), b: g2Hex(pr.b, 'proof.b'), c: g1Hex(pr.c, 'proof.c'), dkimKeyHash: hex32(s[5]), nullifier: hex32(s[6]) },
  };
  return parseApprovalProof(ap);
}

/** Arguments of the registry's `submit`, as plain strings and hex (the page builds the ScVals with its own stellar-sdk). */
export function toSorobanArgs(input) {
  const ap = parseApprovalProof(input);
  return {
    wallet: ap.fields.wallet,
    projectId: ap.fields.projectId,
    artifactHash: ap.fields.artifactSha256,
    dkimKeyHash: ap.soroban.dkimKeyHash,
    nullifier: ap.soroban.nullifier,
    proof: { a: ap.soroban.a, b: ap.soroban.b, c: ap.soroban.c },
  };
}
