// The built page as served, with deployment.json passed through to the preview server: proves the build works without
// docs/deployments/testnet.json and the page says so (skipped when that file exists).
import { existsSync } from 'node:fs';
import { expect, test } from './harness.ts';

test('built without a deployment: the served page says no testnet deployment is configured yet', async ({ page, world }) => {
  test.skip(existsSync(new URL('../../docs/deployments/testnet.json', import.meta.url)), 'a deployment exists');
  world.deployment = 'server'; // the real 404, with the origin guard still on
  const res = await page.request.get('/deployment.json');
  expect(res.status()).toBe(404);
  await page.goto('/');
  await expect(page.locator('#error-message')).toHaveText('No testnet deployment is configured yet.');
});
