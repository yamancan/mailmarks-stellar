// SHA-256 of a release file, read in chunks: WebCrypto's digest needs the whole file in memory at once.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '../../shared/encode.js';

export async function sha256File(file: Blob, onProgress?: (done: number, total: number) => void): Promise<string> {
  const h = sha256.create();
  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    h.update(r.value);
    done += r.value.length;
    onProgress?.(done, file.size);
  }
  return bytesToHex(h.digest());
}
