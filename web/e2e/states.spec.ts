// Every state of the page, in both themes at 1280 and 390 px, with reduced motion on: axe finds nothing, no animation
// runs, and with RENDER_DIR set each state is saved as a picture. The origin guard of the harness holds throughout,
// so the bundled fonts and wallet icons are proven local.
import { Networks } from '@stellar/stellar-sdk';
import { DEPLOYMENT, KEY, OTHER, ARTIFACT, drop, expect, open, pick, proofFor, test, toWallet, type World } from './harness.ts';
import { COMBOS, gate, look } from './look.ts';
import type { Page } from '@playwright/test';

type State = [string, (page: Page, world: World) => Promise<(() => void) | void>];

const result = (page: Page) => page.locator('#result-title');
const label = (page: Page, id: string) => page.locator(`#${id} .lbl`);
const paste = (page: Page) => page.getByLabel('Or paste its checksum');
const toStatus = async (page: Page) => {
  await open(page);
  await page.getByRole('button', { name: 'Check a release' }).click();
};
/** Record, then the send whose outcome is unknown, then Check Again from its note. */
const lostSend = async (page: Page, world: World) => {
  world.sendLost = true;
  await toWallet(page);
  await page.locator('#approve-button').click();
  await expect(page.locator('#error-action')).toBeFocused();
};

// Named by the screen numbers of the approved design: 01–03 are the intro (intro.spec), 07–08 are
// the prover's, not the page's.
const STATES: State[] = [
  ['04-home', async (page) => {
    await open(page);
    await expect(page.locator('#line')).toHaveText('Your email stays on this computer.');
  }],
  ['05-drag-over', async (page) => {
    await open(page);
    await page.dispatchEvent('main', 'dragenter', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    await expect(page.locator('#drop-title')).toHaveText('Let go');
  }],
  ['06-email-refused', async (page) => {
    await open(page);
    await drop(page, 'mail.eml', 'From: a@b', 'message/rfc822');
    await expect(label(page, 'error-action')).toHaveText('Choose Another');
  }],
  ['06-not-a-proof', async (page) => {
    await open(page);
    await pick(page, 'approval-proof.json', '{"name":"pkg"}');
    await expect(page.locator('#error')).toBeVisible();
  }],
  ['09-checks', async (page, world) => {
    const go = gate(world, 'simulateTransaction');
    await open(page);
    await pick(page, 'approval-proof.json', proofFor());
    await expect(label(page, 'busy')).toHaveText('Checking');
    await expect(page.locator('#rows')).toContainText('Checking…');
    return go;
  }],
  ['10-wallet-closed', async (page) => {
    await open(page);
    await pick(page, 'approval-proof.json', proofFor());
    await expect(page.locator('#wallet-list button:not(:disabled)').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Connect Wallet' })).toBeFocused();
  }],
  ['11-wallet-sheet', async (page) => {
    await open(page);
    await pick(page, 'approval-proof.json', proofFor());
    await expect(page.locator('#wallet-list button:not(:disabled)').first()).toBeFocused();
  }],
  ['12-dry-run', async (page, world) => {
    const go = gate(world, 'simulateTransaction', 2);
    await toWallet(page);
    await expect(page.locator('#rows')).toContainText('Making sure it will go through');
    return go;
  }],
  ['13-record', async (page) => {
    await toWallet(page);
    await expect(page.locator('#approve-button')).toBeFocused();
    // The fee shows once: in the Fee row, not again in the dry-run note.
    await expect(page.locator('#approve-fee')).toHaveText(/^≈ 0\.\d+ XLM$/);
    await expect(page.locator('#steps li').last()).toHaveText('Try the approval: Done. It works.');
  }],
  ['14-sign', async (page, world) => {
    const go = gate(world, 'sign');
    await toWallet(page);
    await page.locator('#approve-button').click();
    await expect(label(page, 'sign')).toHaveText('Confirm in Rabet');
    return go;
  }],
  ['15-recording', async (page, world) => {
    const go = gate(world, 'getTransaction');
    await toWallet(page);
    await page.locator('#approve-button').click();
    await expect(page.locator('#line')).toHaveText('Recording on Stellar.\nThis takes a few seconds.');
    return go;
  }],
  ['16-recorded', async (page) => {
    await toWallet(page);
    await page.locator('#approve-button').click();
    await expect(result(page)).toHaveText('Recorded.');
    await expect(page.locator('#r-done')).toBeVisible();
  }],
  ['17-wrong-wallet', async (page, world) => {
    world.connectAs = OTHER.publicKey();
    await toWallet(page);
    await expect(page.locator('#error-action')).toBeFocused();
    await expect(page.locator('#rows .tr.bad')).toBeVisible();
  }],
  ['18-wrong-network-with-details', async (page, world) => {
    world.signWith = Networks.PUBLIC;
    await toWallet(page);
    await page.locator('#approve-button').click();
    await expect(page.locator('#error-action')).toBeFocused();
    await page.locator('#error-details summary').click();
  }],
  ['19-fund', async (page, world) => {
    world.balance = null;
    await toWallet(page);
    await expect(label(page, 'error-action')).toHaveText('Get Free XLM');
  }],
  ['20-invalid-proof', async (page, world) => {
    world.submitError = 8;
    await toWallet(page);
    await expect(page.locator('#rows .tr.bad')).toContainText('Doesn’t match');
  }],
  ['21-already', async (page, world) => {
    world.approved = true;
    await open(page);
    await pick(page, 'approval-proof.json', proofFor());
    await expect(result(page)).toHaveText('Already recorded.');
  }],
  ['22-lost', async (page, world) => {
    await lostSend(page, world);
    await expect(page.locator('#error-message')).toContainText('may still go through');
    await expect(label(page, 'error-action')).toHaveText('Check Again');
  }],
  ['22-lost-status', async (page, world) => {
    await lostSend(page, world);
    await page.keyboard.press('Enter');
    // No verdict and no second Record while the first may still go through: Check Again, with the hash kept.
    await expect(page.locator('#r-note')).toContainText('may still go through');
    await expect(result(page)).toBeHidden();
    await expect(page.locator('#r-again')).toBeHidden();
    await expect(label(page, 'check')).toHaveText('Check Again');
    await expect(page.locator('#check')).toBeFocused();
    await expect(page.locator('#r-tx')).toBeVisible();
    await expect(paste(page)).toHaveValue(ARTIFACT);
  }],
  ['22-lost-status-again', async (page, world) => {
    await lostSend(page, world);
    await page.keyboard.press('Enter');
    await expect(label(page, 'check')).toHaveText('Check Again');
    const before = world.calls.filter((c) => c === 'simulateTransaction').length;
    await page.locator('#check').click();
    // The button submits the hidden form: one more lookup, the transaction link kept.
    await expect.poll(() => world.calls.filter((c) => c === 'simulateTransaction').length).toBe(before + 1);
    await expect(page.locator('#r-note')).toContainText('may still go through');
    await expect(page.locator('#r-tx')).toBeVisible();
  }],
  ['23-unavailable', async (page, world) => {
    world.deployment = null;
    await page.goto('/');
    await expect(page.locator('#error-message')).toHaveText('No testnet deployment is configured yet.');
    await expect(page.locator('#error-action')).toBeHidden();
  }],
  ['24-status', async (page) => {
    await toStatus(page);
    await expect(paste(page)).toBeFocused();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Is it approved?');
  }],
  ['25-hashing', async (page) => {
    await toStatus(page);
    // A release file whose read never finishes: the hashing progress stays on screen.
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(4 << 20)], 'release.tar.gz'));
      const f = d.files[0]!;
      f.stream = () => new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(1 << 20)) });
      return d;
    });
    await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
    await expect(page.locator('#progress-text')).toHaveText('25%');
    await expect(page.locator('#line')).toHaveText('release.tar.gz · 4.0 MB');
  }],
  ['26-bad-hash', async (page) => {
    await toStatus(page);
    await paste(page).fill('abc');
    await page.keyboard.press('Enter');
    await expect(page.locator('#ferr')).toHaveText('61 characters short. A checksum has 64.');
    await expect(paste(page)).toBeFocused();
  }],
  ['27-looking-up', async (page, world) => {
    const go = gate(world, 'simulateTransaction');
    await toStatus(page);
    await paste(page).fill(ARTIFACT);
    await page.keyboard.press('Enter');
    await expect(page.locator('#line')).toHaveText('Checking Stellar…');
    await expect(label(page, 'busy')).toHaveText('Checking');
    return go;
  }],
  ['27-after-lost-send', async (page, world) => {
    const go = gate(world, 'simulateTransaction', 4); // 1 the checks, 2-3 the dry run and its re-check, 4 the lookup after the lost send
    await lostSend(page, world);
    await page.keyboard.press('Enter');
    await expect(page.locator('#line')).toHaveText('Checking Stellar…');
    await expect(page.locator('#r-tx')).toBeVisible();
    await expect(page.locator('#result')).toBeHidden();
    return go;
  }],
  ['28-approved', async (page, world) => {
    world.approved = true;
    await toStatus(page);
    await paste(page).fill(ARTIFACT);
    await page.keyboard.press('Enter');
    await expect(result(page)).toHaveText('Approved.');
    await expect(page.locator('#r-rows')).toContainText(`${KEY.publicKey().slice(0, 4)}…${KEY.publicKey().slice(-4)}`);
    // SOW D3: the page shows the project, the release and its status; the approver's domain comes from the deployment.
    await expect(page.locator('#r-rows')).toContainText(`Approved by${DEPLOYMENT.senderDomain}`);
    await expect(page.locator('#r-rows')).toContainText(`Project${DEPLOYMENT.projectId}`);
    await expect(page.locator('#r-wallet')).toHaveText(KEY.publicKey());
  }],
  ['28-lookup-failed', async (page, world) => {
    await toStatus(page);
    world.rpcOffline = true;
    await paste(page).fill(ARTIFACT);
    await page.keyboard.press('Enter');
    // A lookup that failed is not "Checking": no chip word for it and no shimmer.
    await expect(page.locator('#error-message')).toBeVisible();
    await expect(page.locator('.mark .m-chip')).not.toHaveText('Checking');
    await expect(page.locator('.mark')).not.toHaveClass(/\bshim\b/);
  }],
  ['29-not-approved', async (page) => {
    await toStatus(page);
    await drop(page, 'release.tar.gz', 'release bytes');
    await expect(result(page)).toHaveText('Not yet.');
    await expect(page.locator('#r-again')).toBeVisible(); // nothing was sent from here, so recording is the next step
  }],
];

for (const c of COMBOS) {
  test.describe(`${c.scheme} ${c.width}px`, () => {
    test.use({ colorScheme: c.scheme, viewport: { width: c.width, height: c.height }, contextOptions: { reducedMotion: 'reduce' } });
    for (const [name, reach] of STATES) {
      test(name, async ({ page, world }) => {
        const release = await reach(page, world);
        await look(page, name);
        release?.();
      });
    }
  });
}

test('without reduced motion the page does animate (so the check above means something)', async ({ page, world }) => {
  const go = gate(world, 'simulateTransaction');
  await open(page);
  await pick(page, 'approval-proof.json', proofFor());
  await expect(page.locator('#busy')).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
  go();
});
