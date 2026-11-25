// Circuit inputs for a signed header buffer (circuits/approval.circom). Used by the prover and the circuit tests.
import { generateEmailVerifierInputsFromDKIMResult } from '@zk-email/helpers/dist/input-generators.js';
import { SUBJECT_PREFIX } from './encode.js';

export const MAX_HEADER = 960; // circuit buffer, 15 SHA blocks; the signed header itself is at most 951 bytes (docs/circuit.md)
export const MAX_SIGNED_HEADER = 951;

// Index of a header line starting with name (byte 0 or after CRLF). For a buffer the prover's checks accepted this is
// the real line; for the circuit tests' malformed buffers it falls back to the first look-alike, the most favourable
// wrong offset a prover could try.
function lineIndex(text, name) {
  if (text.startsWith(name)) return 0;
  const i = text.indexOf('\r\n' + name);
  return i >= 0 ? i + 2 : Math.max(text.indexOf(name), 0);
}

/** { headers: Buffer (signed, canonical), signature: bigint, publicKey: bigint } -> the circuit's input object. */
export function circuitInputs({ headers, signature, publicKey }) {
  const ev = generateEmailVerifierInputsFromDKIMResult({ headers, signature, publicKey },
    { ignoreBodyHashCheck: true, maxHeadersLength: MAX_HEADER });
  const text = headers.toString('latin1');
  const fromIndex = lineIndex(text, 'from:');
  const fromValue = text.slice(fromIndex + 5).split('\r\n')[0];
  const lt = fromValue.lastIndexOf('<');
  const angled = fromValue.endsWith('>') && lt >= 0;
  const subjectIndex = lineIndex(text, 'subject:');
  const value = text.slice(subjectIndex + 8).split('\r\n')[0];
  const project = (value.startsWith(SUBJECT_PREFIX) ? value.slice(SUBJECT_PREFIX.length) : value).split(' ')[0];
  return {
    ...ev,
    headerLength: String(headers.length),
    fromIndex: String(fromIndex),
    fromNameLength: String(angled ? lt : 0),
    fromAngle: angled ? '1' : '0',
    subjectIndex: String(subjectIndex),
    projectLength: String(project.length),
  };
}
