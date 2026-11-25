// Prover command tests: plain refusals before proving, and .eml -> approval-proof.json with the network
// switched off (sandbox-exec on macOS, unshare -n on Linux), read back through shared/approval-proof.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testKey, signEmail, approvalEmail } from '../src/testmail.js';
import { checkEmail, keyRecord, loadKeys, circuitFiles, proveFile, CIRCUITS, ProverError } from '../src/prove.js';
import { buildSubject } from '../src/encode.js';
import { verifyDkimOffline } from '../src/dkim.js';
import { circuitInputs } from '../src/inputs.js';
import { parseApprovalProof } from '../../shared/approval-proof.js';
import { REF } from './ref.js';

const SENDER = 'approver@mailmarks.test';
const key = testKey();
const keysDir = async (k = key, name = 'mailmarks.test-test.json') => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const rec = await keyRecord({ domain: 'mailmarks.test', selector: 'test', txt: k.record, fetched: '2026-11-20', source: 'test key, generated per run' });
  writeFileSync(join(dir, name), JSON.stringify(rec, null, 2));
  return dir;
};
const email = (o = {}) => Buffer.from(approvalEmail({ from: 'Approver <' + SENDER + '>', to: 'r@mailmarks.test', subject: buildSubject(REF),
  domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, ...o }), 'utf8');
const refuses = (p, re) => assert.rejects(p, (e) => { assert.ok(e instanceof ProverError, String(e)); assert.match(e.message, re); return true; });

test('a test-key approval email passes every check and gives the Subject fields', async () => {
  const { circuit, fields } = await checkEmail(email(), { keysDir: await keysDir() });
  assert.equal(circuit.name, 'test');
  assert.deepEqual(fields, REF);
});

test('missing key: a plain message, no network lookup', async () => {
  await refuses(checkEmail(email(), { keysDir: mkdtempSync(join(tmpdir(), 'keys-')) }), /There is no pinned DKIM key for mailmarks\.test in .*\. The prover never looks keys up online/);
  // A pinned key for the domain, but another selector's: the email's key is not pinned.
  const other = testKey();
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  writeFileSync(join(dir, 'k.json'), JSON.stringify(await keyRecord({ domain: 'mailmarks.test', selector: 'old', txt: other.record, fetched: '2026-11-20' })));
  await refuses(checkEmail(email(), { keysDir: dir }), /The DKIM check failed: no DKIM signature|signed with a different key than the pinned one/);
});

test('a pinned key that is not RSA-2048 with exponent 65537 is refused', async () => {
  await refuses(loadKeys(await keysDir(testKey({ publicExponent: 3 })), 'mailmarks.test'), /has exponent 3; the circuit needs 65537/);
  await refuses(loadKeys(await keysDir(testKey({ modulusLength: 1024 })), 'mailmarks.test'), /is a 1024-bit RSA key; the circuit needs RSA-2048/);
  const dir = await keysDir();
  const f = join(dir, 'mailmarks.test-test.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), keyHash: '1' }));
  await refuses(loadKeys(dir, 'mailmarks.test'), /does not match its own key/);
});

test('simple header canonicalization is refused', async () => {
  const raw = signEmail({ headers: [['From', SENDER], ['Subject', buildSubject(REF)], ['Date', 'Wed, 18 Nov 2026 12:00:00 +0000']],
    body: 'x\n', domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, signed: ['from', 'subject', 'date'], canon: 'simple' });
  await refuses(checkEmail(Buffer.from(raw), { keysDir: await keysDir() }), /The DKIM check failed: .*header canonicalization must be relaxed/);
});

test('display names: non-ASCII, other punctuation, unclosed quote, too long', async () => {
  const dir = await keysDir();
  await refuses(checkEmail(email({ from: 'André <' + SENDER + '>' }), { keysDir: dir }), /may use only ASCII letters, digits, spaces/);
  await refuses(checkEmail(email({ from: 'Doe, John <' + SENDER + '>' }), { keysDir: dir }), /may use only ASCII letters, digits, spaces/);
  await refuses(checkEmail(email({ from: '"Unclosed <' + SENDER + '>' }), { keysDir: dir }), /unclosed quote/);
  await refuses(checkEmail(email({ from: 'N'.repeat(64) + ' <' + SENDER + '>' }), { keysDir: dir }), /too long: at most 63 characters/);
  await checkEmail(email({ from: 'N'.repeat(63) + ' <' + SENDER + '>' }), { keysDir: dir });
  await checkEmail(email({ from: '"Release Approver" <' + SENDER + '>' }), { keysDir: dir });
});

test('signed header limit: 951 bytes pass and fill the 960-byte circuit buffer; 952 are refused with a plain message', async () => {
  const raw = (n) => Buffer.from(signEmail({ headers: [['From', SENDER], ['To', 'r'.repeat(n) + '@mailmarks.test'], ['Subject', buildSubject(REF)], ['Date', 'Wed, 18 Nov 2026 12:00:00 +0000']],
    body: 'x\n', domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, signed: ['from', 'to', 'subject', 'date'] }));
  const size = async (n) => (await verifyDkimOffline(raw(n), { 'test._domainkey.mailmarks.test': key.record })).headers.length;
  const n = 100 + 951 - (await size(100)); // the signed header grows byte for byte with the To address
  const dir = await keysDir();
  const { dkim } = await checkEmail(raw(n), { keysDir: dir });
  assert.equal(dkim.headers.length, 951);
  assert.equal(circuitInputs(dkim).emailHeaderLength, '960');
  await refuses(checkEmail(raw(n + 1), { keysDir: dir }), /The signed part of the email header is 952 bytes; the circuit takes at most 951\./);
  await refuses(checkEmail(raw(n + 300), { keysDir: dir }), /The signed part of the email header is 1251 bytes; the circuit takes at most 951\./);
});

test('another sender or a malformed Subject is refused', async () => {
  const dir = await keysDir();
  await refuses(checkEmail(email({ from: 'someone@mailmarks.test' }), { keysDir: dir }), /not from a configured sender \(mintmarks@trionlabs\.dev or approver@mailmarks\.test\)/);
  await refuses(checkEmail(email({ subject: buildSubject(REF) + ' x', fold: false }), { keysDir: dir }), /The Subject is not an approval line/);
  await refuses(checkEmail(email({ from: SENDER + ', other@mailmarks.test' }), { keysDir: dir }), /not from a configured sender|The From line must be exactly/);
});

test('the SOW\'s old prefix and "emailmark" in another letter case are refused, with the exact form', async () => {
  const dir = await keysDir();
  const rest = buildSubject(REF).slice('emailmark '.length);
  for (const p of ['APPROVE RELEASE ', 'Emailmark ', 'EMAILMARK ']) {
    await refuses(checkEmail(email({ subject: p + rest }), { keysDir: dir }),
      /The Subject is not an approval line \(subject does not start with "emailmark "\)\. It must be exactly: emailmark <project_id> <artifact_sha256> <wallet>\.$/);
  }
});

test('proving files from another circuit version: a plain message to replace the three together', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stale-'));
  const dev = join(base, CIRCUITS[1].dir);
  mkdirSync(join(dev, 'release_approval_test_js'), { recursive: true });
  writeFileSync(join(dev, CIRCUITS[1].wasm), 'not this circuit');
  writeFileSync(join(dev, CIRCUITS[1].zkey), '');
  writeFileSync(join(dev, CIRCUITS[1].vk), '{}');
  const eml = join(base, 'approval.eml');
  writeFileSync(eml, email());
  const printed = [];
  await refuses(proveFile(eml, join(base, 'approval-proof.json'), { keysDir: await keysDir(), base, log: (s) => printed.push(s) }),
    /^The circuit refused this email while computing the witness\. If mailmarks was updated, its proving files may be from an older version: make them again \(bash circuits\/scripts\/dev-setup\.sh\) or replace the wasm, zkey and vk together\.$/);
  assert.ok(!existsSync(join(base, 'approval-proof.json')));
});

test('the pinned delivery key record loads: google._domainkey.trionlabs.dev, RSA-2048, e = 65537, docs/dkim-key.md\'s key hash', async () => {
  const keys = await loadKeys(fileURLToPath(new URL('../keys/', import.meta.url)), 'trionlabs.dev');
  const k = keys['google._domainkey.trionlabs.dev'];
  assert.deepEqual([k.modulusBits, k.exponent, k.fetched], [2048, 65537, '2026-11-21']);
  assert.ok(readFileSync(new URL('../../docs/dkim-key.md', import.meta.url), 'utf8').includes('`' + k.keyHash + '`'));
});

test('docs/fixtures/approval-proof.json, the real proof of the reference approval: valid format, pinned key, reference fields', async () => {
  const p = parseApprovalProof(readFileSync(new URL('../../docs/fixtures/approval-proof.json', import.meta.url), 'utf8'));
  const keys = await loadKeys(fileURLToPath(new URL('../keys/', import.meta.url)), 'trionlabs.dev');
  assert.equal(p.publicSignals[5], keys['google._domainkey.trionlabs.dev'].keyHash);
  assert.deepEqual([p.fields.projectId, p.fields.artifactSha256], ['mailmarks', REF.artifactSha256]);
});

test('a key record with two public keys (p=) is refused', async () => {
  const dir = await keysDir();
  const f = join(dir, 'mailmarks.test-test.json');
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...rec, txt: rec.txt + '; p=' + rec.txt.split('p=')[1] }));
  await refuses(loadKeys(dir, 'mailmarks.test'), /more than one public key \(p=\)/);
});

test('missing proving files: a plain message naming what to run', () => {
  assert.throws(() => circuitFiles(CIRCUITS[1], mkdtempSync(join(tmpdir(), 'none-'))), /The proving files for approver@mailmarks\.test are not on this machine .* Run "bash circuits\/scripts\/dev-setup\.sh"/);
  assert.throws(() => circuitFiles(CIRCUITS[0], mkdtempSync(join(tmpdir(), 'none-'))), /The proving files for mintmarks@trionlabs\.dev are not on this machine .* Use the delivery files whose hashes docs\/setup\.md lists \(the Docker image carries them\)\. A new key made with delivery-setup\.sh gives proofs the deployed registry refuses\.$/);
});

// ---- .eml -> approval-proof.json, network off --------------------------------------------------------------------

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PROVER = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const NO_NET_MAC = '(version 1)(allow default)(deny network*)';
// docs/prover.md and the Dockerfile use the same base image.
const NODE_IMAGE = 'node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530';
const PROBE = "require('net').connect(80, '1.1.1.1').on('connect', () => process.exit(0)).on('error', () => process.exit(7))";
// npm itself, as "npm run prove" runs it (npm_execpath when the tests run under npm).
const NPM = process.env.npm_execpath?.endsWith('.js') ? [process.execPath, process.env.npm_execpath] : ['npm'];

/**
 * A way to run a command on this machine with networking off, checked by a connection that must fail:
 * sandbox-exec (macOS), unshare (Linux), or a Docker container with --network none. Returns { name, run } or the
 * reasons none works.
 */
function offline() {
  const tried = [];
  // MAILMARKS_OFFLINE_RUNNER=docker tries only Docker (to check that path on a Mac).
  const onlyDocker = process.env.MAILMARKS_OFFLINE_RUNNER === 'docker';
  const ok = (cmd, args) => {
    const r = spawnSync(cmd, args, { timeout: 120000 });
    if (r.status === 7) return true; // it ran, and could not connect
    tried.push(cmd + ' ' + args.slice(0, 2).join(' ') + ': ' + (r.error?.code ?? 'exit ' + r.status));
    return false;
  };
  if (!onlyDocker && process.platform === 'darwin' && ok('sandbox-exec', ['-p', NO_NET_MAC, process.execPath, '-e', PROBE])) {
    return { name: 'sandbox-exec', run: (cmd, cwd) => spawnSync('sandbox-exec', ['-p', NO_NET_MAC, ...cmd], { cwd, encoding: 'utf8', timeout: 600000 }) };
  }
  if (!onlyDocker && process.platform === 'linux') {
    for (const pre of [['unshare', '-rn'], ['unshare', '-n']]) {
      if (ok(pre[0], [...pre.slice(1), process.execPath, '-e', PROBE])) {
        return { name: pre.join(' '), run: (cmd, cwd) => spawnSync(pre[0], [...pre.slice(1), ...cmd], { cwd, encoding: 'utf8', timeout: 600000 }) };
      }
    }
  }
  // Docker: the repository (with its node_modules) is mounted read-only at the same path, the work folder read-write.
  if (ok('docker', ['run', '--rm', '--network', 'none', NODE_IMAGE, 'node', '-e', PROBE])) {
    return { name: 'docker --network none', run: (cmd, cwd) => spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', REPO + ':' + REPO + ':ro', '-v', cwd + ':' + cwd, '-w', cwd,
      NODE_IMAGE, ...(cmd[0] === process.execPath ? ['node', ...cmd.slice(1)] : cmd)], { encoding: 'utf8', timeout: 600000 }) };
  }
  return { reasons: tried };
}

test('.eml -> approval-proof.json with networking off, as README runs it; read back through shared/approval-proof.js', async (t) => {
  try { circuitFiles(CIRCUITS[1]); } catch (e) { t.skip('skipped: no DEV proving key. ' + e.message); return; }
  const off = offline();
  if (!off.run) { t.skip('skipped: no way to switch the network off on this machine (tried ' + off.reasons.join('; ') + ')'); return; }
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'work-'))); // npm reports the real path (/private/var on macOS)
  writeFileSync(join(work, 'approval.eml'), email());
  const keys = await keysDir();
  const keyHash = JSON.parse(readFileSync(join(keys, 'mailmarks.test-test.json'), 'utf8')).keyHash;
  // The README command with relative paths, run from the email's folder; the key record via --keys keys.
  mkdirSync(join(work, 'keys'));
  writeFileSync(join(work, 'keys', 'mailmarks.test-test.json'), readFileSync(join(keys, 'mailmarks.test-test.json')));
  const npm = off.name.startsWith('docker') ? ['npm'] : NPM;
  const t0 = performance.now();
  const r = off.run([...npm, 'run', 'prove', '--prefix', PROVER, '--', 'approval.eml', '--keys', 'keys'], work);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  t.diagnostic('offline npm run prove: .eml -> approval-proof.json in ' + secs + ' s via ' + off.name);
  for (const line of ['Checking the email and its DKIM signature...', 'Computing the witness...', 'Proving (the long step)...', 'Checking the proof...', 'Wrote ' + join(work, 'approval-proof.json')]) {
    assert.ok(r.stdout.includes(line), line + '\n' + r.stdout);
  }
  // Nothing from the email in the output (npm's own "> package@ script" lines aside), and no other file next to it.
  const printed = (r.stdout + r.stderr).split('\n').filter((l) => !l.startsWith('> ')).join('\n');
  for (const s of ['emailmark', REF.wallet, REF.artifactSha256, REF.projectId, SENDER, 'Approver', 'dkim-signature', 'Approved.']) assert.ok(!printed.includes(s), s + '\n' + printed);
  assert.deepEqual(readdirSync(work).sort(), ['approval-proof.json', 'approval.eml', 'keys']);

  const text = readFileSync(join(work, 'approval-proof.json'), 'utf8');
  const ap = parseApprovalProof(text);
  assert.deepEqual(ap.fields, REF);
  assert.equal(ap.publicSignals[5], keyHash);
  // A hand-edited copy with one changed signal is refused.
  const edited = JSON.parse(text);
  edited.publicSignals[3] = String(BigInt(edited.publicSignals[3]) + 1n);
  assert.throws(() => parseApprovalProof(JSON.stringify(edited)), /does not match "fields"/);
  edited.publicSignals[3] = ap.publicSignals[3];
  edited.publicSignals[6] = String(BigInt(edited.publicSignals[6]) + 1n);
  assert.throws(() => parseApprovalProof(JSON.stringify(edited)), /soroban\.nullifier does not match public signal 6/);
});

test('the command line: usage, a missing file, plain errors', () => {
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.match(run().stderr, /Usage: npm run prove --prefix prover -- <approval\.eml> \[--out approval-proof\.json\]/);
  const r = run(join(tmpdir(), 'no-such-file.eml'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: There is no file at /);
});

test('the prover refuses to replace existing output paths before reading the email', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmarks-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eml = join(dir, 'approval.eml');
  const output = join(dir, 'approval-proof.json');
  const link = join(dir, 'unused-link.json');
  writeFileSync(eml, 'local email');
  writeFileSync(output, 'existing output');
  symlinkSync(join(dir, 'missing.json'), link);

  for (const path of [eml, output, link]) {
    await refuses(proveFile(eml, path), /The output already exists\. Choose another path with --out\./);
  }
  assert.equal(readFileSync(eml, 'utf8'), 'local email');
  assert.equal(readFileSync(output, 'utf8'), 'existing output');
  assert.deepEqual(readdirSync(dir).sort(), ['approval-proof.json', 'approval.eml', 'unused-link.json']);
});
