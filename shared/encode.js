// Approval template and public-input encoding. Spec: docs/template.md. The circuit and the
// Soroban contract must produce exactly these field elements; shared test vectors: docs/public-input-vectors.json.
// Browser-safe: no Node built-ins, no dependencies (used by the prover and the page).

// The Subject's first word and its space. Owner's decision, 21 Nov 2026: "emailmark", not the SOW's wording
// (docs/scope.md; docs/delivery.md, Deviations). The circuit's PREFIX array (circuits/approval.circom) holds the same bytes.
export const SUBJECT_PREFIX = 'emailmark ';
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
// BN254 scalar field order; every public input must be below it.
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// Stellar account strkey (G...): base32 (RFC 4648, no padding) of version byte 6<<3, 32-byte key and CRC16-XModem
// of those 33 bytes, little-endian. 56 characters = 35 bytes exactly, so there are no spare bits.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
export function isAccountStrkey(s) {
  if (typeof s !== 'string' || s.length !== 56) return false;
  const out = new Uint8Array(35);
  let acc = 0, bits = 0, n = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return false;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  if (out[0] !== 6 << 3) return false;
  const crc = crc16xmodem(out.subarray(0, 33));
  return out[33] === (crc & 0xff) && out[34] === crc >> 8;
}

// Bytes (at most 31) right-padded with zeros to 31 bytes, read big-endian. Contract side:
// [0x00, ...bytes, 0x00...] as BytesN<32> -> Bn254Fr. Input bytes are printable ASCII, so no trailing zeros are lost.
export function packAscii31(str) {
  if (typeof str !== 'string' || !/^[\x20-\x7e]*$/.test(str)) throw new Error('packAscii31: printable ASCII only');
  if (str.length === 0 || str.length > 31) throw new Error(`packAscii31: length ${str.length} not in 1..31`);
  const padded = new Uint8Array(31);
  padded.set(new TextEncoder().encode(str));
  return BigInt('0x' + bytesToHex(padded));
}

export function validateFields({ projectId, artifactSha256, wallet }) {
  for (const v of [projectId, artifactSha256, wallet]) if (typeof v !== 'string') throw new Error('approval fields must be strings');
  if (!PROJECT_RE.test(projectId)) throw new Error('project_id must match [a-z0-9][a-z0-9-]{0,30}');
  if (!HEX64_RE.test(artifactSha256)) throw new Error('artifact_sha256 must be 64 lowercase hex characters');
  if (!isAccountStrkey(wallet)) throw new Error('wallet must be a valid G... account strkey');
}

export function buildSubject(fields) {
  validateFields(fields);
  return `${SUBJECT_PREFIX}${fields.projectId} ${fields.artifactSha256} ${fields.wallet}`;
}

// Strict inverse of buildSubject: exactly single spaces, no extra text.
export function parseSubject(subject) {
  if (!subject.startsWith(SUBJECT_PREFIX)) throw new Error(`subject does not start with "${SUBJECT_PREFIX}"`);
  const parts = subject.slice(SUBJECT_PREFIX.length).split(' ');
  if (parts.length !== 3) throw new Error('subject must have exactly three fields');
  const [projectId, artifactSha256, wallet] = parts;
  validateFields({ projectId, artifactSha256, wallet });
  return { projectId, artifactSha256, wallet };
}

// Public signals in circuit order (docs/template.md §Public inputs), excluding key hash and nullifier.
export function encodeFields({ projectId, artifactSha256, wallet }) {
  validateFields({ projectId, artifactSha256, wallet });
  return {
    wallet0: packAscii31(wallet.slice(0, 31)),
    wallet1: packAscii31(wallet.slice(31)),
    projectId: packAscii31(projectId),
    artifactHi: BigInt('0x' + artifactSha256.slice(0, 32)),
    artifactLo: BigInt('0x' + artifactSha256.slice(32)),
  };
}

// Full public-signal vector as decimal strings, the snarkjs public.json form.
export function publicSignals(fields, dkimKeyHash, nullifier) {
  const e = encodeFields(fields);
  const out = [e.wallet0, e.wallet1, e.projectId, e.artifactHi, e.artifactLo, dkimKeyHash, nullifier];
  if (typeof dkimKeyHash !== 'bigint' || typeof nullifier !== 'bigint') throw new Error('key hash and nullifier must be bigint');
  for (const v of out) if (v < 0n || v >= BN254_R) throw new Error('public signal outside BN254 field');
  return out.map(String);
}
