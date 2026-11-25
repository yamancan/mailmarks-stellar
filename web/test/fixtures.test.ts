import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_CALLS_PATH, SAMPLE_PATH, asFile, pageCalls, sample } from '../scripts/contract-fixture.ts';

// The native contract test reads these; if the encoding changes, regenerate and the contract test re-checks it.
test('committed sample equals what the builder produces', () => {
  assert.equal(readFileSync(SAMPLE_PATH, 'utf8'), asFile(sample()), 'run: npm run contract-fixture --prefix web');
});
test('committed contract fixture equals what the page encodes now', () => {
  const committed = readFileSync(SAMPLE_PATH, 'utf8');
  assert.equal(readFileSync(PAGE_CALLS_PATH, 'utf8'), asFile(pageCalls(JSON.parse(committed))), 'run: npm run contract-fixture --prefix web');
});
