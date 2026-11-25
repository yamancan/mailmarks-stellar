// The first-visit intro: shown once, keyboard-only from start to end, and every story passes the same look as the
// page states (axe, no animation under reduced motion, renders with RENDER_DIR).
import { OFFLINE } from '../src/chain.ts';
import { expect, test } from './harness.ts';
import { COMBOS, look } from './look.ts';

test.use({ introSeen: false });

test('first visit: the intro shows, Skip by keyboard ends it, and it stays gone after a reload', async ({ page }) => {
  await page.goto('/');
  const intro = page.getByRole('dialog', { name: 'How Mailmarks works' });
  await expect(intro).toBeVisible();
  await expect(intro).toBeFocused();
  await expect(page.locator('#app')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Tab');
  await expect(intro.getByRole('button', { name: 'Skip' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(intro).toHaveCount(0);
  await expect(page.locator('#drop')).toBeFocused();
  await page.reload();
  await expect(page.locator('#pick')).toBeVisible();
  await expect(intro).toHaveCount(0);
});

test('keys pressed on the focused Next button keep focus on it from story to story, and the last one ends the intro', async ({ page }) => {
  await page.goto('/');
  const intro = page.getByRole('dialog', { name: 'How Mailmarks works' });
  const next = intro.locator('.st-next');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(intro.locator('h2')).toHaveText('Your email\nstays here.');
  await expect(next).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(intro.locator('h2')).toHaveText('Got the go-ahead\nby email?');
  await expect(next).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(intro.locator('h2')).toHaveText('One tap\nto record it.');
  await expect(intro.getByRole('button', { name: 'Start' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(intro).toHaveCount(0);
  await expect(page.locator('#drop')).toBeFocused();
});

test('the story text is one live region updated in place, so each new story is announced', async ({ page }) => {
  await page.goto('/');
  const live = await page.locator('.story [aria-live]').elementHandle();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.story h2')).toHaveText('Your email\nstays here.');
  expect(await live!.evaluate((el) => el.isConnected && el.textContent!.startsWith('Your email\nstays here.'))).toBe(true);
});

test('when the page cannot start, ending the intro focuses the error action', async ({ page }) => {
  await page.route('**/deployment.json', (r) => r.abort('internetdisconnected'), { times: 1 });
  await page.goto('/');
  await expect(page.locator('#error-message')).toHaveText(OFFLINE);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Try Again' })).toBeFocused();
});

test('Skip keeps focus across stories and Escape still works from it', async ({ page }) => {
  await page.goto('/');
  const intro = page.getByRole('dialog', { name: 'How Mailmarks works' });
  await page.keyboard.press('Tab');
  await expect(intro.locator('.skip')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(intro.locator('h2')).toHaveText('Your email\nstays here.');
  await expect(intro.locator('.skip')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  // No Skip on the last story: focus moves to Start.
  await expect(intro.locator('.skip')).toBeHidden();
  await expect(intro.getByRole('button', { name: 'Start' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(intro).toHaveCount(0);
});

for (const c of COMBOS) {
  test.describe(`${c.scheme} ${c.width}px`, () => {
    test.use({ colorScheme: c.scheme, viewport: { width: c.width, height: c.height }, contextOptions: { reducedMotion: 'reduce' } });
    test('every story', async ({ page }) => {
      await page.goto('/');
      for (let i = 1; i <= 3; i++) {
        if (i > 1) await page.keyboard.press('ArrowRight');
        await expect(page.locator('.st-bars i').nth(i - 1)).toHaveClass('now');
        await look(page, `intro-${i}`);
      }
    });
  });
}
