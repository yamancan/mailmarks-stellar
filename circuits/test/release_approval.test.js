// Circuit tests (docs/circuit.md). Emails are signed with throwaway test keys (prover/src/testmail.js);
// no real email is used. Accepting cases go through the prover's own offline DKIM check first; buffers the prover
// would refuse are signed directly (signLines) so the circuit's own rejection is what each test sees.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, generatePrimeSync } from 'node:crypto';
import { requireTools, compile, signLines, signPadded, circuitInputs, publicOut, modulusOf, rejecter } from './helpers.js';
import { testKey, signEmail, approvalEmail } from '../../prover/src/testmail.js';
import { buildSubject, publicSignals, SUBJECT_PREFIX } from '../../prover/src/encode.js';

const REF = {
  projectId: 'mailmarks',
  artifactSha256: 'bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac',
  wallet: 'GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN',
};
const SUBJECT = buildSubject(REF);
const FROM = 'Approver <approver@mailmarks.test>';
const DATE = 'Wed, 18 Nov 2026 12:00:00 +0000';
const key = testKey();
const keys = { 'test._domainkey.mailmarks.test': key.record };
let circuit;
let verifyDkimOffline, dkimKeyHash, nullifierOf; // prover/src/dkim.js, loaded after requireTools()

before(async () => {
  await requireTools();
  ({ verifyDkimOffline, dkimKeyHash, nullifierOf } = await import('../../prover/src/dkim.js'));
  circuit = await compile('release_approval_test.circom');
  rejects = rejecter(circuit);
});

// A full email through the prover's offline DKIM check, then circuit inputs.
async function viaProver({ from = FROM, subject = SUBJECT, signed = ['from', 'to', 'subject', 'date', 'message-id'], privateKey = key.privateKey } = {}) {
  const raw = signEmail({
    headers: [['From', from], ['To', 'recipient@mailmarks.test'], ['Subject', subject], ['Date', DATE], ['Message-ID', '<t@mailmarks.test>']],
    body: 'Approved.\n', domain: 'mailmarks.test', selector: 'test', privateKey, signed,
  });
  const r = await verifyDkimOffline(raw, keys);
  return { r, input: circuitInputs({ headers: r.headers, signature: r.signature, publicKey: r.publicKey }) };
}

const lines = ({ from = FROM, subject = SUBJECT, extra = [] } = {}) => [
  ...(from === null ? [] : ['from:' + from]), 'to:recipient@mailmarks.test',
  ...(subject === null ? [] : ['subject:' + subject]), 'date:' + DATE, ...extra,
];
const direct = (o) => circuitInputs(signLines(lines(o), key.privateKey));

async function accepts(input) {
  return publicOut(await circuit.calculateWitness(input, true));
}

let rejects;

// Node's RSA keygen rounds 2049 bits down to a 2048-bit modulus, so build one from a 1025- and a 1024-bit prime.
function rsaKey2049() {
  const b64 = (x) => Buffer.from(x.toString(16).padStart(Math.ceil(x.toString(16).length / 2) * 2, '0'), 'hex').toString('base64url');
  const inv = (a, m) => { let [r0, r1, s0, s1] = [a % m, m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1]; } return ((s0 % m) + m) % m; };
  const e = 65537n;
  for (;;) {
    const p = generatePrimeSync(1025, { bigint: true });
    const q = generatePrimeSync(1024, { bigint: true });
    const n = p * q;
    if (n.toString(2).length !== 2049 || (p - 1n) % e === 0n || (q - 1n) % e === 0n) continue;
    const d = inv(e, (p - 1n) * (q - 1n));
    return createPrivateKey({ format: 'jwk', key: { kty: 'RSA', n: b64(n), e: b64(e), d: b64(d), p: b64(p), q: b64(q), dp: b64(d % (p - 1n)), dq: b64(d % (q - 1n)), qi: b64(inv(q, p)) } });
  }
}
const plus = (input, k, d) => ({ ...input, [k]: String(BigInt(input[k]) + BigInt(d)) });

// ---- accepted emails ------------------------------------------------------------------------------------------

test('From first in the signed buffer (offset 0): outputs equal the encoder, key hash and nullifier', async () => {
  const { r, input } = await viaProver({ signed: ['from', 'subject', 'date'] });
  assert.equal(input.fromIndex, '0');
  const w = await circuit.calculateWitness(input, true);
  await circuit.checkConstraints(w);
  assert.deepEqual(publicOut(w), publicSignals(REF, await dkimKeyHash(r.publicKey), await nullifierOf(r.signature)));
});

test('Subject first in the signed buffer (offset 0)', async () => {
  const { r, input } = await viaProver({ signed: ['subject', 'from', 'date'] });
  assert.equal(input.subjectIndex, '0');
  const w = await circuit.calculateWitness(input, true);
  await circuit.checkConstraints(w);
  assert.deepEqual(publicOut(w), publicSignals(REF, await dkimKeyHash(r.publicKey), await nullifierOf(r.signature)));
});

test('From forms: Gmail "Name Surname <addr>" (space kept in the name), quoted name, <addr>, bare addr', async () => {
  for (const from of ['Release Approver <approver@mailmarks.test>', '"Release Approver" <approver@mailmarks.test>', '<approver@mailmarks.test>', 'approver@mailmarks.test', "Jane O'Neil-Smith_2 Jr. <approver@mailmarks.test>"]) {
    const { input } = await viaProver({ from });
    await accepts(input);
  }
  const { input } = await viaProver({ from: 'Release Approver <approver@mailmarks.test>' });
  assert.deepEqual([input.fromNameLength, input.fromAngle], ['17', '1']); // "Release Approver " is the name
});

test('public signals 0-4 match docs/public-input-vectors.json', async () => {
  const { vectors } = JSON.parse(readFileSync(new URL('../../docs/public-input-vectors.json', import.meta.url)));
  for (const { fields, signals } of vectors) {
    const out = await accepts((await viaProver({ subject: buildSubject(fields) })).input);
    assert.deepEqual(out.slice(0, 5), ['wallet_0', 'wallet_1', 'project_id', 'artifact_hi', 'artifact_lo'].map((k) => signals[k]));
  }
});

test('limits accepted: 951-byte signed header with From and Subject deep in it (Subject last), 64-byte name', async () => {
  const order = (to) => ['to:' + to, 'from:' + FROM, 'date:' + DATE, 'subject:' + SUBJECT];
  const room = 951 - signLines(order(''), key.privateKey).headers.length;
  const s = signLines(order('r'.repeat(room)), key.privateKey);
  assert.equal(s.headers.length, 951);
  const input = circuitInputs(s);
  assert.ok(+input.fromIndex > 500 && +input.subjectIndex > 600, input.fromIndex + ' ' + input.subjectIndex);
  assert.ok(s.headers.toString('latin1').includes(SUBJECT + '\r\ndkim-signature:')); // Subject is the last signed line
  assert.equal((await accepts(input))[2], publicSignals(REF, 1n, 1n)[2]);
  const name = 'N'.repeat(63) + ' ';
  const named = direct({ from: name + '<approver@mailmarks.test>' });
  assert.equal(named.fromNameLength, '64');
  await accepts(named);
});

test('a Subject folded like Gmail (prover/src/testmail.js approvalEmail) is accepted after relaxed unfolding', async () => {
  const raw = approvalEmail({ from: FROM, to: 'recipient@mailmarks.test', subject: SUBJECT, domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, fold: true });
  assert.match(raw, /\r\n [0-9a-f]{64} /);
  const r = await verifyDkimOffline(raw, keys);
  const out = await accepts(circuitInputs({ headers: r.headers, signature: r.signature, publicKey: r.publicKey }));
  assert.deepEqual(out, publicSignals(REF, await dkimKeyHash(r.publicKey), await nullifierOf(r.signature)));
});

test('a key that is not RSA-2048 is rejected (1024-, 2047- and 2049-bit keys, signature valid for each)', async () => {
  for (const [modulusLength, where] of [[1024, 'topLimb[111] === 1'], [2047, 'topLimb[111] === 1'], [2049, 'Num2Bits(112)(pubkey[k - 1])']]) {
    const other = modulusLength === 2049 ? { privateKey: rsaKey2049() } : testKey({ modulusLength });
    assert.equal(modulusOf(other.privateKey).toString(2).length, modulusLength);
    await rejects(circuitInputs(signLines(lines(), other.privateKey)), where);
  }
});

test('longest project (31 bytes) and an x-subject: line beside the real Subject are accepted', async () => {
  await accepts(direct({ subject: buildSubject({ ...REF, projectId: 'a-' + '9'.repeat(29) }) }));
  await accepts(direct({ extra: ['x-subject:' + buildSubject({ ...REF, projectId: 'other', artifactSha256: '0'.repeat(64) })] }));
});

// ---- signature ------------------------------------------------------------------------------------------------

test('bad signature: flipped bit, another key, header changed after signing', async () => {
  const good = signLines(lines(), key.privateKey);
  await rejects(circuitInputs({ ...good, signature: good.signature ^ 1n }), /RSAVerifier65537|FpPow65537Mod|BigLessThan|FpMul/);
  const other = testKey();
  await rejects(circuitInputs({ ...signLines(lines(), other.privateKey), publicKey: good.publicKey }), /RSAVerifier65537|FpPow65537Mod|FpMul/);
  // Altered project, artifact and wallet bytes in the signed buffer: the grammar still holds, the signature does not.
  for (const [a, b] of [['mailmarks ', 'mailmarkz '], ['bd0436', 'bd0437'], ['GA4TZT', 'GA4TZU']]) {
    const altered = Buffer.from(good.headers.toString('latin1').replace(a, b), 'latin1');
    await rejects(circuitInputs({ ...good, headers: altered }), /RSAVerifier65537|FpPow65537Mod|FpMul/);
  }
});

test('capitalized header names (as simple canonicalization keeps them) are rejected', async () => {
  const s = signLines(['From:' + FROM, 'Subject:' + SUBJECT, 'Date:' + DATE], key.privateKey);
  const input = circuitInputs(s);
  const text = s.headers.toString('latin1');
  await rejects({ ...input, fromIndex: String(text.indexOf('From:')), subjectIndex: String(text.indexOf('Subject:')) }, 'fw[j] === FROM[j]');
  const t2 = signLines(['from:' + FROM, 'Subject:' + SUBJECT, 'Date:' + DATE], key.privateKey);
  await rejects({ ...circuitInputs(t2), subjectIndex: String(t2.headers.toString('latin1').indexOf('Subject:')) }, 'sw[j] === SUBJECT[j]');
});

test('headers whose names only start with from/subject are not counted', async () => {
  await accepts(direct({ extra: ['fromage:cheese', 'subject-x:y'] }));
});

test('a second From or Subject in another letter case is counted and rejected', async () => {
  await rejects(direct({ extra: ['Subject:Do not approve'] }), 'subjectCount === 1');
  await rejects(direct({ extra: ['SUBJECT:Do not approve'] }), 'subjectCount === 1');
  await rejects(direct({ extra: ['From:attacker@evil.test'] }), 'fromCount === 1');
  await rejects(direct({ extra: ['fRoM:attacker@evil.test'] }), 'fromCount === 1');
});

// ---- From -----------------------------------------------------------------------------------------------------

test('wrong sender', async () => {
  for (const from of ['attacker@mailmarks.test', 'Approver <attacker@mailmarks.test>', 'Approver@mailmarks.test', 'approver@mailmarks.tes', '<approver@mailmarks.test.evil>']) {
    await rejects(direct({ from }), 'ft[t] === fromAngle');
  }
});

test('From mailbox lists are rejected', async () => {
  await rejects(direct({ from: 'attacker@evil.test, approver@mailmarks.test' }), 'ft[t] === fromAngle');
  await rejects(direct({ from: 'approver@mailmarks.test, attacker@evil.test' }), 'ft[t] === fromAngle');
  await rejects(direct({ from: 'x, Approver <approver@mailmarks.test>' }), 'inName[j] * (1 - nameOk[j]) === 0');
  await rejects(direct({ from: 'Approver <approver@mailmarks.test>, attacker@evil.test' }), 'ft[t] === fromAngle');
});

test('a second address hidden in the display name is rejected', async () => {
  for (const from of ['"attacker@evil.test" <approver@mailmarks.test>', 'attacker@evil.test <approver@mailmarks.test>', '<attacker@evil.test> <approver@mailmarks.test>']) {
    await rejects(direct({ from }), 'inName[j] * (1 - nameOk[j]) === 0');
  }
});

test('names outside [A-Za-z0-9 .\'_"-] are rejected: RFC 2047 word, comment, comma, colon, semicolon, backslash, non-ASCII', async () => {
  // 'André ' is Latin-1 (0xe9), 'AndrÃ© ' the same name's UTF-8 bytes (0xc3 0xa9): bytes >= 0x80 are rejected.
  for (const name of ['=?US-ASCII?Q?other=40example=2Etest?= ', '(Unclosed ', '"Doe, John" ', 'Doe: ', 'Doe; ', 'Do\\e ', 'Andr\u00e9 ', 'Andr\u00c3\u00a9 ']) {
    await rejects(direct({ from: name + '<approver@mailmarks.test>' }), 'inName[j] * (1 - nameOk[j]) === 0');
  }
});

test('an unclosed quote in the name is rejected (the address would sit inside the quoted string)', async () => {
  for (const name of ['"Unclosed ', 'a"b ', '"Release" "Approver ']) {
    await rejects(direct({ from: name + '<approver@mailmarks.test>' }), 'quoteBits[0] === 0');
  }
  await accepts(direct({ from: '"Release" "Approver" <approver@mailmarks.test>' }));
});

test('folded continuation lines after From or Subject are rejected', async () => {
  await rejects(direct({ from: 'approver@mailmarks.test\r\n , attacker@evil.test' }), 'NotFolded()(fromNext);');
  await rejects(direct({ from: FROM + '\r\n\t, attacker@evil.test' }), 'NotFolded()(fromNext);');
  await rejects(direct({ subject: SUBJECT + '\r\n junk' }), 'NotFolded()(st[124]);');
});

test('display name longer than 64 bytes is rejected', async () => {
  await rejects(direct({ from: 'N'.repeat(65) + ' <approver@mailmarks.test>' }), 'AssertLessEq()(fromNameLength, maxNameLength)');
});

test('trailing junk after the From address is rejected', async () => {
  await rejects(direct({ from: 'approver@mailmarks.test x' }), 'ft[t] === fromAngle');
  await rejects(direct({ from: 'Approver <approver@mailmarks.test> x' }), 'ft[t] === fromAngle');
  // After '>' the angled form needs CRLF. The honest offsets fail earlier ('@' in the name), so lie about the name length.
  const two = direct({ from: 'Approver <approver@mailmarks.test> <attacker@evil.test>' });
  await rejects({ ...two, fromNameLength: '9' }, 'fromAngle * (ft[t] - ANGLED[t]) === 0');
  await rejects(direct({ from: 'Approver <approver@mailmarks.test>>' }), 'fromAngle * (ft[t] - ANGLED[t]) === 0');
});

// ---- header lines ---------------------------------------------------------------------------------------------

test('duplicate From or Subject in the signed buffer is rejected', async () => {
  await rejects(direct({ extra: ['from:' + FROM] }), 'fromCount === 1');
  await rejects(direct({ extra: ['subject:' + SUBJECT] }), 'subjectCount === 1');
});

test('unsigned From or Subject (not in the signed buffer) is rejected', async () => {
  await rejects(direct({ from: null }), 'fromCount === 1');
  await rejects(direct({ subject: null }), 'subjectCount === 1');
  // The same through a real email whose h= leaves Subject out: the prover refuses it, and so does the circuit.
  const raw = signEmail({ headers: [['From', FROM], ['Subject', SUBJECT], ['Date', DATE]], body: 'x\n', domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, signed: ['from', 'date'] });
  await assert.rejects(verifyDkimOffline(raw, keys), /does not list subject/);
});

test('x-subject: look-alike instead of Subject is rejected', async () => {
  const input = direct({ subject: null, extra: ['x-subject:' + SUBJECT] });
  await rejects(input, 'subjectCount === 1');
  // Pointing at the look-alike while a real Subject exists fails too.
  const other = buildSubject({ ...REF, projectId: 'other' });
  const both = direct({ subject: other, extra: ['x-subject:' + SUBJECT] });
  const text = signLines(lines({ subject: other, extra: ['x-subject:' + SUBJECT] }), key.privateKey).headers.toString('latin1');
  await rejects({ ...both, subjectIndex: String(text.indexOf('subject:' + SUBJECT)), projectLength: '9' }, 'subjectHere === 1');
});

test('wrong offsets are rejected', async () => {
  const { input } = await viaProver({ signed: ['date', 'to', 'from', 'subject'] });
  assert.ok(+input.fromIndex > 0 && +input.subjectIndex > 0);
  await accepts(input);
  for (const [k, d, where] of [
    ['fromIndex', 1, 'fromHere === 1'], ['fromIndex', -1, 'fromHere === 1'],
    ['subjectIndex', 1, 'subjectHere === 1'], ['subjectIndex', -2, 'subjectHere === 1'],
    ['fromNameLength', 1, 'inName[j] * (1 - nameOk[j]) === 0'], ['fromNameLength', -1, 'ft[t] === fromAngle'],
    ['projectLength', 1, 'inProject[j] * (1 - projectOk[j]) === 0'], ['projectLength', -1, 'st[0] === 32'],
    ['headerLength', 1, 'pad[0] === 128'], ['headerLength', -1, 'pad[0] === 128'],
  ]) await rejects(plus(input, k, d), where);
  await rejects({ ...input, fromAngle: '0' }, '(1 - fromAngle) * fromNameLength === 0');
  // Claiming the signed bytes end inside the Subject line: the padded length is then more than one block too long.
  await rejects({ ...input, headerLength: String(+input.subjectIndex + 10) }, 'emailHeaderLength, headerLength + 72');
});

// ---- Subject grammar ------------------------------------------------------------------------------------------

const subj = (p = REF.projectId, a = REF.artifactSha256, w = REF.wallet) => SUBJECT_PREFIX + p + ' ' + a + ' ' + w;

test('malformed or altered project is rejected (leading hyphen, uppercase, underscore, empty, 32 bytes)', async () => {
  await rejects(direct({ subject: subj('-mailmarks') }), 'inProject[j] * (1 - projectOk[j]) === 0');
  await rejects(direct({ subject: subj('Mailmarks') }), 'inProject[j] * (1 - projectOk[j]) === 0');
  await rejects(direct({ subject: subj('mail_marks') }), 'inProject[j] * (1 - projectOk[j]) === 0');
  await rejects(direct({ subject: subj('') }), 'projectEmpty === 0');
  await rejects(direct({ subject: subj('a'.repeat(32)) }), /Num2Bits/);
});

test('malformed artifact is rejected (uppercase hex, 63 or 65 characters)', async () => {
  await rejects(direct({ subject: subj(undefined, REF.artifactSha256.toUpperCase()) }), /HexNibble/);
  await rejects(direct({ subject: subj(undefined, REF.artifactSha256.slice(1)) }), 'st[65] === 32');
  await rejects(direct({ subject: subj(undefined, REF.artifactSha256 + '0') }), 'st[65] === 32');
});

test('malformed wallet is rejected (not G, bad base32 character, 55 or 57 characters)', async () => {
  await rejects(direct({ subject: subj(undefined, undefined, 'C' + REF.wallet.slice(1)) }), "st[66] === 71;");
  await rejects(direct({ subject: subj(undefined, undefined, REF.wallet.slice(0, -1) + '1') }), /Base32Char/);
  await rejects(direct({ subject: subj(undefined, undefined, REF.wallet.slice(0, -1)) }), 'st[122] === 13');
  await rejects(direct({ subject: subj(undefined, undefined, REF.wallet + 'A') }), 'st[122] === 13');
});

test('the circuit\'s PREFIX bytes are shared/encode.js SUBJECT_PREFIX ("emailmark ")', () => {
  const m = readFileSync(new URL('../approval.circom', import.meta.url), 'utf8').match(/var P = (\d+);\s*var PREFIX\[P\] = \[([\d, ]+)\]/);
  assert.equal(SUBJECT_PREFIX, 'emailmark ');
  assert.equal(+m[1], SUBJECT_PREFIX.length);
  assert.deepEqual(m[2].split(',').map(Number), [...Buffer.from(SUBJECT_PREFIX, 'latin1')]);
});

test('Subject prefix and trailing junk are exact: other letter case, the SOW\'s old prefix and "Re: " are rejected', async () => {
  const rest = SUBJECT.slice(SUBJECT_PREFIX.length);
  assert.equal(SUBJECT, 'emailmark ' + rest);
  for (const p of ['Emailmark ', 'EMAILMARK ', 'eMailmark ', 'emailmarks ', 'APPROVE RELEASE ', 'Re: emailmark ']) {
    await rejects(direct({ subject: p + rest }), 'sw[8 + j] === PREFIX[j]');
  }
  await rejects(direct({ subject: 'emailmark  ' + rest }), 'projectEmpty === 0');
  await rejects(direct({ subject: SUBJECT + ' x' }), 'st[122] === 13');
  await rejects(direct({ subject: SUBJECT + ' ' }), 'st[122] === 13');
});

// ---- SHA padding ----------------------------------------------------------------------------------------------

// The signed buffer of a valid email with its padding changed by edit(bytes, headerLength, paddedLength), which returns
// the new padded length; then signed over exactly those blocks (signPadded), so only the padding check can refuse it.
function repadded(edit, input = direct()) {
  const bytes = input.emailHeader.map(Number);
  const len = edit(bytes, Number(input.headerLength), Number(input.emailHeaderLength));
  return { ...input, emailHeader: bytes.map(String), emailHeaderLength: String(len), signature: signPadded(bytes.slice(0, len), key.privateKey) };
}

test('SHA padding: the canonical padding signed block by block is accepted (the signer below is sound)', async () => {
  const input = direct();
  const same = repadded((b, h, len) => len);
  assert.deepEqual(same.signature, input.signature, 'signPadded gives the DKIM signature for the canonical padding');
  assert.deepEqual(await accepts(same), await accepts(input));
});

test('SHA padding: a non-zero byte between 0x80 and the length field is rejected (first and last such byte)', async () => {
  const { headerLength: h, emailHeaderLength: len } = direct();
  assert.ok(Number(len) - 9 > Number(h) + 1, 'the test header leaves at least two zero bytes');
  await rejects(repadded((b, h, len) => { b[h + 1] = 1; return len; }), 'beforeLen[j] * pad[j] === 0');
  await rejects(repadded((b, h, len) => { b[len - 9] = 0x80; return len; }), 'beforeLen[j] * pad[j] === 0');
});

test('SHA padding: an extra block of zeros before the length field is rejected', async () => {
  await rejects(repadded((b, h, len) => {
    const field = b.slice(len - 8, len);
    b.fill(0, len - 8, len);
    b.splice(len + 56, 8, ...field);
    return len + 64;
  }), 'emailHeaderLength, headerLength + 72');
});

// A signed buffer of exactly n bytes: the test lines plus an x: header after Subject that takes up the room, so the
// From and Subject offsets do not depend on n.
function sized(n) {
  const room = n - signLines(lines({ extra: ['x:'] }), key.privateKey).headers.length;
  const s = signLines(lines({ extra: ['x:' + 'r'.repeat(room)] }), key.privateKey);
  assert.equal(s.headers.length, n);
  return s;
}

test('SHA padding at its longest: 888 signed bytes (63 zero bytes) accepted; its last zero byte set is rejected', async () => {
  const input = circuitInputs(sized(888));
  assert.equal(+input.emailHeaderLength - +input.headerLength - 9, 63);
  await accepts(input);
  await rejects(repadded((b, h, len) => { assert.equal(h + 63, 951); b[h + 63] = 1; return len; }, input), 'beforeLen[j] * pad[j] === 0');
});

test('header limit: 951 signed bytes fill the 960-byte buffer and are accepted; 952 cannot be padded inside it', async () => {
  const ok = circuitInputs(sized(951));
  assert.equal(ok.emailHeaderLength, '960');
  assert.equal(ok.emailHeader.length, 960);
  await accepts(ok);
  // 952 bytes, 0x80 and seven zeros fill the 960 bytes: no room for the length field (it needs a 16th block).
  const bytes = [...sized(952).headers, 0x80, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(bytes.length, 960);
  await rejects({ ...ok, emailHeader: bytes.map(String), emailHeaderLength: '960', headerLength: '952', signature: signPadded(bytes, key.privateKey) }, 'headerLength + 9, emailHeaderLength');
});

// ---- nullifier ------------------------------------------------------------------------------------------------

// Two real Groth16 proofs of one email (different randomness, same nullifier): test/groth16.test.js, with the DEV key.
test('the nullifier is the Poseidon hash of the signature; no second encoding of the signature is accepted', async () => {
  const { r, input } = await viaProver();
  assert.equal((await accepts(input))[6], String(await nullifierOf(r.signature)));
  // signature + modulus has the same value mod n but is a different number: rejected by signature < modulus.
  const n = modulusOf(key.privateKey);
  await rejects(circuitInputs({ headers: r.headers, signature: r.signature + n, publicKey: r.publicKey }), /BigLessThan|RSAVerifier65537|Num2Bits/);
  // The same number with a non-canonical limb split (carry moved down): rejected by the 121-bit limb checks.
  const sig = [...input.signature];
  sig[0] = String(BigInt(sig[0]) + (1n << 121n));
  sig[1] = String(BigInt(sig[1]) - 1n);
  if (BigInt(sig[1]) >= 0n) await rejects({ ...input, signature: sig }, /Num2Bits|RSAVerifier65537/);
});
