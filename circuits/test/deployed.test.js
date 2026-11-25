// The deployed circuit (release_approval.circom) is compiled here too, so a wrong sender constant or length fails
// before the trusted setup. Its sender is docs/template.md's mintmarks@trionlabs.dev; emails use a test key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireTools, compile, circuitInputs, publicOut, rejecter } from './helpers.js';
import { testKey, signEmail } from '../../prover/src/testmail.js';
import { buildSubject, publicSignals } from '../../prover/src/encode.js';

const SENDER = 'mintmarks@trionlabs.dev';
const REF = { projectId: 'mailmarks', artifactSha256: 'bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac', wallet: 'GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN' };

test('docs/template.md names the sender compiled into release_approval.circom', () => {
  assert.match(readFileSync(new URL('../../docs/template.md', import.meta.url), 'utf8'), /deployed sender\s+is \x60mintmarks@trionlabs\.dev\x60/);
  const main = readFileSync(new URL('../release_approval.circom', import.meta.url), 'utf8').match(/ReleaseApproval\(960, 64, (\d+), \[([\d, ]+)\]\)/);
  const bytes = main[2].split(',').map(Number);
  assert.equal(Number(main[1]), bytes.length);
  assert.equal(String.fromCharCode(...bytes), SENDER);
});

test('deployed circuit accepts From exactly mintmarks@trionlabs.dev, rejects mintmarks@trionlabs.dew and .de', async () => {
  await requireTools();
  const { verifyDkimOffline } = await import('../../prover/src/dkim.js');
  const circuit = await compile('../release_approval.circom');
  await circuit.loadConstraints();
  assert.equal(circuit.constraints.length, Number(readFileSync(new URL('../../docs/circuit.md', import.meta.url), 'utf8').match(/Constraints[^\n]*\*\*([\d,]+)\*\*/)[1].replace(/,/g, '')), 'constraint count in docs/circuit.md');
  // snarkjs sizes the Groth16 domain as 2^(floor(log2(constraints + outputs)) + 1): it stays 2^20 (the ptau) below 2^20.
  assert.ok(circuit.constraints.length + 7 < 2 ** 20, 'the deployed circuit fits the 2^20 ptau');
  const key = testKey();
  const email = (from) => {
    const domain = from.split('@')[1];
    const raw = signEmail({
      headers: [['From', 'Mintmarks <' + from + '>'], ['Subject', buildSubject(REF)], ['Date', 'Wed, 18 Nov 2026 12:00:00 +0000']],
      body: 'Approved.\n', domain, selector: 'test', privateKey: key.privateKey, signed: ['from', 'subject', 'date'],
    });
    return verifyDkimOffline(raw, { ['test._domainkey.' + domain]: key.record });
  };
  const ok = await email(SENDER);
  const out = publicOut(await circuit.calculateWitness(circuitInputs(ok), true));
  assert.deepEqual(out.slice(0, 5), publicSignals(REF, 1n, 1n).slice(0, 5));
  const rejects = rejecter(circuit);
  await rejects(circuitInputs(await email('mintmarks@trionlabs.dew')), 'ft[t] === fromAngle'); // same length, last byte differs
  await rejects(circuitInputs(await email('mintmarks@trionlabs.de')), 'ft[t] === fromAngle');
});
