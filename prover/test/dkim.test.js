import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEmailVerifierInputsFromDKIMResult } from '@zk-email/helpers/dist/input-generators.js';
import { testKey, approvalEmail, signEmail } from '../src/testmail.js';
import { verifyDkimOffline, dkimKeyHash, nullifierOf } from '../src/dkim.js';
import { buildSubject, publicSignals } from '../src/encode.js';
import { REF } from './ref.js';

const key = testKey();
const keys = { 'test._domainkey.mailmarks.test': key.record };
const mail = (o = {}) => approvalEmail({
  from: 'Approver <approver@mailmarks.test>', to: 'recipient@mailmarks.test', subject: buildSubject(REF),
  domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, ...o,
});

test('generated approval email verifies offline and yields circuit inputs', async () => {
  const r = await verifyDkimOffline(mail(), keys);
  assert.equal(r.signingDomain, 'mailmarks.test');
  const canon = r.headers.toString();
  assert.match(canon, new RegExp(`subject:${buildSubject(REF)}\\r\\n`)); // the fold is gone after relaxed canonicalization
  assert.match(canon, /from:Approver <approver@mailmarks\.test>\r\n/);
  const inputs = generateEmailVerifierInputsFromDKIMResult(r, { ignoreBodyHashCheck: true, maxHeadersLength: 960 });
  assert.equal(inputs.pubkey.length, 17);
  assert.equal(inputs.signature.length, 17);
  const sig = publicSignals(REF, await dkimKeyHash(r.publicKey), await nullifierOf(r.signature));
  assert.equal(sig.length, 7);
});

test('unfolded subject verifies too', async () => {
  await verifyDkimOffline(mail({ fold: false }), keys);
});

test('altered subject fails DKIM', async () => {
  const m = mail({ fold: false }).replace('mailmarks ', 'mailmarkz ');
  await assert.rejects(verifyDkimOffline(m, keys), /DKIM verification failed/);
});

test('altered From fails DKIM', async () => {
  const m = mail().replace('approver@mailmarks.test', 'attacker@mailmarks.test');
  await assert.rejects(verifyDkimOffline(m, keys), /DKIM verification failed/);
});

test('other key or no local record fails, no network used', async () => {
  const other = testKey();
  await assert.rejects(verifyDkimOffline(mail(), { 'test._domainkey.mailmarks.test': other.record }), /DKIM verification failed/);
  await assert.rejects(verifyDkimOffline(mail(), {}), /no eligible DKIM signature for mailmarks\.test \(signed with a different key than the pinned one; the provider may have rotated its key\)/);
});

test('different emails give different nullifiers, key hash is stable', async () => {
  const [a, b] = await Promise.all([verifyDkimOffline(mail(), keys), verifyDkimOffline(mail(), keys)]);
  assert.notEqual(await nullifierOf(a.signature), await nullifierOf(b.signature));
  assert.equal(await dkimKeyHash(a.publicKey), await dkimKeyHash(b.publicKey));
});

// Raw email with an extra header line inserted right after the DKIM-Signature block.
const withExtra = (m, line) => m.replace(/\r\nFrom: /, `\r\n${line}\r\nFrom: `);

test('duplicate From is refused', async () => {
  await assert.rejects(verifyDkimOffline(withExtra(mail(), 'From: attacker@mailmarks.test'), keys), /exactly one from/i);
});

test('duplicate Subject is refused even though the signature covers one of them', async () => {
  const m = withExtra(mail({ fold: false }), 'Subject: emailmark other 00 GA');
  await assert.rejects(verifyDkimOffline(m, keys), /exactly one subject header/);
});

test('unsigned Subject is refused', async () => {
  const m = signEmail({
    headers: [['From', 'approver@mailmarks.test'], ['Subject', buildSubject(REF)], ['Date', 'Wed, 18 Nov 2026 12:00:00 +0000']],
    body: 'x\n', domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, signed: ['from', 'date'],
  });
  await assert.rejects(verifyDkimOffline(m, keys), /h= tag does not list subject/);
});

test('a duplicate Subject spelled "Subject :" is refused too', async () => {
  const m = withExtra(mail({ fold: false }), 'Subject : emailmark other 00 GA');
  await assert.rejects(verifyDkimOffline(m, keys), /exactly one subject header, found 2/);
});

test('message without a header/body separator is refused', async () => {
  await assert.rejects(verifyDkimOffline(mail().replace(/\r\n\r\n/, '\r\n'), keys), /no header\/body separator/);
});

// The same headers signed twice: an unpinned selector first, the pinned one second.
test('an ineligible first signature does not hide a later eligible one', async () => {
  const other = testKey();
  const m = mail({ fold: false });
  const first = signEmail({
    headers: m.split('\r\n\r\n')[0].split('\r\n').slice(1).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
    body: 'Approved.\n', domain: 'mailmarks.test', selector: 'old', privateKey: other.privateKey,
  }).split('\r\n')[0];
  const r = await verifyDkimOffline(first + '\r\n' + m, keys);
  assert.equal(r.selector, 'test');
  // Alone, the unpinned signature gets the plain rotated-key message.
  await assert.rejects(verifyDkimOffline(first + '\r\n' + m, {}), /^Error: no eligible DKIM signature for mailmarks\.test \(signed with a different key than the pinned one/);
});

test('key that is not RSA-2048 with exponent 65537 is refused', async () => {
  for (const [opts, re] of [[{ modulusLength: 1024 }, /1024-bit key, need 2048/], [{ publicExponent: 3 }, /exponent must be 65537/]]) {
    const k = testKey(opts);
    const m = mail({ privateKey: k.privateKey });
    await assert.rejects(verifyDkimOffline(m, { 'test._domainkey.mailmarks.test': k.record }), re);
  }
});

test('signature without an explicit h= tag is refused', async () => {
  // Default list order (from, subject, date, message-id, to) for the headers present.
  const m = signEmail({
    headers: [['From', 'approver@mailmarks.test'], ['To', 'r@mailmarks.test'], ['Subject', buildSubject(REF)], ['Date', 'Wed, 18 Nov 2026 12:00:00 +0000'], ['Message-ID', '<x@mailmarks.test>']],
    body: 'x\n', domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey,
    signed: ['from', 'subject', 'date', 'message-id', 'to'], hTag: false,
  });
  await assert.rejects(verifyDkimOffline(m, keys), /h= tag does not list from/);
});

test('simple header canonicalization is refused (the circuit expects relaxed)', async () => {
  const m = signEmail({
    headers: [['From', 'approver@mailmarks.test'], ['Subject', buildSubject(REF)], ['Date', 'Wed, 18 Nov 2026 12:00:00 +0000']],
    body: 'x\n', domain: 'mailmarks.test', selector: 'test', privateKey: key.privateKey, signed: ['from', 'subject', 'date'], canon: 'simple',
  });
  await assert.rejects(verifyDkimOffline(m, keys), /canonicalization must be relaxed/);
});
