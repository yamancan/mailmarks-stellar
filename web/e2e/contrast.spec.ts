// White text on the card sits in its top and bottom bands. The colours come from the hash, so check many hashes:
// the brightest pixel of either band must still give white text WCAG AA contrast (4.5:1).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect, open, test } from './harness.ts';

const card = stripTypeScriptTypes(readFileSync(new URL('../src/card.ts', import.meta.url), 'utf8'));

test('the card bands keep white text at AA contrast for 300 random hashes and the extremes', async ({ page }) => {
  await open(page);
  await page.addScriptTag({ type: 'module', content: `${card}\nwindow.__card = { draw, TOP, BOTTOM };` });
  await page.waitForFunction(() => (window as any).__card);
  const worst = await page.evaluate(() => {
    const { draw, TOP, BOTTOM } = (window as any).__card;
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;left:0;top:0;width:358px;height:226px';
    document.body.append(cv);
    const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    const hashes = ['0'.repeat(64), 'f'.repeat(64), '8'.repeat(64)];
    for (let i = 0; i < 300; i++) hashes.push(hex(crypto.getRandomValues(new Uint8Array(32))));
    let worst = { ratio: Infinity, hash: '' };
    for (const h of hashes) {
      draw(cv, h);
      const g = cv.getContext('2d')!;
      const H = cv.height, W = cv.width;
      for (const [y0, y1] of [[0, Math.floor(H * TOP)], [Math.ceil(H * BOTTOM), H]]) {
        const d = g.getImageData(0, y0, W, y1 - y0).data;
        let L = 0;
        for (let p = 0; p < d.length; p += 4) L = Math.max(L, 0.2126 * lin(d[p]!) + 0.7152 * lin(d[p + 1]!) + 0.0722 * lin(d[p + 2]!));
        const ratio = 1.05 / (L + 0.05);
        if (ratio < worst.ratio) worst = { ratio, hash: h };
      }
    }
    return worst;
  });
  expect(worst.ratio, `worst hash ${worst.hash}`).toBeGreaterThanOrEqual(4.5);
});
