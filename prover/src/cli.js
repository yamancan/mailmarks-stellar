#!/usr/bin/env node
// npm run prove --prefix prover -- <approval.eml> [--out approval-proof.json]   (docs/prover.md)
import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { proveFile, ProverError, KEYS_DIR } from './prove.js';

const USAGE = 'Usage: npm run prove --prefix prover -- <approval.eml> [--out approval-proof.json]';
let args;
try {
  args = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, keys: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
} catch (e) {
  console.error(e.message + '\n' + USAGE);
  process.exit(2);
}
if (args.values.help || args.positionals.length !== 1) {
  console.error(USAGE + '\nWrites approval-proof.json next to the email unless --out names another file. No network is used.');
  process.exit(args.values.help ? 0 : 2);
}
// npm runs scripts inside prover/; INIT_CWD is where the command was typed.
const base = process.env.INIT_CWD || process.cwd();
const eml = resolve(base, args.positionals[0]);
const out = args.values.out ? resolve(base, args.values.out) : join(dirname(eml), 'approval-proof.json');
const keysDir = args.values.keys ? resolve(base, args.values.keys) : KEYS_DIR;
const started = performance.now();
try {
  await proveFile(eml, out, { keysDir });
  console.log('Wrote ' + out + ' in ' + ((performance.now() - started) / 1000).toFixed(1) + ' s.');
  process.exit(0); // snarkjs leaves worker threads running
} catch (e) {
  console.error('Error: ' + (e instanceof ProverError ? e.message : 'unexpected failure: ' + e.message));
  process.exit(1);
}
