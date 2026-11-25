import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Address, Keypair, Networks, StrKey, TransactionBuilder, scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';
import {
  Chain, ChainError, CONTRACT_ERRORS, TESTNET, approvalKey, checkProject, checkWallet, loadDeployment, parseDeployment,
  submitArgs, verifySigned, type Deployment, type Signer, type SubmitArgs,
} from '../src/chain.ts';
import { toSorobanArgs } from '../../shared/approval-proof.js';
import { accountEntry, approvalEntry, ledgerEntries, mockRpc, simError, simSuccess, txResult, type AccountOpts, type Handler, type Rpc } from './mock-rpc.ts';

const RPC = 'https://rpc.test.example/soroban';
const DEP: Deployment = {
  rpcUrl: RPC,
  networkPassphrase: TESTNET,
  registry: StrKey.encodeContract(new Uint8Array(32).fill(7)),
  projectId: 'mailmarks',
  expert: 'https://stellar.expert/explorer/testnet',
};
const user = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1));
const ARTIFACT = 'ab'.repeat(32);
const ARGS: SubmitArgs = {
  wallet: user.publicKey(),
  projectId: 'mailmarks',
  artifactHash: ARTIFACT,
  dkimKeyHash: '01' + '11'.repeat(31),
  nullifier: '01' + '21'.repeat(31),
  proof: { a: 'aa'.repeat(64), b: 'bb'.repeat(128), c: 'cc'.repeat(64) },
};
const sample = JSON.parse(readFileSync(new URL('../../docs/fixtures/approval-proof.sample.json', import.meta.url), 'utf8'));

const noSleep = async () => {};
const chain = (o: { pollAttempts?: number; rpcTimeoutMs?: number } = {}) =>
  new Chain(DEP, { sleep: noSleep, pollAttempts: o.pollAttempts ?? 3, rpcTimeoutMs: o.rpcTimeoutMs ?? 2_000 });

let rpc: Rpc | undefined;
afterEach(() => {
  rpc?.restore();
  // The page must talk to nothing but the configured RPC.
  for (const c of rpc?.calls ?? []) assert.equal(c.url, RPC);
  rpc = undefined;
});

/** Simulation answers: is_approved and submit are told apart by the invoked function name. */
function world(o: { account?: AccountOpts | null; submit?: unknown; approved?: boolean[]; extra?: Record<string, Handler | 'offline' | 'hang'> } = {}) {
  const approved = [...(o.approved ?? [false])];
  const account = o.account === undefined ? { balance: 100n * 10_000_000n } : o.account;
  return mockRpc({
    getLedgerEntries: ledgerEntries((k) => (k.type === 'account' && account ? accountEntry(user.publicKey(), account) : undefined)),
    simulateTransaction: (p) => {
      const env = xdr.TransactionEnvelope.fromXdr(p.transaction, 'base64');
      const op = (env as any).value.tx.operations[0].body.value;
      const fn = op.hostFunction.value.functionName.toString();
      if (fn === 'is_approved') return simSuccess(xdr.ScVal.scvBool(approved.length > 1 ? approved.shift()! : approved[0]));
      return o.submit ?? simSuccess(xdr.ScVal.scvVoid());
    },
    ...o.extra,
  });
}

async function rejects(p: Promise<unknown>, kind: string, action: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ChainError, String(e));
    assert.equal(e.kind, kind);
    assert.equal(e.action, action);
    return true;
  });
}

describe('deployment', () => {
  test('accepts a testnet deployment', () => assert.deepEqual(parseDeployment({ ...DEP }), DEP));
  test('refuses any other network', () => {
    assert.throws(() => parseDeployment({ ...DEP, networkPassphrase: Networks.PUBLIC }), { message: 'This page only works on Stellar testnet.' });
  });
  for (const [k, v] of [['rpcUrl', 'http://rpc.example'], ['expert', 'javascript:alert(1)'], ['registry', user.publicKey()], ['projectId', 'Mail'], ['rpcUrl', undefined]] as const) {
    test(`refuses bad ${k}`, () => assert.throws(() => parseDeployment({ ...DEP, [k]: v }), (e: any) => e.kind === 'bad-deployment'));
  }
  test('keeps a valid senderDomain, refuses a bad one', () => {
    assert.equal(parseDeployment({ ...DEP, senderDomain: 'trionlabs.dev' }).senderDomain, 'trionlabs.dev');
    for (const v of ['not a domain', 'https://trionlabs.dev', 42, '']) {
      assert.throws(() => parseDeployment({ ...DEP, senderDomain: v }), (e: any) => e.kind === 'bad-deployment');
    }
  });
  test('missing file is "not configured yet"', async () => {
    const f = (async () => new Response('', { status: 404 })) as typeof fetch;
    await rejects(loadDeployment(f), 'no-deployment', 'none');
  });
  test('offline is retry', async () => {
    const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await rejects(loadDeployment(f), 'no-deployment', 'retry');
  });
  test('not JSON is broken config', async () => {
    const f = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    await rejects(loadDeployment(f), 'bad-deployment', 'none');
  });
  test('loads and checks', async () => {
    const f = (async () => Response.json(DEP)) as typeof fetch;
    assert.deepEqual(await loadDeployment(f), DEP);
  });
});

describe('file and wallet checks', () => {
  test('project must match', () => {
    checkProject('mailmarks', DEP);
    assert.throws(() => checkProject('other', DEP), (e: any) => e.kind === 'project-mismatch' && e.action === 'pick-file');
  });
  test('connected account must be the named wallet', () => {
    checkWallet(user.publicKey(), user.publicKey());
    const other = Keypair.random().publicKey();
    assert.throws(() => checkWallet(other, user.publicKey()), (e: any) => e.action === 'switch-account' && e.message.includes(user.publicKey().slice(-4)));
  });
});

describe('encoding', () => {
  test('submit args from approval-proof.json', () => {
    const a = toSorobanArgs(sample);
    const [wallet, project, artifact, key, nul, proof] = submitArgs(a);
    assert.equal(Address.fromScVal(wallet).toString(), sample.fields.wallet);
    assert.equal(project.type, 'scvString');
    assert.equal(scValToNative(project), 'mailmarks');
    assert.equal(Buffer.from(scValToNative(artifact)).toString('hex'), sample.fields.artifactSha256);
    assert.equal(Buffer.from(scValToNative(key)).toString('hex'), sample.soroban.dkimKeyHash);
    assert.equal(Buffer.from(scValToNative(nul)).toString('hex'), sample.soroban.nullifier);
    assert.equal(proof.type, 'scvMap');
    const p = scValToNative(proof);
    assert.deepEqual(Object.keys(p), ['a', 'b', 'c']);
    for (const k of ['a', 'b', 'c']) assert.equal(Buffer.from(p[k]).toString('hex'), sample.soroban[k]);
  });
  test('approval key is Vec[Symbol(Approval), Bytes]', () => {
    const k = approvalKey(ARTIFACT);
    assert.equal(k.type, 'scvVec');
    const [s, b] = (k as any).value;
    assert.equal(s.type, 'scvSymbol');
    assert.equal(scValToNative(s), 'Approval');
    assert.equal(Buffer.from(scValToNative(b)).toString('hex'), ARTIFACT);
  });
});

describe('reads', () => {
  test('is_approved true and false, through the configured RPC only', async () => {
    rpc = world({ approved: [true] });
    assert.equal(await chain().isApproved('mailmarks', ARTIFACT), true);
    rpc.restore();
    rpc = world({ approved: [false] });
    assert.equal(await chain().isApproved('mailmarks', ARTIFACT), false);
  });
  test('approval record decodes, or is null', async () => {
    const rec = { wallet: user.publicKey(), nullifier: ARGS.nullifier, ledger: 4242 };
    rpc = mockRpc({ getLedgerEntries: ledgerEntries((k) => (k.type === 'contractData' ? approvalEntry(DEP.registry, ARTIFACT, rec) : undefined)) });
    assert.deepEqual(await chain().approvalRecord(ARTIFACT), { ...rec, liveUntilLedger: 5_000_000 });
    const sent = xdr.LedgerKey.fromXdr(rpc.calls[0]!.params.keys[0], 'base64');
    assert.equal(sent.type, 'contractData');
    assert.equal((sent as any).value.key.toXdr('base64'), approvalKey(ARTIFACT).toXdr('base64'));
    assert.equal((sent as any).value.durability.name, 'persistent');
    rpc.restore();
    rpc = mockRpc({ getLedgerEntries: ledgerEntries(() => undefined) });
    assert.equal(await chain().approvalRecord(ARTIFACT), null);
  });
  test('spendable = balance − reserves − selling liabilities', async () => {
    rpc = world({ account: { balance: 50_000_000n, numSubEntries: 3, sponsoring: 2, sponsored: 1, selling: 1_000n } });
    // (2 + 3 + 2 − 1) × 0.5 XLM = 3 XLM reserved
    assert.equal(await chain().spendable(user.publicKey()), 50_000_000n - 30_000_000n - 1_000n);
  });
  test('missing account is null', async () => {
    rpc = world({ account: null });
    assert.equal(await chain().spendable(user.publicKey()), null);
  });
  test('RPC unreachable is plain retry', async () => {
    rpc = world({ extra: { simulateTransaction: 'offline' } });
    await rejects(chain().isApproved('mailmarks', ARTIFACT), 'rpc', 'retry');
  });
  test('a stalled RPC times out into plain retry', async () => {
    rpc = world({ extra: { simulateTransaction: 'hang' } });
    await rejects(chain({ rpcTimeoutMs: 50 }).isApproved('mailmarks', ARTIFACT), 'rpc', 'retry');
  });
  test('the default client has a request timeout', () => {
    assert.equal((new Chain(DEP).server as any).httpClient.defaults.timeout, 20_000);
  });
  test('a malformed release hash is refused before any request', async () => {
    rpc = mockRpc({});
    for (const h of ['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), '']) {
      await rejects(chain().isApproved('mailmarks', h), 'bad-hash', 'none');
      await rejects(chain().approvalRecord(h), 'bad-hash', 'none');
    }
    assert.equal(rpc.calls.length, 0);
  });
  test('RPC error answer is plain retry', async () => {
    rpc = world({ extra: { getLedgerEntries: () => { throw new Error('boom'); } } });
    await rejects(chain().approvalRecord(ARTIFACT), 'rpc', 'retry');
  });
});

describe('prepareSubmit', () => {
  test('assembles footprint and fee', async () => {
    rpc = world();
    const { tx, fee } = await chain().prepareSubmit(ARGS);
    assert.equal(fee, BigInt(tx.fee));
    assert.ok(fee >= 123_456n);
    assert.equal(tx.networkPassphrase, TESTNET);
    assert.equal(tx.source, user.publicKey());
    assert.equal(tx.sequence, '101');
    assert.equal((tx.toEnvelope().value as any).tx.ext.type, 'sorobanData');
    assert.equal(Number(tx.timeBounds?.maxTime) - Math.floor(Date.now() / 1000) <= 300, true);
  });
  for (const [code, [kind, , action]] of Object.entries(CONTRACT_ERRORS)) {
    test(`contract error #${code} is "${kind}" → ${action}`, async () => {
      rpc = world({ submit: simError(`HostError: Error(Contract, #${code})\n\nEvent log (newest first): ...`) });
      await rejects(chain().prepareSubmit(ARGS), kind, action);
    });
  }
  test('every contract code has a plain sentence without developer words', () => {
    assert.deepEqual(Object.keys(CONTRACT_ERRORS), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    for (const [, msg] of Object.values(CONTRACT_ERRORS)) assert.doesNotMatch(msg, /strkey|nullifier|ScVal|G2|BN254|#\d/i);
  });
  test('a contract error only in the event log is not the call\'s error', async () => {
    rpc = world({ submit: simError('HostError: Error(Budget, ExceededLimit)\n\nEvent log (newest first):\n   0: [Diagnostic Event] Error(Contract, #7)') });
    await rejects(chain().prepareSubmit(ARGS), 'simulation', 'retry');
  });
  test('other simulation errors are retry', async () => {
    rpc = world({ submit: simError('HostError: Error(Budget, ExceededLimit)') });
    await rejects(chain().prepareSubmit(ARGS), 'simulation', 'retry');
  });
  test('restore preamble is a plain error', async () => {
    rpc = world({ submit: { ...(simSuccess(xdr.ScVal.scvVoid()) as object), restorePreamble: { minResourceFee: '1', transactionData: (simSuccess(xdr.ScVal.scvVoid()) as any).transactionData } } });
    await rejects(chain().prepareSubmit(ARGS), 'needs-restore', 'retry');
  });
  test('missing account is fund', async () => {
    rpc = world({ account: null });
    await rejects(chain().prepareSubmit(ARGS), 'account-missing', 'fund');
  });
  test('balance below the assembled fee is add-xlm with the amount', async () => {
    rpc = world({ account: { balance: 10_000_000n + 100n } }); // 1 XLM reserve leaves 100 stroops
    await assert.rejects(chain().prepareSubmit(ARGS), (e: any) => e.kind === 'underfunded' && e.action === 'add-xlm' && /^Not enough XLM for the fee\. You need 0\.\d+ XLM more for a fee of 0\.\d+ XLM\.$/.test(e.message));
  });
  test('approved by someone else meanwhile is already-approved', async () => {
    rpc = world({ approved: [true] });
    await rejects(chain().prepareSubmit(ARGS), 'already-approved', 'check-status');
  });
});

/** Signs like a wallet would, optionally misbehaving. */
function signer(o: { passphrase?: string; key?: Keypair; mutate?: boolean; raw?: string; refuse?: boolean } = {}): Signer & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    async signTransaction(x, opts) {
      seen.push(opts);
      if (o.refuse) throw new Error('User declined');
      if (o.raw !== undefined) return { signedTxXdr: o.raw };
      const tx = TransactionBuilder.fromXDR(o.mutate ? bumpFee(x) : x, o.passphrase ?? opts.networkPassphrase) as Transaction;
      tx.sign(o.key ?? user);
      return { signedTxXdr: tx.toXDR() };
    },
  };
}
// A wallet that "helpfully" edits the transaction before signing.
function bumpFee(x: string): string {
  const t = TransactionBuilder.fromXDR(x, TESTNET) as Transaction;
  const b = TransactionBuilder.cloneFrom(t, { fee: String(Number(t.fee) + 1) });
  return b.build().toXDR();
}

const hex = (tx: Transaction) => Buffer.from(tx.hash()).toString('hex');

async function prepared() {
  const r = world();
  const p = await chain().prepareSubmit(ARGS);
  r.restore();
  return p.tx;
}

describe('signAndSend', () => {
  const sendOk = { sendTransaction: () => ({ status: 'PENDING', hash: 'h', latestLedger: 1000, latestLedgerCloseTime: '0' }) };

  test('signs on testnet for the wallet, sends and polls to success', async () => {
    const tx = await prepared();
    let polls = 0;
    rpc = mockRpc({
      ...sendOk,
      getTransaction: () => (++polls < 2 ? { status: 'NOT_FOUND', latestLedger: 1000 } : { status: 'SUCCESS', ledger: 1001, latestLedger: 1001 }),
    });
    const s = signer();
    const sending = chain().signAndSend(tx, s, ARGS);
    assert.equal(s.seen.length, 1, 'the wallet is asked with no await first (a popup keeps the click)');
    const out = await sending;
    assert.deepEqual(out, { hash: hex(tx), ledger: 1001 });
    for (const c of rpc.calls.filter((c) => c.method === 'getTransaction')) assert.equal(c.params.hash, hex(tx));
    assert.deepEqual(s.seen, [{ networkPassphrase: TESTNET, address: user.publicKey() }]);
    const sent = rpc.calls.find((c) => c.method === 'sendTransaction')!.params.transaction;
    assert.deepEqual(TransactionBuilder.fromXDR(sent, TESTNET).hash(), tx.hash());
  });
  test('wallet refusal sends nothing', async () => {
    const tx = await prepared();
    rpc = mockRpc({});
    await rejects(chain().signAndSend(tx, signer({ refuse: true }), ARGS), 'wallet-refused', 'retry');
    assert.equal(rpc.calls.length, 0);
  });
  test('wallet on another network sends nothing', async () => {
    const tx = await prepared();
    rpc = mockRpc({});
    await rejects(chain().signAndSend(tx, signer({ passphrase: Networks.PUBLIC }), ARGS), 'wrong-network', 'switch-network');
    assert.equal(rpc.calls.length, 0);
  });
  test('signature by another key sends nothing', async () => {
    const tx = await prepared();
    rpc = mockRpc({});
    await rejects(chain().signAndSend(tx, signer({ key: Keypair.random() }), ARGS), 'wrong-signer', 'switch-account');
    assert.equal(rpc.calls.length, 0);
  });
  test('changed transaction sends nothing', async () => {
    const tx = await prepared();
    rpc = mockRpc({});
    await rejects(chain().signAndSend(tx, signer({ mutate: true }), ARGS), 'tx-changed', 'rebuild');
    assert.equal(rpc.calls.length, 0);
  });
  test('garbage back from the wallet sends nothing', async () => {
    const tx = await prepared();
    assert.throws(() => verifySigned(tx, 'not xdr', user.publicKey()), (e: any) => e.kind === 'bad-signature');
  });
  for (const [code, kind, action] of [
    ['txTooLate', 'txTooLate', 'rebuild'],
    ['txBadSeq', 'txBadSeq', 'rebuild'],
    ['txInsufficientBalance', 'txInsufficientBalance', 'add-xlm'],
    ['txInsufficientFee', 'txInsufficientFee', 'rebuild'],
    ['txBadAuth', 'send-failed', 'rebuild'],
  ] as const) {
    test(`send ERROR ${code} → ${action}`, async () => {
      const tx = await prepared();
      rpc = mockRpc({ sendTransaction: () => ({ status: 'ERROR', hash: 'h', latestLedger: 1000, latestLedgerCloseTime: '0', errorResultXdr: txResult(code) }) });
      await rejects(chain().signAndSend(tx, signer(), ARGS), kind, action);
    });
  }
  test('TRY_AGAIN_LATER → rebuild', async () => {
    const tx = await prepared();
    rpc = mockRpc({ sendTransaction: () => ({ status: 'TRY_AGAIN_LATER', hash: 'h', latestLedger: 1000, latestLedgerCloseTime: '0' }) });
    await rejects(chain().signAndSend(tx, signer(), ARGS), 'busy', 'rebuild');
  });
  test('FAILED on chain and the release is now approved → already-approved, check-status', async () => {
    const tx = await prepared();
    rpc = world({ approved: [true], extra: { ...sendOk, getTransaction: () => ({ status: 'FAILED', ledger: 1001, latestLedger: 1001 }) } });
    await assert.rejects(chain().signAndSend(tx, signer(), ARGS), (e: any) => e.kind === 'already-approved' && e.action === 'check-status' && e.txHash === hex(tx));
  });
  test('FAILED on chain and still not approved → rebuild', async () => {
    const tx = await prepared();
    rpc = world({ approved: [false], extra: { ...sendOk, getTransaction: () => ({ status: 'FAILED', ledger: 1001, latestLedger: 1001 }) } });
    await assert.rejects(chain().signAndSend(tx, signer(), ARGS), (e: any) => e.kind === 'failed' && e.action === 'rebuild' && e.txHash === hex(tx));
  });
  test('FAILED on chain and the re-read fails → check-status', async () => {
    const tx = await prepared();
    rpc = world({ extra: { ...sendOk, simulateTransaction: 'offline', getTransaction: () => ({ status: 'FAILED', ledger: 1001, latestLedger: 1001 }) } });
    await assert.rejects(chain().signAndSend(tx, signer(), ARGS), (e: any) => e.kind === 'failed' && e.action === 'check-status');
  });
  test('polling stops at the deadline, however slow each answer is', async () => {
    const tx = await prepared();
    let t = 0;
    const slow = new Chain(DEP, { now: () => t, sleep: async (ms) => void (t += ms), pollAttempts: 1000, pollDeadlineMs: 90_000 });
    rpc = mockRpc({ ...sendOk, getTransaction: () => { t += 20_000; return { status: 'NOT_FOUND', latestLedger: 1000 }; } });
    await assert.rejects(slow.signAndSend(tx, signer(), ARGS), (e: any) => e.kind === 'timeout' && e.txHash === hex(tx));
    assert.equal(rpc.calls.filter((c) => c.method === 'getTransaction').length, 5); // 0, 22, 44, 66, 88 s
  });
  test('never confirmed → check-status after the poll budget', async () => {
    const tx = await prepared();
    rpc = mockRpc({ ...sendOk, getTransaction: () => ({ status: 'NOT_FOUND', latestLedger: 1000 }) });
    await rejects(chain({ pollAttempts: 4 }).signAndSend(tx, signer(), ARGS), 'timeout', 'check-status');
    assert.equal(rpc.calls.filter((c) => c.method === 'getTransaction').length, 4);
  });
  test('send unreachable → check-status with the transaction hash, no second signature', async () => {
    const tx = await prepared();
    rpc = mockRpc({ sendTransaction: 'offline' });
    await assert.rejects(chain().signAndSend(tx, signer(), ARGS),
      (e: any) => e.kind === 'send-unknown' && e.action === 'check-status' && e.txHash === hex(tx));
  });
  test('a lost poll answer keeps polling with the same hash', async () => {
    const tx = await prepared();
    let polls = 0;
    rpc = mockRpc({
      ...sendOk,
      getTransaction: () => {
        if (++polls === 1) throw new Error('upstream timeout');
        return { status: 'SUCCESS', ledger: 1002, latestLedger: 1002 };
      },
    });
    assert.deepEqual(await chain().signAndSend(tx, signer(), ARGS), { hash: hex(tx), ledger: 1002 });
  });
  test('poll unreachable every time → timeout with the hash', async () => {
    const tx = await prepared();
    rpc = mockRpc({ ...sendOk, getTransaction: 'offline' });
    await assert.rejects(chain().signAndSend(tx, signer(), ARGS), (e: any) => e.kind === 'timeout' && e.txHash === hex(tx));
  });
  test('explorer link', () => assert.equal(chain().txLink('abc'), 'https://stellar.expert/explorer/testnet/tx/abc'));
});
