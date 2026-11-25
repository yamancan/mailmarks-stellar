// Test-only DKIM signer (rsa-sha256, relaxed/relaxed, RFC 6376). Written independently of the verifier so the
// tests cross-check two implementations. Never used for real approvals.
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

export function testKey({ modulusLength = 2048, publicExponent = 65537 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength, publicExponent });
  const p = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, record: `v=DKIM1; k=rsa; p=${p}` };
}

const relaxedHeader = (name, value) =>
  `${name.toLowerCase()}:${value.replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').trim()}`;

function relaxedBody(body) {
  const lines = body.split('\r\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}

// headers: [[name, value], ...] in message order; values may contain folds ("\r\n ").
// hTag = false omits h= (verifiers then use their default list; `signed` must match it).
export function signEmail({ headers, body, domain, selector, privateKey, signed = ['from', 'to', 'subject', 'date', 'message-id'], hTag = true, canon = 'relaxed' }) {
  const bodyCrlf = body.replace(/\r?\n/g, '\r\n');
  const headerLine = canon === 'simple' ? (n, v) => `${n}: ${v}` : relaxedHeader;
  const bh = createHash('sha256').update(relaxedBody(bodyCrlf)).digest('base64');
  const dkimNoB = `v=1; a=rsa-sha256; c=${canon}/relaxed; d=${domain}; s=${selector}; ${hTag ? `h=${signed.join(':')}; ` : ''}bh=${bh}; b=`;
  // Signed header lines: for each name in h=, the last unused instance (single instances here).
  const lines = signed.map((n) => {
    const h = [...headers].reverse().find(([k]) => k.toLowerCase() === n);
    if (!h) throw new Error(`header ${n} missing`);
    return headerLine(h[0], h[1]) + '\r\n';
  });
  const data = lines.join('') + headerLine('DKIM-Signature', dkimNoB);
  const b = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64');
  const all = [['DKIM-Signature', dkimNoB + b], ...headers];
  return all.map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + bodyCrlf;
}

// An approval email as a provider would send it, with the long Subject folded like Gmail does.
export function approvalEmail({ from, to, subject, domain, selector, privateKey, fold = true }) {
  const subj = fold ? subject.replace(/ (?=[0-9a-f]{64} )/, '\r\n ') : subject;
  return signEmail({
    headers: [
      ['From', from],
      ['To', to],
      ['Subject', subj],
      ['Date', 'Wed, 18 Nov 2026 12:00:00 +0000'],
      ['Message-ID', `<test-${Math.random().toString(36).slice(2)}@${domain}>`],
    ],
    body: 'Approved.\n',
    domain,
    selector,
    privateKey,
  });
}
