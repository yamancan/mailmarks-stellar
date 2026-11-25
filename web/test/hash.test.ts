import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256File } from '../src/hash.ts';

test('hashes a multi-chunk blob incrementally, with progress up to its size', async () => {
  const chunk = new Uint8Array(1 << 20).map((_, i) => i % 251);
  const blob = new Blob([chunk, chunk, chunk, new Uint8Array([1, 2, 3])]);
  const seen: number[] = [];
  const got = await sha256File(blob, (done, total) => {
    assert.equal(total, blob.size);
    seen.push(done);
  });
  const want = createHash('sha256').update(chunk).update(chunk).update(chunk).update(new Uint8Array([1, 2, 3])).digest('hex');
  assert.equal(got, want);
  assert.ok(seen.length > 1, 'progress reported more than once');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(seen.at(-1), blob.size);
});

test('empty file', async () => {
  assert.equal(await sha256File(new Blob([])), createHash('sha256').digest('hex'));
});
