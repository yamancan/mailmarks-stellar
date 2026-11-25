// One look at a page state: WCAG 2 A/AA by axe (contrast included), no running animation when the user asks for
// reduced motion, and, with RENDER_DIR set, a screenshot named <state>-<scheme>-<width>.png for the review.
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const COMBOS = [
  { scheme: 'dark', width: 1280, height: 860 },
  { scheme: 'light', width: 1280, height: 860 },
  { scheme: 'dark', width: 390, height: 844 },
  { scheme: 'light', width: 390, height: 844 },
] as const;

export async function look(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const found = axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(found, `axe on ${name}`).toEqual([]);
  if (await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    expect(await page.evaluate(() => document.getAnimations().map((a) => (a as CSSAnimation).animationName ?? 'transition')), `animations on ${name}`).toEqual([]);
  }
  const dir = process.env.RENDER_DIR;
  if (dir) {
    const scheme = await page.evaluate(() => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
    mkdirSync(dir, { recursive: true });
    // An overlay is fixed to the viewport, so a full-page picture would show the page uncovered below it.
    const overlay = await page.locator('#wallets:not([hidden]), .story').count();
    await page.screenshot({ path: join(dir, `${name}-${scheme}-${page.viewportSize()!.width}.png`), fullPage: !overlay });
  }
}

/** Holds `what` (an RPC method, or 'sign') on its `nth` call until the returned function is called. */
export function gate(world: { hold?: (what: string) => Promise<void> | undefined }, what: string, nth = 1): () => void {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  let n = 0;
  world.hold = (w) => (w === what && ++n === nth ? p : undefined);
  return () => {
    world.hold = undefined;
    release();
  };
}
