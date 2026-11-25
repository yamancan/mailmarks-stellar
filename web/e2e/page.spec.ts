import { createHash } from 'node:crypto';
import { Networks } from '@stellar/stellar-sdk';
import { CONTRACT_ERRORS, OFFLINE, WRONG_NETWORK } from '../src/chain.ts';
import { ARTIFACT, DEPLOYMENT, KEY, OTHER, TX_HASH_RE, approve, drop, errorBox, expect, open, pick, proofFor, test, toWallet } from './harness.ts';

test('loads with one h1, the kit initialised and only allowed origins contacted', async ({ page }) => {
  await open(page);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record an email approval');
});

test('file accepted, dry run, Approve, then send and confirm: the approval is read back with the Stellar Expert link', async ({ page, world }) => {
  await toWallet(page);
  await expect(page.locator('#steps li').last()).toHaveText(/Try the approval: Done/);
  await approve(page, world);
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
  await expect(page.locator('#r-wallet')).toHaveText(KEY.publicKey());
  await expect(page.locator('#r-ledger')).toHaveText('1234');
  await expect(page.locator('#r-tx')).toHaveAttribute('href', new RegExp(`^${DEPLOYMENT.expert}/tx/[0-9a-f]{64}$`));
  await expect(page.locator('#steps li')).toHaveText([
    /Read the approval file: Done/,
    /Check the project.*: Done/,
    /Connect the wallet.*: Done/,
    /Try the approval: Done\. It works\. Network fee: 0\.\d+ XLM/,
    /Sign in your wallet: Done/,
    /Send the approval: Done/,
    /Wait for the network to confirm: Done\. Recorded in ledger 1234/,
  ]);
  await expect(page.locator('#f-wallet')).toHaveText(KEY.publicKey());
  expect(world.calls).toContain('sendTransaction');
  // Simulation came before the signature request: no send without a successful simulation first.
  expect(world.calls.indexOf('simulateTransaction')).toBeLessThan(world.calls.indexOf('sendTransaction'));
});

test('an email is refused unread, whether dropped or picked, in both views', async ({ page, world }) => {
  await open(page);
  await drop(page, 'release-approved.eml', 'From: a@b\r\n\r\nsecret', 'message/rfc822');
  await expect(errorBox(page)).toContainText('That is the email itself. It stays on your computer. Drop the proof made from it: approval-proof.json.');
  await expect(page.locator('#error-action')).toHaveText('Choose Another');
  await pick(page, 'mail.eml', 'From: a@b', 'message/rfc822');
  await expect(errorBox(page)).toContainText('It stays on your computer');
  await page.getByRole('button', { name: 'Check a release' }).click();
  await drop(page, 'mail.EML', 'From: a@b');
  await expect(errorBox(page)).toContainText('That is the email itself. It stays on your computer. Drop the release file to check it.');
  expect(world.calls).toEqual([]);
});

const refusals: [string, string, RegExp][] = [
  ['not JSON', '{nope', /isn’t a proof file/],
  ['another JSON file', '{"name":"pkg"}', /isn’t a proof file/],
  ['another format version', JSON.stringify({ ...JSON.parse(proofFor()), version: 2 }), /made by a different version of the tool/],
  ['another network', JSON.stringify({ ...JSON.parse(proofFor()), network: 'public' }), /another network/],
  ['signals not matching the fields', JSON.stringify({ ...JSON.parse(proofFor()), fields: { ...JSON.parse(proofFor()).fields, wallet: OTHER.publicKey() } }), /proof is incomplete/],
  ['a damaged point', proofFor().replace(/"a": "[0-9a-f]{4}/, '"a": "ffff'), /proof is incomplete/],
];
for (const [what, body, message] of refusals) {
  test(`reader refusal: ${what}`, async ({ page, world }) => {
    await open(page);
    await pick(page, 'approval-proof.json', body);
    await expect(page.locator('#error-message')).toHaveText(message);
    await expect(page.locator('#error-action')).toHaveText('Choose Another');
    await expect(page.locator('#error-details')).toBeAttached();
    await expect(page.locator('#file-name')).toHaveText('approval-proof.json');
    await expect(page.locator('#wallets')).toBeHidden();
    expect(world.calls).toEqual([]);
  });
}

test('project mismatch: stopped on load, no wallet step', async ({ page, world }) => {
  world.deployment = { ...DEPLOYMENT, projectId: 'other-project' };
  await open(page);
  await pick(page, 'approval-proof.json', proofFor());
  await expect(page.locator('#error-message')).toHaveText('This approval is for project "mailmarks"; this page records approvals for "other-project".');
  // The file was read: starting again is the way out, not another pick from here.
  await expect(page.locator('#error-action')).toHaveText('Start Again');
  await expect(page.locator('#f-project')).toHaveText('mailmarks');
  await expect(page.locator('#wallets')).toBeHidden();
  await expect(page.locator('#steps')).not.toContainText('Connect the wallet');
  expect(world.calls).toEqual([]);
  // Start Again goes back to the start, not to a file chooser.
  const chooser = page.waitForEvent('filechooser', { timeout: 1000 }).then(() => true, () => false);
  await page.locator('#error-action').click();
  await expect(page.locator('#drop')).toBeFocused();
  expect(await chooser).toBe(false);
});

test('already approved: the record on load, no wallet step', async ({ page, world }) => {
  world.approved = true;
  await open(page);
  await pick(page, 'approval-proof.json', proofFor());
  await expect(page.locator('#result-title')).toHaveText('Already recorded.');
  await expect(page.locator('#r-wallet')).toHaveText(KEY.publicKey());
  await expect(page.locator('#wallets')).toBeHidden();
  await expect(page.locator('#steps')).not.toContainText('Connect the wallet');
  expect(world.calls).not.toContain('sendTransaction');
});

const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

test('wrong wallet: switch accounts, then Try Again goes on with the same wallet', async ({ page, world }) => {
  world.connectAs = OTHER.publicKey();
  await toWallet(page);
  await expect(page.locator('#error-message')).toHaveText(`This approval is for ${shortKey(KEY.publicKey())}. Switch accounts in your wallet. Nothing was sent.`);
  // The wrong row names the account that connected.
  await expect(page.locator('#rows .tr.bad')).toContainText(`${shortKey(OTHER.publicKey())} connected`);
  await expect(page.locator('#error-action')).toBeFocused();
  expect(world.calls).not.toContain('sendTransaction');
  world.connectAs = KEY.publicKey();
  await page.locator('#error-action').click();
  await approve(page, world);
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
});

test('wrong wallet: Other Wallet shows the list again, the wallet used last focused', async ({ page, world }) => {
  world.connectAs = OTHER.publicKey();
  await toWallet(page);
  await expect(page.locator('#error-action')).toBeFocused();
  await page.getByRole('button', { name: 'Other Wallet' }).click();
  await expect(page.getByRole('button', { name: 'Rabet' })).toBeFocused();
  world.connectAs = KEY.publicKey();
  await page.getByRole('button', { name: 'Rabet' }).click();
  await approve(page, world);
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
});

test('a wallet without getNetwork that signs for another network: caught before sending', async ({ page, world }) => {
  world.signWith = Networks.PUBLIC;
  await toWallet(page);
  await approve(page, world);
  await expect(page.locator('#error-message')).toHaveText(WRONG_NETWORK);
  await expect(page.locator('#error-action')).toHaveText('Try Again');
  await expect(page.locator('#f-wallet')).toHaveText(KEY.publicKey());
  expect(world.calls).not.toContain('sendTransaction');
  world.signWith = Networks.TESTNET;
  await page.locator('#error-action').click();
  await page.locator('#approve-button').click();
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
});

test('unfunded, then funded with Friendbot', async ({ page, world }) => {
  world.balance = null;
  await toWallet(page);
  await expect(page.locator('#error-message')).toHaveText('Not enough XLM for the fee. Test XLM is free. Get it in one tap.');
  await expect(page.locator('#error-action')).toHaveText('Get Free XLM');
  expect(world.calls).not.toContain('friendbot');
  await page.locator('#error-action').click();
  await approve(page, world);
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
  expect(world.calls).toContain('friendbot');
});

test('balance below the fee: the shortfall, then a second look after topping up', async ({ page, world }) => {
  world.balance = 10_000_100n; // 1 XLM of reserve + 100 stroops
  await toWallet(page);
  await expect(page.locator('#error-message')).toHaveText(/^Not enough XLM for the fee\. You need 0\.\d+ XLM more for a fee of 0\.\d+ XLM\.$/);
  await expect(page.locator('#error-action')).toHaveText('Check Again');
  world.balance = 50n * 10_000_000n;
  await page.locator('#error-action').click();
  await approve(page, world);
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
});

for (const [code, [, message, action]] of Object.entries(CONTRACT_ERRORS)) {
  test(`typed error ${code} from simulation: plain message and one action, file kept`, async ({ page, world }) => {
    world.submitError = Number(code);
    await toWallet(page);
    await expect(page.locator('#error-message')).toHaveText(message);
    const button = page.locator('#error-action');
    if (action === 'none') await expect(button).toBeHidden();
    else await expect(button).toHaveText(/\S/);
    await expect(page.locator('#f-artifact')).toHaveText(ARTIFACT);
    await expect(page.locator('#steps li[data-status=error]')).toHaveText(/Try the approval: Failed/);
    expect(world.calls).not.toContain('sendTransaction');
  });
}

test('wallet refusal: nothing sent, try again signs', async ({ page, world }) => {
  world.refuse = true;
  await toWallet(page);
  await approve(page, world);
  await expect(page.locator('#error-message')).toHaveText('The wallet did not sign. Nothing was sent.');
  await expect(page.locator('#steps li[data-status=error]')).toHaveText(/Sign in your wallet: Failed/);
  expect(world.calls).not.toContain('sendTransaction');
  world.refuse = false;
  await page.locator('#error-action').click();
  await expect(page.locator('#approve-button')).toBeFocused();
  await page.locator('#approve-button').click();
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
});

test('RPC unreachable: plain message, try again works', async ({ page, world }) => {
  world.rpcOffline = true;
  await open(page);
  await pick(page, 'approval-proof.json', proofFor());
  await expect(page.locator('#error-message')).toHaveText(OFFLINE);
  world.rpcOffline = false;
  await page.locator('#error-action').click();
  await expect(page.getByRole('button', { name: 'Rabet' })).toBeVisible();
});

test('status view: pasted hash, approved, with the record', async ({ page, world }) => {
  world.approved = true;
  await open(page);
  await page.getByRole('button', { name: 'Check a release' }).click();
  await page.getByLabel('Or paste its checksum').fill(`  ${ARTIFACT.toUpperCase()}\n`);
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('#result-title')).toHaveText('Approved.');
  await expect(page.locator('#r-wallet')).toHaveText(KEY.publicKey());
  await expect(page.locator('#r-ledger')).toHaveText('1234');
});

test('status view: dropped release file, not approved', async ({ page, world }) => {
  await open(page);
  await page.getByRole('button', { name: 'Check a release' }).click();
  await drop(page, 'release.tar.gz', 'release bytes');
  await expect(page.locator('#result-title')).toHaveText('Not yet.');
  const sha = createHash('sha256').update('release bytes').digest('hex');
  await expect(page.locator('#r-artifact')).toHaveText(sha);
  // The hash stays in the field, so Check looks the same release up again.
  await expect(page.getByLabel('Or paste its checksum')).toHaveValue(sha);
  await expect(page.locator('#record')).toBeHidden();
  expect(world.calls).toEqual(['simulateTransaction']);
});

test('status view: a bad pasted hash is refused before any request', async ({ page, world }) => {
  await open(page);
  await page.getByRole('button', { name: 'Check a release' }).click();
  await page.getByLabel('Or paste its checksum').fill('abc');
  await page.keyboard.press('Enter');
  // Said under the field, which keeps focus.
  await expect(page.locator('#ferr')).toHaveText('61 characters short. A checksum has 64.');
  await expect(page.locator('#field')).toHaveClass(/\berr\b/);
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.getByLabel('Or paste its checksum')).toBeFocused();
  await page.keyboard.type('d');
  await expect(page.locator('#ferr')).toBeEmpty();
  expect(world.calls).toEqual([]);
});

test('a non-proof file dropped on the start view is hashed for the status view', async ({ page }) => {
  await open(page);
  await drop(page, 'release.zip', 'zip bytes');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Is it approved?');
  await expect(page.locator('#result-title')).toHaveText('Not yet.');
});

test('no deployment configured: says so plainly', async ({ page, world }) => {
  world.deployment = null;
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('No testnet deployment is configured yet.');
  await expect(page.locator('#error-action')).toBeHidden();
  await expect(page.locator('#pick')).toBeHidden();
});

test('settings unreachable: plain message and a Try Again that works', async ({ page, world }) => {
  await page.route('**/deployment.json', (r) => r.abort('internetdisconnected'), { times: 1 });
  await page.goto('/');
  await expect(page.locator('#error-message')).toHaveText(OFFLINE);
  await page.getByRole('button', { name: 'Try Again' }).click();
  await expect(page.locator('#pick')).toBeVisible();
  void world;
  await expect(page.locator('h1')).toHaveCount(1);
});

test('keyboard only: pick, choose the wallet, Approve, reach the result', async ({ page }) => {
  await open(page);
  // Tab order: the drop card first, which opens the file chooser.
  await page.keyboard.press('Tab');
  await expect(page.locator('#drop')).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles({ name: 'approval-proof.json', mimeType: 'application/json', buffer: Buffer.from(proofFor()) });
  // Focus moves into the wallet sheet; Tab to Rabet and press Enter.
  await expect(page.locator('#wallet-list button:not(:disabled)').first()).toBeFocused();
  for (let i = 0; i < 8 && !(await page.getByRole('button', { name: 'Rabet' }).evaluate((b) => b === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(page.getByRole('button', { name: 'Rabet' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#approve-button')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#result-title')).toHaveText('Recorded.');
  await expect(page.locator('#result-title')).toBeFocused();
  // Then the Details, the link to the transaction, Done and Save Card, in that order.
  for (const sel of ['#r-details summary', '#r-tx', '#r-done', '#r-save']) {
    await page.keyboard.press('Tab');
    await expect(page.locator(sel)).toBeFocused();
  }
  // Escape is Done: back to the start.
  await page.keyboard.press('Escape');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#drop')).toBeFocused();
});

test('a 2 GB release file hashes in the page with progress and the right digest', async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  await page.getByRole('button', { name: 'Check a release' }).click();
  const MB = 1 << 20, COUNT = 2048;
  const chunk = Buffer.alloc(MB);
  for (let i = 0; i < MB; i++) chunk[i] = (i * 31 + 7) & 0xff;
  const h = createHash('sha256');
  for (let i = 0; i < COUNT; i++) h.update(chunk);
  const want = h.digest('hex');
  const dt = await page.evaluateHandle(([mb, count]) => {
    const c = new Uint8Array(mb);
    for (let i = 0; i < mb; i++) c[i] = (i * 31 + 7) & 0xff;
    const d = new DataTransfer();
    d.items.add(new File(Array.from({ length: count }, () => c), 'release-2gb.bin'));
    return d;
  }, [MB, COUNT] as const);
  await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
  await expect(page.locator('#progress-row')).toBeVisible();
  // Progress moves while hashing (the page stays responsive enough to render it).
  await expect.poll(() => page.locator('#progress').evaluate((p: HTMLProgressElement) => p.value), { timeout: 120_000 }).toBeGreaterThan(0);
  await expect(page.locator('#r-artifact')).toHaveText(want, { timeout: 240_000 });
});
