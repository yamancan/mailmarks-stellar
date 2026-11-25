// Browser-test harness: a fake testnet behind context.route (JSON-RPC answered with the same helpers as the unit
// tests), a fake Rabet extension whose key stays in Node (signing through page.exposeFunction), and an origin guard
// that fails the test on any request outside the page's allowed origins, including those made at kit import and init.
import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Keypair, Networks, TransactionBuilder, xdr, type Transaction } from '@stellar/stellar-sdk';
import { accountEntry, approvalEntry, simError, simSuccess } from '../test/mock-rpc.ts';
import { buildApprovalProof } from '../../shared/approval-proof.js';
import { publicSignals } from '../../shared/encode.js';
import { sample } from '../scripts/contract-fixture.ts';

export const DEPLOYMENT = JSON.parse(readFileSync(new URL('../../docs/fixtures/deployment.sample.json', import.meta.url), 'utf8'));
export const PAGE = 'http://localhost:4173';
const RPC = new URL(DEPLOYMENT.rpcUrl).origin;
const FRIENDBOT = 'https://friendbot.stellar.org';
const ALLOWED = [PAGE, RPC, FRIENDBOT];

/** Test-only key, made from a fixed seed; it exists on no network. */
export const KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
export const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
export const ARTIFACT = 'bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac';
export const TX_HASH_RE = /\/tx\/[0-9a-f]{64}$/;

/** An approval-proof.json for `wallet` (the format sample's proof points; the fake RPC does not verify them). */
export function proofFor(o: { wallet?: string; projectId?: string; artifact?: string } = {}): string {
  const s = sample();
  const fields = { projectId: o.projectId ?? 'mailmarks', artifactSha256: o.artifact ?? ARTIFACT, wallet: o.wallet ?? KEY.publicKey() };
  const ap = buildApprovalProof({
    fields,
    publicSignals: publicSignals(fields, BigInt('0x' + s.soroban.dkimKeyHash), BigInt('0x' + s.soroban.nullifier)),
    proof: { pi_a: [...s.proof.a, '1'], pi_b: [...s.proof.b, ['1', '0']], pi_c: [...s.proof.c, '1'], protocol: 'groth16', curve: 'bn128' },
    note: undefined,
  });
  return JSON.stringify(ap, null, 2);
}

export interface World {
  /** Served as deployment.json; 404 when null; 'server' passes the request to the preview server. */
  deployment: unknown | null | 'server';
  approved: boolean;
  /** Account balance in stroops; null when the account does not exist. */
  balance: bigint | null;
  /** Registry error code returned by the `submit` simulation. */
  submitError?: number;
  fee: number;
  /** The passphrase the fake wallet signs with (another one models a wallet set to another network). */
  signWith: string;
  connectAs: string;
  refuse: boolean;
  rpcOffline: boolean;
  /** The answer to sendTransaction is lost: the page cannot tell whether the transaction landed. */
  sendLost?: boolean;
  /** RPC methods called, in order. */
  calls: string[];
  /** Requests to origins outside the allowed list (aborted). */
  outside: string[];
  /** Holds an RPC method (or 'sign', the wallet's signature) until the returned promise settles: a way to see a
   * step while it runs. */
  hold?: (what: string) => Promise<void> | undefined;
}

export const test = base.extend<{ world: World; introSeen: boolean }>({
  /** The first-visit intro is marked as seen unless a test asks for a first visit. */
  introSeen: [true, { option: true }],
  // auto: every test gets the fake network and the origin guard, whether or not it reads `world`.
  world: [async ({ context, page, introSeen }, use) => {
    const w: World = {
      deployment: DEPLOYMENT,
      approved: false,
      balance: 100n * 10_000_000n,
      fee: 123_456,
      signWith: Networks.TESTNET,
      connectAs: KEY.publicKey(),
      refuse: false,
      rpcOffline: false,
      calls: [],
      outside: [],
    };
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (!ALLOWED.includes(url.origin)) {
        w.outside.push(req.url());
        return route.abort('blockedbyclient');
      }
      if (url.origin === PAGE) {
        if (url.pathname.endsWith('/deployment.json') && w.deployment !== 'server') {
          return w.deployment === null ? route.fulfill({ status: 404, body: 'not found' }) : route.fulfill({ json: w.deployment });
        }
        return route.continue();
      }
      if (url.origin === FRIENDBOT) {
        w.calls.push('friendbot');
        if (w.balance === null) w.balance = 10_000n * 10_000_000n;
        return route.fulfill({ json: { successful: true } });
      }
      // CORS preflight from the browser for the JSON-RPC POST.
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (w.rpcOffline) return route.abort('internetdisconnected');
      if (w.sendLost && req.postDataJSON().method === 'sendTransaction') return route.abort('connectionreset');
      const body = req.postDataJSON();
      w.calls.push(body.method);
      await w.hold?.(body.method);
      const reply = (result: unknown) => route.fulfill({ headers: cors, json: { jsonrpc: '2.0', id: body.id, result } });
      return reply(rpcAnswer(w, body.method, body.params));
    });

    // The fake extension. window.rabet is what the kit's Rabet module looks for; nothing else on the page is touched.
    await page.exposeFunction('__rabetConnect', () => w.connectAs);
    await page.exposeFunction('__rabetSign', async (txXdr: string, activated: boolean) => {
      w.calls.push(activated ? 'sign' : 'sign without a click');
      await w.hold?.('sign');
      if (w.refuse) throw new Error('User declined');
      const tx = TransactionBuilder.fromXDR(txXdr, w.signWith) as Transaction;
      tx.sign(w.connectAs === KEY.publicKey() ? KEY : OTHER);
      return tx.toXDR();
    });
    if (introSeen) await page.addInitScript(() => localStorage.setItem('mm.intro', '1'));
    await page.addInitScript(() => {
      const g = window as any;
      g.rabet = {
        connect: async () => ({ publicKey: await g.__rabetConnect() }),
        // Read before any await: a wallet popup (Albedo, xBull) opens only while the page has the click's activation.
        sign: async (x: string) => ({ xdr: await g.__rabetSign(x, navigator.userActivation.isActive) }),
      };
    });
    await use(w);
    expect(w.outside, 'requests outside the allowed origins').toEqual([]);
    expect(w.calls, 'signing started without a click').not.toContain('sign without a click');
  }, { auto: true }],
});
export { expect };

function fnName(txXdr: string): string {
  const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as Transaction;
  const op = tx.operations[0] as any;
  return Buffer.from(op.func.value.functionName.bytes).toString();
}

function rpcAnswer(w: World, method: string, params: any): unknown {
  switch (method) {
    case 'getLedgerEntries':
      return {
        latestLedger: 1000,
        entries: (params.keys as string[]).flatMap((k) => {
          const key = xdr.LedgerKey.fromXdr(k, 'base64');
          let v: string | undefined;
          if (key.type === 'account' && w.balance !== null) v = accountEntry(w.connectAs, { balance: w.balance });
          if (key.type === 'contractData' && w.approved) v = approvalEntry(DEPLOYMENT.registry, ARTIFACT, { wallet: KEY.publicKey(), nullifier: '21'.repeat(32), ledger: 1234 });
          return v ? [{ key: k, xdr: v, lastModifiedLedgerSeq: 900, liveUntilLedgerSeq: 5_000_000 }] : [];
        }),
      };
    case 'simulateTransaction': {
      const fn = fnName(params.transaction);
      if (fn === 'is_approved') return simSuccess(xdr.ScVal.scvBool(w.approved));
      if (w.submitError) return simError(`HostError: Error(Contract, #${w.submitError})\n\nEvent log (newest first):\n ...`);
      return simSuccess(xdr.ScVal.scvVoid(), w.fee);
    }
    case 'sendTransaction':
      w.approved = true;
      return { status: 'PENDING', hash: 'ignored', latestLedger: 1000, latestLedgerCloseTime: '0' };
    case 'getTransaction':
      return { status: 'SUCCESS', ledger: 1234, latestLedger: 1234 };
    default:
      throw new Error(`no fake for ${method}`);
  }
}
/** Picks a file through the real <input type=file>. */
export async function pick(page: Page, name: string, body: string | Buffer, mimeType = 'application/json') {
  await page.locator('#file').setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
}

/** Drops a file on the page body as a user would (a DataTransfer built in the page). */
export async function drop(page: Page, name: string, body: string, type = '') {
  const dt = await page.evaluateHandle(([n, b, t]) => {
    const d = new DataTransfer();
    d.items.add(new File([b], n, { type: t }));
    return d;
  }, [name, body, type] as const);
  await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
}

/** Opens the page and waits until it is ready for a file. */
export async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('#pick')).toBeVisible();
}

/** The common path to the wallet list, then a Rabet connect. */
export async function toWallet(page: Page, proof = proofFor()) {
  await open(page);
  await pick(page, 'approval-proof.json', proof);
  await expect(page.getByRole('button', { name: 'Rabet' })).toBeVisible();
  await page.getByRole('button', { name: 'Rabet' }).click();
}

/** The Approve click after the dry run; the wallet is not asked to sign before it. */
export async function approve(page: Page, world: World) {
  await expect(page.locator('#approve-button')).toBeFocused();
  expect(world.calls).not.toContain('sign');
  await page.locator('#approve-button').click();
}

export const errorBox = (page: Page) => page.locator('#error');
