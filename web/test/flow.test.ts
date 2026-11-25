import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Networks, type Transaction } from '@stellar/stellar-sdk';
import { ChainError, contractError, parseDeployment, type ApprovalRecord, type SubmitArgs } from '../src/chain.ts';
import { Flow, normalizeHash, type ChainPort, type State, type WalletPort } from '../src/flow.ts';
import { readFileSync } from 'node:fs';
import { sample } from '../scripts/contract-fixture.ts';
import { toSorobanArgs } from '../../shared/approval-proof.js';

const AP = sample();
const WALLET = AP.fields.wallet;
const ARTIFACT = AP.fields.artifactSha256;
const DEP = parseDeployment({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  registry: 'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM',
  projectId: 'mailmarks',
  expert: 'https://stellar.expert/explorer/testnet',
});
const RECORD: ApprovalRecord = { wallet: WALLET, nullifier: '00'.repeat(32), ledger: 1234, liveUntilLedger: 99 };

interface Stubs {
  approved?: boolean[]; // successive is_approved answers
  prepare?: () => Promise<{ tx: Transaction; fee: bigint }>;
  send?: () => Promise<{ hash: string; ledger: number }>;
  address?: string;
  network?: string | null;
  connectFails?: boolean;
}

function setup(o: Stubs = {}) {
  const calls: string[] = [];
  const prepared: SubmitArgs[] = [];
  const approved = [...(o.approved ?? [false, true])];
  const chain: ChainPort = {
    isApproved: async () => (calls.push('isApproved'), approved.shift() ?? true),
    approvalRecord: async () => (calls.push('approvalRecord'), RECORD),
    prepareSubmit: async (a: SubmitArgs) => (calls.push('prepare'), prepared.push(a), o.prepare ? o.prepare() : { tx: {} as Transaction, fee: 123_456n }),
    signAndSend: async (_tx, _s, _a, onStage) => {
      calls.push('signAndSend');
      onStage?.('send');
      onStage?.('confirm');
      return o.send ? o.send() : { hash: 'ab'.repeat(32), ledger: 1234 };
    },
    txLink: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
  };
  const wallet: WalletPort = {
    list: async () => [{ id: 'varial', name: 'Varial', available: true }],
    connect: async () => {
      calls.push('connect');
      if (o.connectFails) throw { code: -1, message: 'locked' };
      return o.address ?? WALLET;
    },
    network: async () => (o.network === undefined ? Networks.TESTNET : o.network),
    signTransaction: async () => ({ signedTxXdr: '' }),
  };
  const flow = new Flow({ loadDeployment: async () => DEP, chain: () => chain, wallet, fund: async (a) => void calls.push(`fund ${a}`) });
  const history: State[] = [];
  flow.subscribe((s) => history.push(s));
  return { flow, calls, history, prepared };
}

const proofFile = (v: unknown = AP, name = 'approval-proof.json') => new File([JSON.stringify(v)], name, { type: 'application/json' });
const stepIds = (s: State) => s.steps.map((x) => `${x.id}:${x.status}`);

test('happy path: read, check, wallet, prepare, Approve, sign, send, confirm, read back', async () => {
  const { flow, calls } = setup();
  await flow.start();
  await flow.drop(proofFile());
  assert.equal(flow.state.view, 'proof');
  assert.deepEqual(flow.state.file?.fields, { projectId: 'mailmarks', artifactSha256: ARTIFACT, wallet: WALLET });
  assert.deepEqual(flow.state.wallets?.map((w) => w.id), ['varial']);
  await flow.chooseWallet('varial');
  // Stops after the dry run: the wallet is asked to sign only from the Approve click.
  assert.deepEqual(flow.state.approve, { fee: '0.0123456 XLM' });
  assert.deepEqual(stepIds(flow.state), ['read:done', 'check:done', 'wallet:done', 'prepare:done']);
  assert.ok(!calls.includes('signAndSend'));
  const approving = flow.approve();
  assert.ok(calls.includes('signAndSend'), 'signing is reached with no await after the click');
  assert.equal(flow.state.approve, undefined);
  await approving;
  assert.equal(flow.state.error, undefined);
  assert.deepEqual(stepIds(flow.state), ['read:done', 'check:done', 'wallet:done', 'prepare:done', 'sign:done', 'send:done', 'confirm:done']);
  assert.match(flow.state.steps[3]!.note!, /0\.0123456 XLM/);
  assert.equal(flow.state.result?.approved, true);
  assert.equal(flow.state.result?.record?.ledger, 1234);
  assert.equal(flow.state.result?.txLink, `https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`);
  assert.deepEqual(calls, ['isApproved', 'connect', 'prepare', 'signAndSend', 'isApproved', 'approvalRecord']);
});

test('a wrong-project file stops at the check and never offers a wallet', async () => {
  const flow = new Flow({ loadDeployment: async () => ({ ...DEP, projectId: 'other' }), chain: () => ({}) as ChainPort, wallet: {} as WalletPort, fund: async () => {} });
  const history: State[] = [];
  flow.subscribe((s) => history.push(s));
  await flow.start();
  await flow.drop(proofFile());
  assert.equal(flow.state.error?.step, 'check');
  assert.equal(flow.state.error?.action, 'pick-file');
  assert.match(flow.state.error!.message, /project "mailmarks"; this page records approvals for "other"/);
  assert.equal(flow.state.file?.name, 'approval-proof.json', 'file kept');
  assert.ok(history.every((s) => !s.wallets && !s.steps.some((x) => x.id === 'wallet')));
});

test('an already-approved file shows the record and never offers a wallet', async () => {
  const { flow, calls, history } = setup({ approved: [true] });
  await flow.start();
  await flow.drop(proofFile());
  assert.equal(flow.state.result?.already, true);
  assert.equal(flow.state.result?.record?.wallet, WALLET);
  assert.ok(history.every((s) => !s.wallets && !s.steps.some((x) => x.id === 'wallet')));
  assert.deepEqual(calls, ['isApproved', 'approvalRecord']);
});

test('a wallet that reports another network (Varial getNetwork) is stopped before simulation, and resumes after the switch', async () => {
  const o: Stubs = { network: Networks.PUBLIC };
  const { flow, calls } = setup(o);
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  assert.equal(flow.state.error?.step, 'wallet');
  assert.equal(flow.state.error?.action, 'switch-network');
  assert.ok(!calls.includes('prepare'));
  o.network = Networks.TESTNET;
  await flow.act();
  await flow.approve();
  assert.equal(flow.state.error, undefined);
  assert.equal(flow.state.result?.approved, true);
  assert.equal(calls.filter((c) => c === 'connect').length, 2, 'reconnected the same wallet without the list');
});

test('a wallet that cannot say its network goes on (the signature check covers it)', async () => {
  const { flow } = setup({ network: null });
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('rabet');
  await flow.approve();
  assert.equal(flow.state.result?.approved, true);
});

test('another account: Try Again asks the same wallet again; Other Wallet shows the list', async () => {
  const o: Stubs = { address: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H' };
  const { flow, calls } = setup(o);
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  assert.equal(flow.state.error?.action, 'switch-account');
  assert.equal(flow.state.error?.kind, 'wrong-account');
  assert.match(flow.state.error!.message, /GA4T…X2KN/);
  assert.equal(flow.state.address, o.address, 'the connected account is kept for the wrong row');
  await flow.act();
  assert.equal(flow.state.error?.action, 'switch-account', 'same wallet, still the other account');
  assert.equal(calls.filter((c) => c === 'connect').length, 2, 'reconnected the same wallet without the list');
  await flow.otherWallet();
  assert.equal(flow.state.error, undefined);
  assert.equal(flow.state.address, undefined);
  assert.deepEqual(flow.state.wallets?.map((w) => w.id), ['varial']);
  o.address = WALLET;
  await flow.chooseWallet('varial');
  await flow.approve();
  assert.equal(flow.state.result?.approved, true);
  await flow.otherWallet(); // nothing to change once recorded
  assert.equal(flow.state.wallets, undefined);
});

test('a wallet that does not connect: try again shows the list again', async () => {
  const { flow } = setup({ connectFails: true });
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  assert.equal(flow.state.error?.step, 'wallet');
  assert.equal(flow.state.error?.action, 'retry');
  assert.match(flow.state.error!.detail!, /locked/);
  await flow.act();
  assert.ok(flow.state.wallets);
});

test('missing account: fund calls Friendbot for the connected address, then prepares again', async () => {
  let first = true;
  const { flow, calls } = setup({
    prepare: async () => {
      if (first) {
        first = false;
        throw new ChainError('account-missing', 'missing', 'fund');
      }
      return { tx: {} as Transaction, fee: 1n };
    },
  });
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  assert.equal(flow.state.error?.step, 'prepare');
  await flow.act();
  assert.ok(calls.includes(`fund ${WALLET}`));
  assert.ok(flow.state.approve, 'funding never signs on its own');
  assert.ok(!calls.includes('signAndSend'));
  await flow.approve();
  assert.equal(flow.state.result?.approved, true);
});

test('typed errors land on their step with the file kept; check-status opens the status view', async () => {
  const { flow } = setup({ prepare: async () => { throw contractError(7); } });
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  assert.equal(flow.state.error?.step, 'prepare');
  assert.equal(flow.state.error?.action, 'check-status');
  assert.ok(flow.state.file?.fields);
  await flow.act();
  assert.equal(flow.state.view, 'status');
  assert.equal(flow.state.result?.artifact, ARTIFACT);
});

test('a send whose outcome is unknown carries the transaction link into the status view, kept when checked again', async () => {
  const { flow } = setup({ approved: [false, false, true], send: async () => { throw new ChainError('timeout', 'not yet', 'check-status', undefined, 'cd'.repeat(32)); } });
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  await flow.approve();
  assert.equal(flow.state.error?.step, 'confirm');
  assert.match(flow.state.error!.txLink!, /\/tx\/(cd){32}$/);
  await flow.act();
  assert.equal(flow.state.view, 'status');
  assert.equal(flow.state.result?.approved, false);
  assert.match(flow.state.txLink!, /\/tx\/(cd){32}$/);
  await flow.pasteHash(ARTIFACT);
  assert.equal(flow.state.result?.approved, true);
  assert.match(flow.state.txLink!, /\/tx\/(cd){32}$/);
  await flow.pasteHash('ef'.repeat(32));
  assert.equal(flow.state.txLink, undefined, 'another release drops the link');
});

test('a lost send past its time bound can no longer land: the status view drops its link', async () => {
  const now = Date.now();
  const { flow } = setup({
    approved: [false, false],
    prepare: async () => ({ tx: { timeBounds: { minTime: '0', maxTime: String(Math.floor(now / 1000) + 120) } } as Transaction, fee: 1n }),
    send: async () => { throw new ChainError('timeout', 'not yet', 'check-status', undefined, 'cd'.repeat(32)); },
  });
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  await flow.approve();
  assert.match(flow.state.error!.txLink!, /\/tx\/(cd){32}$/);
  const realNow = Date.now;
  Date.now = () => now + 121_000;
  try {
    await flow.act();
  } finally {
    Date.now = realNow;
  }
  assert.equal(flow.state.view, 'status');
  assert.equal(flow.state.result?.approved, false);
  assert.equal(flow.state.txLink, undefined);
});

test('the status view knows the release it looks up before the answer comes', async () => {
  const { flow, history } = setup({ approved: [true] });
  await flow.start();
  await flow.showStatus();
  assert.equal(flow.state.lookup, undefined);
  await flow.pasteHash(ARTIFACT);
  const asking = history.find((s) => s.view === 'status' && s.lookup && !s.result);
  assert.equal(asking?.lookup, ARTIFACT);
  assert.equal(flow.state.lookup, ARTIFACT);
  flow.home();
  assert.equal(flow.state.lookup, undefined);
});

test('Approve on a transaction past its time limit simulates a fresh one instead of signing', async () => {
  let n = 0;
  const { flow, calls } = setup({
    prepare: async () => ({ tx: { timeBounds: { minTime: '0', maxTime: String(++n === 1 ? 1 : Math.floor(Date.now() / 1000) + 300) } } as Transaction, fee: 1n }),
  });
  await flow.start();
  await flow.drop(proofFile());
  await flow.chooseWallet('varial');
  await flow.approve();
  assert.deepEqual(flow.state.approve, { fee: '0.0000001 XLM' });
  assert.match(flow.state.steps.at(-1)!.note!, /^Ran again because the first one passed its time limit\. It works\./);
  assert.deepEqual(calls.filter((c) => c === 'prepare' || c === 'signAndSend'), ['prepare', 'prepare']);
  await flow.approve();
  assert.equal(flow.state.result?.approved, true);
  await flow.approve(); // nothing waits for a click any more
  assert.equal(calls.filter((c) => c === 'signAndSend').length, 1);
});

test('an email is refused without being read', async () => {
  const { flow, calls } = setup();
  await flow.start();
  const eml = new File(['From: x'], 'release.eml');
  Object.defineProperty(eml, 'text', { value: () => assert.fail('read') });
  Object.defineProperty(eml, 'stream', { value: () => assert.fail('read') });
  await flow.drop(eml);
  assert.equal(flow.state.error?.action, 'pick-file');
  assert.match(flow.state.error!.message, /^That is the email itself\. It stays on your computer\. Drop the proof made from it: approval-proof\.json\.$/);
  await flow.showStatus();
  await flow.drop(new File(['x'], 'mail', { type: 'message/rfc822' }));
  assert.equal(flow.state.error?.step, 'hash');
  assert.equal(flow.state.error?.message, 'That is the email itself. It stays on your computer. Drop the release file to check it.');
  assert.deepEqual(calls, []);
});

test('reader refusals map to plain sentences with the reader text in Details', async () => {
  const { flow } = setup();
  await flow.start();
  const cases: [unknown, RegExp][] = [
    ['not json', /isn’t a proof file/],
    [{ hello: 1 }, /isn’t a proof file/],
    [{ ...AP, version: 2 }, /made by a different version of the tool\. Make it again with the current version\./],
    [{ ...AP, network: 'public' }, /another network/],
    [{ ...AP, publicSignals: AP.publicSignals.slice(0, 6) }, /proof is incomplete/],
  ];
  for (const [body, re] of cases) {
    await flow.drop(new File([typeof body === 'string' ? body : JSON.stringify(body)], 'approval-proof.json'));
    assert.equal(flow.state.error?.step, 'read');
    assert.equal(flow.state.error?.action, 'pick-file');
    assert.match(flow.state.error!.message, re);
    assert.ok(flow.state.error!.detail);
    assert.equal(flow.state.file?.name, 'approval-proof.json');
  }
});

test('routing: a large or non-JSON file is hashed for the status view', async () => {
  const { flow, calls } = setup({ approved: [false] });
  await flow.start();
  await flow.drop(new File(['abc'], 'release.tar.gz'));
  assert.equal(flow.state.view, 'status');
  assert.equal(flow.state.result?.artifact, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(flow.state.result?.approved, false);
  await flow.home();
  await flow.drop(new File(['x'.repeat(64 * 1024 + 1)], 'big.json'));
  assert.equal(flow.state.view, 'status');
  assert.deepEqual(calls, ['isApproved', 'isApproved', 'approvalRecord']);
});

test('pasted hash: whitespace dropped and lower-cased; a bad one is refused before any request', async () => {
  const { flow, calls } = setup({ approved: [true] });
  await flow.start();
  assert.equal(normalizeHash(` ${ARTIFACT.slice(0, 32).toUpperCase()}\n ${ARTIFACT.slice(32)} `), ARTIFACT);
  await flow.pasteHash(`  ${ARTIFACT.toUpperCase()}\n`);
  assert.equal(flow.state.result?.approved, true);
  assert.equal(flow.state.result?.record?.ledger, 1234);
  await flow.pasteHash('xyz');
  assert.equal(flow.state.error?.step, 'lookup');
  assert.equal(flow.state.error?.kind, 'bad-hash');
  assert.equal(flow.state.error!.message, 'A checksum uses only 0–9 and a–f.');
  await flow.pasteHash('abc');
  assert.equal(flow.state.error!.message, '61 characters short. A checksum has 64.');
  await flow.pasteHash(ARTIFACT + 'a');
  assert.equal(flow.state.error!.message, 'One character too many. A checksum has 64.');
  assert.equal(calls.length, 2);
});

test('no deployment: the page says so and offers nothing else', async () => {
  const flow = new Flow({
    loadDeployment: async () => { throw new ChainError('no-deployment', 'No testnet deployment is configured yet.', 'none'); },
    chain: () => ({}) as ChainPort,
    wallet: {} as WalletPort,
    fund: async () => {},
  });
  await flow.start();
  assert.equal(flow.state.view, 'unavailable');
  assert.equal(flow.state.error?.message, 'No testnet deployment is configured yet.');
  await flow.drop(proofFile());
  assert.equal(flow.state.view, 'unavailable');
});

test('two proofs dropped in quick succession: the transaction is prepared with the second one, the one on screen', async () => {
  const { flow, prepared } = setup();
  await flow.start();
  // A (another wallet) is still being read when B is dropped, and finishes reading after B is on screen.
  const other = JSON.parse(readFileSync(new URL('../../docs/fixtures/approval-proof.json', import.meta.url), 'utf8'));
  assert.notEqual(other.fields.wallet, WALLET);
  let releaseA!: () => void;
  const fileA = proofFile(other, 'a.json');
  const textA = await fileA.text();
  Object.defineProperty(fileA, 'text', { value: () => new Promise<string>((r) => (releaseA = () => r(textA))) });
  const dropA = flow.drop(fileA);
  await flow.drop(proofFile(AP, 'b.json'));
  assert.equal(flow.state.file?.name, 'b.json');
  releaseA();
  await dropA;
  assert.deepEqual(flow.state.file?.fields, { projectId: 'mailmarks', artifactSha256: ARTIFACT, wallet: WALLET });
  await flow.chooseWallet('varial');
  assert.equal(flow.state.error, undefined);
  assert.deepEqual(prepared, [toSorobanArgs(AP)]);
});

test('a newer file replaces a run in flight: the old run cannot overwrite it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { flow } = setup({ prepare: async () => (await gate, { tx: {} as Transaction, fee: 1n }) });
  await flow.start();
  await flow.drop(proofFile());
  const pending = flow.chooseWallet('varial');
  await flow.drop(new File(['abc'], 'release.bin'));
  release();
  await pending;
  assert.equal(flow.state.view, 'status');
  assert.equal(flow.state.error, undefined);
});

test('friendbot: funded, already funded, refused', async () => {
  const { friendbot } = await import('../src/chain.ts');
  const urls: string[] = [];
  const fake = (status: number, body: string) => (async (u: string) => (urls.push(u), new Response(body, { status }))) as unknown as typeof fetch;
  await friendbot(WALLET, fake(200, '{}'));
  assert.equal(urls[0], `https://friendbot.stellar.org/?addr=${WALLET}`);
  await friendbot(WALLET, fake(400, '{"detail":"createAccountAlreadyExist"}'));
  await assert.rejects(friendbot(WALLET, fake(500, 'oops')), (e: ChainError) => e.action === 'fund' && /didn’t arrive/.test(e.message));
  await assert.rejects(friendbot(WALLET, (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch), (e: ChainError) => e.action === 'fund');
});
