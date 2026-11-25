// Local prover: a saved .eml -> approval-proof.json, offline. No network, no DNS: the DKIM key comes from a dated record
// pinned in prover/keys/. Every check the circuit makes is made here first, with a plain message (docs/prover.md).
// The witness stays in memory; the email, its header and the witness are never written or logged.
import { readFileSync, readdirSync, existsSync, lstatSync, mkdtempSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { verifyDkimOffline, dkimKeyHash } from './dkim.js';
import { parseSubject, SUBJECT_PREFIX } from './encode.js';
import { circuitInputs, MAX_SIGNED_HEADER } from './inputs.js';
import { buildApprovalProof } from '../../shared/approval-proof.js';

export class ProverError extends Error {}
const fail = (msg) => { throw new ProverError(msg); };
const repo = (p) => fileURLToPath(new URL('../../' + p, import.meta.url));
const OUTPUT_EXISTS = 'The output already exists. Choose another path with --out.';

/**
 * The circuits the prover knows, and where their proving files are. The email's From address picks one:
 * - delivery: circuits/release_approval.circom, its key made on the Mac (circuits/scripts/delivery-setup.sh), files in circuits/build/delivery/;
 * - test: circuits/test/release_approval_test.circom, the DEV key from circuits/scripts/dev-setup.sh.
 */
export const CIRCUITS = [
  { name: 'delivery', sender: 'mintmarks@trionlabs.dev', dir: 'circuits/build/delivery', wasm: 'release_approval_js/release_approval.wasm', zkey: 'release_approval.zkey', vk: 'release_approval_vk.json',
    missing: 'Use the delivery files whose hashes docs/setup.md lists (the Docker image carries them). A new key made with delivery-setup.sh gives proofs the deployed registry refuses.' },
  { name: 'test', sender: 'approver@mailmarks.test', dir: 'circuits/build/dev', wasm: 'release_approval_test_js/release_approval_test.wasm', zkey: 'dev.zkey', vk: 'dev_vk.json',
    missing: 'Run "bash circuits/scripts/dev-setup.sh" to make the DEV key.' },
];
export const KEYS_DIR = repo('prover/keys');
const domainOf = (sender) => sender.split('@')[1];

/** RSA modulus and exponent from a DKIM TXT record's p= tag. */
export function keyFromTxt(txt) {
  if ((txt.match(/(?:^|;)\s*p=/g) ?? []).length > 1) fail('The pinned DKIM record has more than one public key (p=).');
  const p = /(?:^|;)\s*p=([A-Za-z0-9+/=\s]+)/.exec(txt)?.[1]?.replace(/\s/g, '');
  if (!p) fail('The pinned DKIM record has no public key (p=).');
  let jwk;
  try { jwk = createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' }).export({ format: 'jwk' }); } catch { fail('The pinned DKIM record does not hold a readable RSA public key.'); }
  if (jwk.kty !== 'RSA') fail('The pinned DKIM record is not an RSA key.');
  const big = (b64) => BigInt('0x' + Buffer.from(b64, 'base64url').toString('hex'));
  return { n: big(jwk.n), e: big(jwk.e) };
}

/** A key record as kept in prover/keys/<domain>-<selector>.json, derived from the DNS TXT text. */
export async function keyRecord({ domain, selector, txt, fetched, source }) {
  const { n, e } = keyFromTxt(txt);
  return { domain, selector, dnsName: selector + '._domainkey.' + domain, txt, fetched, source,
    modulusBits: n.toString(2).length, exponent: Number(e), keyHash: String(await dkimKeyHash(n)) };
}

/** The pinned records for one domain, checked (RSA-2048, e = 65537, fields consistent): { dnsName: record }. */
export async function loadKeys(dir, domain) {
  const keys = {};
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : []) {
    let k;
    try { k = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { fail('The key record ' + f + ' is not valid JSON.'); }
    if (k.domain !== domain) continue;
    for (const field of ['selector', 'txt', 'fetched', 'modulusBits', 'exponent', 'keyHash']) {
      if (k[field] === undefined) fail('The key record ' + f + ' has no "' + field + '".');
    }
    const { n, e } = keyFromTxt(k.txt);
    const bits = n.toString(2).length;
    if (bits !== 2048) fail('The pinned DKIM key ' + f + ' is a ' + bits + '-bit RSA key; the circuit needs RSA-2048.');
    if (e !== 65537n) fail('The pinned DKIM key ' + f + ' has exponent ' + e + '; the circuit needs 65537.');
    if (k.modulusBits !== bits || k.exponent !== 65537 || k.keyHash !== String(await dkimKeyHash(n))) {
      fail('The key record ' + f + ' does not match its own key (modulusBits, exponent or keyHash).');
    }
    keys[k.selector + '._domainkey.' + domain] = k;
  }
  if (!Object.keys(keys).length) {
    fail('There is no pinned DKIM key for ' + domain + ' in ' + dir + '. The prover never looks keys up online; add the dated key record first (docs/prover.md).');
  }
  return keys;
}

/** The address in a raw From header value (for picking the circuit only; the signed From is checked later). */
function rawFromAddress(raw) {
  const head = raw.toString('latin1').split(/\r?\n\r?\n/)[0];
  const value = /^from[ \t]*:(.*(?:\r?\n[ \t].*)*)/im.exec(head)?.[1] ?? '';
  return (/<([^>]*)>/.exec(value)?.[1] ?? value).trim();
}

/**
 * Every check the circuit makes, on the raw email: returns { circuit, dkim, fields, keyHash } or throws a ProverError with a
 * plain message. Nothing from the email is put in a message.
 */
export async function checkEmail(raw, { keysDir = KEYS_DIR } = {}) {
  const circuit = CIRCUITS.find((c) => c.sender === rawFromAddress(raw));
  if (!circuit) fail('This email is not from a configured sender (' + CIRCUITS.map((c) => c.sender).join(' or ') + ').');
  const domain = domainOf(circuit.sender);
  const records = await loadKeys(keysDir, domain);
  const keys = Object.fromEntries(Object.entries(records).map(([name, k]) => [name, k.txt]));
  let r;
  try { r = await verifyDkimOffline(raw, keys, domain); } catch (e) { fail('The DKIM check failed: ' + e.message + '.'); }
  const keyHash = records[r.selector + '._domainkey.' + domain].keyHash;

  if (r.headers.length > MAX_SIGNED_HEADER) {
    fail('The signed part of the email header is ' + r.headers.length + ' bytes; the circuit takes at most ' + MAX_SIGNED_HEADER + '.');
  }
  const lines = r.headers.toString('latin1').split('\r\n');
  const value = {};
  for (const name of ['from', 'subject']) {
    const at = lines.flatMap((l, i) => (l.toLowerCase().startsWith(name + ':') ? [i] : []));
    if (at.length !== 1) fail('The signed header must contain exactly one ' + name + ' line, in any letter case.');
    if (/^[ \t]/.test(lines[at[0] + 1] ?? '')) fail('The ' + name + ' line is folded in the signed header; the circuit needs it on one line.');
    value[name] = lines[at[0]].slice(name.length + 1);
  }

  const sender = circuit.sender;
  if (value.from !== sender) {
    if (!value.from.endsWith('<' + sender + '>')) fail('The From line must be exactly ' + sender + ', optionally with a plain display name: Name <' + sender + '>.');
    const name = value.from.slice(0, -(sender.length + 2));
    if (!/^[A-Za-z0-9 .'_"-]*$/.test(name)) fail('The sender\'s display name may use only ASCII letters, digits, spaces and . \' _ - " (docs/template.md).');
    if (name.length > 64) fail('The sender\'s display name is too long: at most 63 characters before " <' + sender + '>".');
    if ((name.match(/"/g) ?? []).length % 2) fail('The sender\'s display name has an unclosed quote.');
  }
  let fields;
  try { fields = parseSubject(value.subject); } catch (e) {
    fail('The Subject is not an approval line (' + e.message + '). It must be exactly: ' + SUBJECT_PREFIX + '<project_id> <artifact_sha256> <wallet>.');
  }
  return { circuit, dkim: r, fields, keyHash };
}

/** Paths of a circuit's proving files; a plain error when one is missing. */
export function circuitFiles(circuit, base = repo('')) {
  const at = (f) => join(base, circuit.dir, f);
  const files = { wasm: at(circuit.wasm), zkey: at(circuit.zkey), vk: at(circuit.vk) };
  for (const f of Object.values(files)) if (!existsSync(f)) fail('The proving files for ' + circuit.sender + ' are not on this machine (' + f + '). ' + circuit.missing);
  return files;
}

/** Runs fn as one progress step: a line when it starts, one every 5 s while it runs, one with the time when done. */
async function step(log, label, fn) {
  const t = performance.now();
  const secs = () => ((performance.now() - t) / 1000).toFixed(1);
  log(label + '...');
  const timer = setInterval(() => log('  ' + label.toLowerCase() + ', ' + Math.round((performance.now() - t) / 1000) + ' s'), 5000);
  try {
    const out = await fn();
    log('  done in ' + secs() + ' s');
    return out;
  } finally {
    clearInterval(timer);
  }
}

/** .eml file -> approval-proof.json (written through shared/approval-proof.js only). Returns the output path. */
export async function proveFile(emlPath, outPath, { keysDir = KEYS_DIR, log = console.log, base } = {}) {
  if (!existsSync(emlPath)) fail('There is no file at ' + emlPath + '.');
  if (lstatSync(outPath, { throwIfNoEntry: false })) fail(OUTPUT_EXISTS);
  const raw = readFileSync(emlPath);
  const { circuit, dkim, fields, keyHash } = await step(log, 'Checking the email and its DKIM signature', () => checkEmail(raw, { keysDir }));
  const files = circuitFiles(circuit, base);
  const wtns = { type: 'mem' };
  // The checks above are the circuit's, so a refusal here means the wasm is not this version's circuit.
  await step(log, 'Computing the witness', async () => {
    try {
      await snarkjs.wtns.calculate(circuitInputs(dkim), files.wasm, wtns);
    } catch {
      fail('The circuit refused this email while computing the witness. If mailmarks was updated, its proving files may be from an older version: make them again (bash circuits/scripts/dev-setup.sh) or replace the wasm, zkey and vk together.');
    }
  });
  const { proof, publicSignals } = await step(log, 'Proving (the long step)', () => snarkjs.groth16.prove(files.zkey, wtns));
  wtns.data = undefined;
  await step(log, 'Checking the proof', async () => {
    if (!(await snarkjs.groth16.verify(JSON.parse(readFileSync(files.vk, 'utf8')), publicSignals, proof))) fail('The proof did not verify with the verifying key; nothing was written.');
    if (publicSignals[5] !== keyHash) fail('The proof is for another DKIM key than the pinned record; nothing was written.');
  });
  const ap = buildApprovalProof({ fields, publicSignals, proof });
  // Install a completed file without replacing an entry created while the proof was running.
  const staging = mkdtempSync(join(dirname(outPath), '.mailmarks-proof-'));
  try {
    const stagedProof = join(staging, 'proof.json');
    writeFileSync(stagedProof, JSON.stringify(ap, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    linkSync(stagedProof, outPath);
  } catch (e) {
    if (e.code === 'EEXIST') fail(OUTPUT_EXISTS);
    throw e;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return outPath;
}
