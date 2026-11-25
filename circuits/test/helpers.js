// Test helpers: circuit inputs from a signed header buffer, and a raw signer for buffers the prover would refuse.
import { createPublicKey, createSign, privateEncrypt, constants } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { wasm as wasmTester } from 'circom_tester';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Hash } from '@zk-email/helpers/dist/lib/fast-sha256.js';
import { toCircomBigIntBytes } from '@zk-email/helpers/dist/binary-format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SENDER = 'approver@mailmarks.test';

export async function requireTools() {
  let v = '';
  try { v = execFileSync('circom', ['--version'], { encoding: 'utf8' }); } catch {}
  if (!v.includes('2.2.3')) throw new Error('circom 2.2.3 must be on PATH (docs/toolchain.md); found: ' + (v.trim() || 'none'));
  if (!existsSync(path.join(here, '../../prover/node_modules/@zk-email/helpers'))) {
    throw new Error('the tests sign emails with prover/ code: run "npm ci --prefix prover" first');
  }
  inputs = await import('../../prover/src/inputs.js');
}

export const compile = (file) => wasmTester(path.join(here, file), { include: [path.join(here, '../node_modules')] });

export const modulusOf = (privateKey) =>
  BigInt('0x' + Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).n, 'base64url').toString('hex'));

// Sign canonical header lines ("name:value") the way a relaxed/relaxed DKIM signer does: each line + CRLF,
// then the DKIM-Signature line itself with an empty b= and no CRLF. Used for buffers the prover refuses
// (duplicates, missing headers, bad grammar), so the circuit's own rejection is what the test sees.
export function signLines(lines, privateKey) {
  const names = lines.map((l) => l.slice(0, l.indexOf(':')).toLowerCase()).join(':');
  const data = lines.map((l) => l + '\r\n').join('') +
    'dkim-signature:v=1; a=rsa-sha256; c=relaxed/relaxed; d=mailmarks.test; s=test; h=' + names +
    '; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=; b=';
  const sig = createSign('RSA-SHA256').update(data, 'latin1').sign(privateKey);
  return { headers: Buffer.from(data, 'latin1'), signature: BigInt('0x' + sig.toString('hex')), publicKey: modulusOf(privateKey) };
}

// RSA PKCS#1 v1.5 / SHA-256 signature over a buffer that already carries its padding, hashed block by block as
// given (no padding added). Lets a test sign a buffer whose SHA padding is not the canonical one, so the circuit's own
// padding check is what rejects it, not the RSA check. Returns the circuit's signature limbs.
const SHA256_DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');
export function signPadded(padded, privateKey) {
  assert.equal(padded.length % 64, 0, 'a padded buffer is whole 64-byte blocks');
  const digest = Buffer.from(new Hash().update(Uint8Array.from(padded)).cacheState());
  const sig = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA256_DIGEST_INFO, digest]));
  return toCircomBigIntBytes(BigInt('0x' + sig.toString('hex')));
}

// Loaded by requireTools(), after it has checked that prover/ is installed (a plain message instead of a module error).
let inputs;
export const circuitInputs = (...a) => inputs.circuitInputs(...a);

// The 7 public signals (witness 1..7) as decimal strings.
export const publicOut = (w) => w.slice(1, 8).map(String);

// Where the circuit must fail: a unique line of approval.circom (checked by its template line number) or a regex
// over the error. Both mean the witness cannot satisfy the constraints, so no proof exists.
const SRC = readFileSync(path.join(here, '../approval.circom'), 'utf8').split('\n');
export function lineOf(snippet) {
  const hits = SRC.flatMap((l, i) => (l.includes(snippet) ? [i + 1] : []));
  assert.equal(hits.length, 1, 'snippet must name one line of approval.circom: ' + snippet);
  return hits[0];
}

// circom_tester's witness calculator never clears its error text, so each failure appends to the last one:
// only the lines after the previous failure belong to this call. They run innermost first: a regex is matched
// against the first (innermost template), a snippet against the first ReleaseApproval line (its own check or the
// line that calls the failing sub-template).
export function rejecter(circuit) {
  let seen = '';
  return async (input, where) => {
    const re = typeof where === 'string' ? new RegExp('^Error in template ReleaseApproval_\\d+ line: ' + lineOf(where) + '$') : where;
    await assert.rejects(circuit.calculateWitness(input, true), (e) => {
      const all = String(e);
      assert.ok(all.startsWith(seen) && all.length > seen.length, 'unexpected error text: ' + all.slice(0, 300));
      const fresh = all.slice(seen.length).split('\n');
      const first = (typeof where === 'string' ? fresh.find((l) => /^Error in template ReleaseApproval_/.test(l)) : fresh.find((l) => l.startsWith('Error in template'))) ?? '';
      seen = all;
      assert.match(all, /Assert Failed/);
      assert.match(first, re);
      return true;
    });
  };
}
