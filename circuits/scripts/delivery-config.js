// Deployment configuration for the delivery contracts, from the delivery verifying key and the pinned DKIM key:
// writes contracts/deploy/delivery.json (verifying key in soroban bytes, G2 written c1‖c0 by shared/approval-proof.js,
// the DKIM registry's domain hash and key hash, the project). contracts/approval-registry/tests/delivery.rs and
// scripts/deploy-testnet.sh read it. Run: node circuits/scripts/delivery-config.js   (after delivery-setup.sh)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { g1Hex, g2Hex } from '../../shared/approval-proof.js';

const VK = new URL('../build/delivery/release_approval_vk.json', import.meta.url);
const KEY = new URL('../../prover/keys/trionlabs.dev-google.json', import.meta.url);
const OUT = new URL('../../contracts/deploy/delivery.json', import.meta.url);
if (!existsSync(VK)) throw new Error('missing ' + fileURLToPath(VK) + ': run "bash circuits/scripts/delivery-setup.sh" first');

const vkText = readFileSync(VK);
const vk = JSON.parse(vkText);
if (vk.protocol !== 'groth16' || vk.curve !== 'bn128' || vk.nPublic !== 7) throw new Error('not the 7-signal Groth16 BN254 key');
const key = JSON.parse(readFileSync(KEY, 'utf8'));
const affine = (p) => p.slice(0, 2);
const config = {
  note: 'Delivery deployment configuration written by circuits/scripts/delivery-config.js (docs/deploy.md). Do not edit.',
  circuit: 'circuits/release_approval.circom (sender mintmarks@trionlabs.dev, 960-byte header buffer)',
  vkSha256: createHash('sha256').update(vkText).digest('hex'),
  projectId: 'mailmarks',
  domain: key.domain,
  domainHash: createHash('sha256').update(key.domain).digest('hex'),
  dkimKey: key.dnsName + ', fetched ' + key.fetched + ' (prover/keys/trionlabs.dev-google.json, docs/dkim-key.md)',
  dkimKeyHash: BigInt(key.keyHash).toString(16).padStart(64, '0'),
  vk: {
    alpha: g1Hex(affine(vk.vk_alpha_1), 'vk.alpha'),
    beta: g2Hex(affine(vk.vk_beta_2), 'vk.beta'),
    gamma: g2Hex(affine(vk.vk_gamma_2), 'vk.gamma'),
    delta: g2Hex(affine(vk.vk_delta_2), 'vk.delta'),
    ic: vk.IC.map((p, i) => g1Hex(affine(p), 'vk.ic[' + i + ']')),
  },
};
mkdirSync(new URL('.', OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(config, null, 2) + '\n');
console.log('wrote ' + fileURLToPath(OUT));
