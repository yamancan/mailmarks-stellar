// Offline DKIM verification. @zk-email/helpers' verifyDKIMSignature always resolves keys over DNS-over-HTTPS,
// which the offline prover must not do; we drive its bundled verifier with a resolver backed by local key records.
import helpersDkim from '@zk-email/helpers/dist/lib/mailauth/dkim-verifier.js';
import tools from '@zk-email/helpers/dist/lib/mailauth/tools.js';
import { poseidonLarge } from '@zk-email/helpers/dist/hash.js';
import { createPublicKey } from 'node:crypto';

const { DkimVerifier } = helpersDkim;

// keys: { "<selector>._domainkey.<domain>": "v=DKIM1; k=rsa; p=..." } — the pinned record(s), never fetched.
export function localResolver(keys) {
  return async (name, type) => {
    if (type === 'TXT' && Object.hasOwn(keys, name)) return [[keys[name]]];
    const err = new Error(`no local DKIM record for ${name}`);
    err.code = 'ENOTFOUND';
    throw err;
  };
}

export async function verifyDkimOffline(email, keys, domain) {
  const raw = Buffer.from(email);
  if (!/\r?\n\r?\n/.test(raw.toString('latin1'))) throw new Error('email has no header/body separator');
  const v = new DkimVerifier({ resolver: localResolver(keys), skipBodyHash: true });
  await tools.writeToStream(v, raw);
  if (v.headerFrom.length !== 1) throw new Error('email must have exactly one From address');
  // A second From/Subject lets a reader see one value while the signature covers another. Count with the
  // verifier's own parsed names (it trims "Subject :" to "subject"), so no spelling escapes the count.
  for (const name of ['from', 'subject']) {
    const n = v.headers.parsed.filter((h) => h.key === name).length;
    if (n !== 1) throw new Error(`email must have exactly one ${name} header, found ${n}`);
  }
  const d = domain || v.headerFrom[0].split('@')[1];
  const reasons = [];
  // The verifier pushes one result per non-skipped signature header, in order (helpers' dkim-verifier.js), so each
  // result is paired with its own header and h= comes from the signature that was verified.
  const sigs = v.signatureHeaders.filter((x) => !x.skip);
  const pairs = sigs.length === v.results.length ? v.results.map((r, i) => [r, sigs[i]]) : [];
  for (const [r, sig] of pairs.filter(([r]) => r.signingDomain === d)) {
    const why = ineligible(r, sig, keys);
    if (!why) return circuitInputs(r);
    reasons.push(why); // no selector or other email text in messages (docs/prover.md)
  }
  throw new Error(reasons.length ? `no eligible DKIM signature for ${d} (${reasons.join('; ')})` : `no DKIM signature for domain ${d}`);
}

// Eligible = what the circuit can prove (docs/template.md): verified, rsa-sha256, relaxed header canonicalization
// (the circuit's regexes expect lowercase names), RSA-2048 with e = 65537, and an explicit h= covering From and
// Subject with exactly one line each in the signed buffer. Returns the reason it is not, or null.
function ineligible(r, sig, keys) {
  if (!Object.hasOwn(keys, `${r.selector}._domainkey.${r.signingDomain}`)) {
    return 'signed with a different key than the pinned one; the provider may have rotated its key';
  }
  if (r.status.result !== 'pass') return `DKIM verification failed: ${r.status.comment}`;
  if (r.algo !== 'rsa-sha256') return `algorithm ${r.algo}, need rsa-sha256`;
  if ((r.format || 'simple').split('/')[0].trim().toLowerCase() !== 'relaxed') return 'header canonicalization must be relaxed';
  if (r.modulusLength !== 2048) return `${r.modulusLength}-bit key, need 2048`;
  if (createPublicKey(r.publicKey).export({ format: 'jwk' }).e !== 'AQAB') return 'RSA exponent must be 65537';
  const h = (sig?.parsed?.h?.value ?? '').split(':').map((x) => x.trim().toLowerCase());
  const signed = r.status.signedHeaders.toString('latin1').split('\r\n');
  for (const name of ['from', 'subject']) {
    if (!h.includes(name)) return `the signature's h= tag does not list ${name}`;
    if (signed.filter((l) => l.startsWith(name + ':')).length !== 1) return `the DKIM signature must cover the ${name} header exactly once`;
  }
  return null;
}

function circuitInputs(r) {
  const n = createPublicKey(r.publicKey).export({ format: 'jwk' }).n;
  return {
    // Same shape as helpers' DKIMVerificationResult, so generateEmailVerifierInputsFromDKIMResult accepts it.
    signature: BigInt('0x' + Buffer.from(r.signature, 'base64').toString('hex')),
    publicKey: BigInt('0x' + Buffer.from(n, 'base64url').toString('hex')),
    headers: r.status.signedHeaders,
    body: r.body,
    bodyHash: r.bodyHash,
    signingDomain: r.signingDomain,
    selector: r.selector,
    algo: r.algo,
    modulusLength: r.modulusLength,
  };
}

// zk-email's EmailVerifier pubkeyHash = circuit PoseidonLarge(121, 17), which pairs adjacent 121-bit chunks:
// the same as Poseidon over 9 chunks of 242 bits (the helpers' calling convention).
export const dkimKeyHash = (modulus) => poseidonLarge(modulus, 9, 242);
// Nullifier over the RSA signature, same chunking; the circuit also enforces signature < modulus.
export const nullifierOf = (signature) => poseidonLarge(signature, 9, 242);
