import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, Address, Keypair, SorobanDataBuilder, Transaction, nativeToScVal, xdr, type rpc } from '@stellar/stellar-sdk';
import { BN254_P, toSorobanArgs } from '../../shared/approval-proof.js';
import { submitArgs, type Deployment, type SubmitArgs } from '../src/chain.ts';
import {
  BATCH_TIMEOUT, ORDER, REJECTIONS, Stop, approvalLedgerKey, cases, checkOutcome, checkSigned, contractIds, decodeOutcome, failingTx, fileWriter,
  collectRecords, nullifierKey, prepareBatch, prepareReplay, recordedHash, run, saveBatch, sendBatch, sorobanData, withRecords, writeIndex, Pause, type Batch, type CaseName, type Ctx, type Server, type State,
} from '../scripts/evidence.ts';

const sample = JSON.parse(readFileSync(new URL('../../docs/fixtures/approval-proof.sample.json', import.meta.url), 'utf8'));
const args = toSorobanArgs(sample) as SubmitArgs;
const REGISTRY = 'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM';
const VERIFIER = Address.contract(new Uint8Array(32).fill(7)).toString();
const dep: Deployment = { rpcUrl: 'https://rpc.test', networkPassphrase: 'Test SDF Network ; September 2015', registry: REGISTRY, projectId: 'mailmarks', expert: 'https://stellar.expert/explorer/testnet' };
const xdrOf = (v: { toXDR(f: 'base64'): string }) => v.toXDR('base64');

function validData() {
  return new SorobanDataBuilder()
    .setFootprint([approvalLedgerKey(VERIFIER, 'aa'.repeat(32))], [nullifierKey(REGISTRY, args.nullifier), approvalLedgerKey(REGISTRY, args.artifactHash)])
    .setResources(40_000_000, 2000, 300)
    .setResourceFee(1_000_000n)
    .build();
}

test('each rejected case changes exactly one submit argument and names the registry error it must hit', () => {
  const c = cases(args);
  const diff = (b: SubmitArgs) => (Object.keys(args) as (keyof SubmitArgs)[]).filter((k) => JSON.stringify(args[k]) !== JSON.stringify(b[k]));
  assert.deepEqual(diff(c['wrong-project'].args), ['projectId']);
  assert.deepEqual(diff(c['unregistered-key'].args), ['dkimKeyHash']);
  assert.deepEqual(diff(c['wrong-artifact'].args), ['artifactHash']);
  assert.deepEqual(diff(c['tampered-proof'].args), ['proof']);
  assert.deepEqual(diff(c.valid.args), []);
  assert.deepEqual(diff(c.replay.args), []);
  assert.deepEqual([c['wrong-project'].expect, c['unregistered-key'].expect, c['wrong-artifact'].expect, c['tampered-proof'].expect, c.replay.expect], [[3], [5], [8], [8], [6]]);
  // Tampered A stays on the curve: same x, y and p − y sum to p.
  const ta = c['tampered-proof'].args.proof.a;
  assert.equal(ta.slice(0, 64), args.proof.a.slice(0, 64));
  assert.equal(BigInt('0x' + ta.slice(64)) + BigInt('0x' + args.proof.a.slice(64)), BN254_P);
  // The registry checks the nullifier before the proof: these two must run while it is unused.
  assert.ok(ORDER.indexOf('wrong-artifact') < ORDER.indexOf('valid') && ORDER.indexOf('tampered-proof') < ORDER.indexOf('valid'));
  assert.equal(ORDER.at(-1), 'replay');
});

test('a rejected case reuses the valid footprint and resources, adds its own keys once, and authorizes its own arguments', () => {
  const a = cases(args)['wrong-artifact'].args;
  const extra = approvalLedgerKey(REGISTRY, a.artifactHash);
  const dup = nullifierKey(REGISTRY, args.nullifier); // already read-write: must not appear read-only too
  const tx = failingTx(new Account(args.wallet, '1'), REGISTRY, a, validData(), [extra, extra, dup]);
  const d = sorobanData(tx);
  const ro = d.resources.footprint.readOnly.map(xdrOf), rw = d.resources.footprint.readWrite.map(xdrOf);
  assert.equal(ro.length, 2);
  assert.ok(ro.includes(xdrOf(extra)));
  assert.equal(rw.length, 2);
  assert.ok(!ro.includes(xdrOf(dup)));
  assert.equal(d.resources.instructions, 50_000_000);
  assert.equal(d.resourceFee, 1_250_000n);
  assert.equal(BigInt(tx.fee), 100n + 1_250_000n);
  const op = tx.toEnvelope();
  assert.equal(op.type, 'envelopeTypeTx');
  const invoke = (op as any).v1.tx.operations[0].body.invokeHostFunctionOp;
  const [auth] = invoke.auth as xdr.SorobanAuthorizationEntry[];
  assert.equal(auth!.credentials.type, 'sorobanCredentialsSourceAccount');
  const fn = (auth!.rootInvocation.function as any).contractFn;
  assert.equal(String(fn.functionName), 'submit');
  assert.deepEqual(fn.args.map(xdrOf), submitArgs(a).map(xdrOf));
  assert.deepEqual(invoke.hostFunction.invokeContract.args.map(xdrOf), submitArgs(a).map(xdrOf));
});

const errEvent = (contract: string, code: number) => new xdr.DiagnosticEvent({
  inSuccessfulContractCall: false,
  event: new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: new xdr.ContractId(Address.fromString(contract).toBuffer()),
    type: xdr.ContractEventType.diagnostic,
    body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({
      topics: [xdr.ScVal.scvSymbol('error'), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
      data: xdr.ScVal.scvVoid(),
    })),
  }),
});
const result = (ihf: xdr.InvokeHostFunctionResult, ok = false) => new xdr.TransactionResult({
  feeCharged: 1000n,
  result: (ok ? xdr.TransactionResultResult.txSuccess : xdr.TransactionResultResult.txFailed)([xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(ihf))]),
  ext: xdr.TransactionResultExt.v0(),
}).toXDR('base64');
const raw = (status: string, resultXdr: string, events: xdr.DiagnosticEvent[] = []) =>
  ({ status, latestLedger: 9, latestLedgerCloseTime: 0, oldestLedger: 1, oldestLedgerCloseTime: 0, ledger: 8, resultXdr, diagnosticEventsXdr: events.map(xdrOf) }) as unknown as rpc.Api.RawGetTransactionResponse;
const trapped = () => result(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped());

test('the registry error is read from the chain, not from another contract in the call', () => {
  const o = decodeOutcome(raw('FAILED', trapped(), [errEvent(REGISTRY, 3), errEvent(VERIFIER, 1)]), REGISTRY);
  assert.deepEqual(o, { status: 'FAILED', txResult: 'txFailed', opResult: 'invokeHostFunctionTrapped', code: 3 });
  assert.equal(decodeOutcome(raw('FAILED', trapped(), [errEvent(VERIFIER, 1)]), REGISTRY).code, null);
});

test('only the expected registry rejection counts as evidence', () => {
  const c = cases(args)['wrong-project'];
  const o = (opResult: string, code: number | null, status = 'FAILED') => ({ status, txResult: 'txFailed', opResult, code });
  assert.doesNotThrow(() => checkOutcome('wrong-project', c, o('invokeHostFunctionTrapped', 3)));
  assert.throws(() => checkOutcome('wrong-project', c, o('invokeHostFunctionResourceLimitExceeded', null)), Stop);
  assert.throws(() => checkOutcome('wrong-project', c, o('invokeHostFunctionTrapped', null)), /no diagnostic events/);
  assert.throws(() => checkOutcome('wrong-project', c, o('invokeHostFunctionTrapped', 5)), /#5, expected #3/);
  assert.throws(() => checkOutcome('wrong-project', c, o('invokeHostFunctionTrapped', 3, 'SUCCESS')), Stop);
  assert.throws(() => checkOutcome('valid', cases(args).valid, o('invokeHostFunctionTrapped', 3)), /expected SUCCESS/);
});

const DKIM = Address.contract(new Uint8Array(32).fill(9)).toString();
const instanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
  contract: new Address(REGISTRY).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent,
}));
const instanceEntry = () => ({ val: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
  ext: xdr.ExtensionPoint.v0(), contract: new Address(REGISTRY).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent,
  val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
    storage: [new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Config')]), val: nativeToScVal({ verifier: VERIFIER, dkim_registry: DKIM, domain_hash: Buffer.alloc(32), project_id: 'mailmarks' }) })],
  })),
})) });
const okSim = (data = validData()) => ({ id: '1', latestLedger: 9, events: [], _parsed: true, minResourceFee: '1000000', transactionData: new SorobanDataBuilder(data), result: { auth: [], retval: xdr.ScVal.scvVoid() } });
const errSim = (code: number) => ({ id: '1', latestLedger: 9, events: [], _parsed: true, error: `HostError: Error(Contract, #${code})\n\nEvent log:\n...` });
const EXPECT: Record<CaseName, number | null> = { 'wrong-project': 3, 'unregistered-key': 5, 'wrong-artifact': 8, 'tampered-proof': 8, valid: null, replay: 6 };
const hex = (tx: Transaction) => Buffer.from(tx.hash()).toString('hex');

/**
 * A fake testnet that behaves like the registry: each case dry-runs and lands on its own error, the valid submit sets
 * the nullifier and approval, after which the same arguments (the replay) and the proof cases stop at #6.
 */
function chain(a: SubmitArgs, opt: { used?: boolean; codes?: Partial<Record<CaseName, number>>; onChain?: Partial<Record<CaseName, rpc.Api.RawGetTransactionResponse>>; lost?: CaseName } = {}) {
  let used = !!opt.used;
  const sent: CaseName[] = [], events: string[] = [], byHash: Record<string, CaseName> = {}, envs: Record<string, string> = {};
  /** Horizon's view of the wallet's transactions, newest first. */
  const hz: { hash: string; successful: boolean; source_account_sequence: string; envelope_xdr: string }[] = [];
  const all = cases(a);
  const caseOf = (tx: any): CaseName | 'dkim' => {
    const inv = tx.toEnvelope().v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract;
    if (String(inv.functionName) !== 'submit') return 'dkim';
    const got = inv.args.map(xdrOf).join();
    return ORDER.find((n) => submitArgs(all[n].args).map(xdrOf).join() === got)!; // 'valid' for the replay too
  };
  const mine = [xdrOf(nullifierKey(REGISTRY, a.nullifier)), xdrOf(approvalLedgerKey(REGISTRY, a.artifactHash))];
  const server = {
    getAccount: async (id: string) => new Account(id, '1'),
    getLedgerEntries: async (k: xdr.LedgerKey) => ({ latestLedger: 9, entries: xdrOf(k) === xdrOf(instanceKey) ? [instanceEntry()] : used && mine.includes(xdrOf(k)) ? [{}] : [] }),
    simulateTransaction: async (tx: any) => {
      const n = caseOf(tx);
      if (n === 'dkim') return okSim(new SorobanDataBuilder().setReadOnly([approvalLedgerKey(DKIM, 'bb'.repeat(32))]).build());
      const code = opt.codes?.[n] ?? (used && ['valid', 'wrong-artifact', 'tampered-proof'].includes(n) ? 6 : EXPECT[n]);
      return code === null ? okSim() : errSim(code);
    },
    sendTransaction: async (tx: any) => {
      const n = caseOf(tx) as CaseName, name = n === 'valid' && used ? 'replay' : n;
      if (name === 'valid') used = true;
      byHash[hex(tx)] = name;
      envs[hex(tx)] = tx.toXDR();
      hz.unshift({ hash: hex(tx), successful: name === 'valid' && !opt.onChain?.valid, source_account_sequence: tx.sequence, envelope_xdr: tx.toXDR() });
      sent.push(name);
      events.push('send ' + hex(tx));
      return { status: 'PENDING', hash: hex(tx), latestLedger: 9, latestLedgerCloseTime: 0 };
    },
    _getTransaction: async (h: string) => {
      const name = byHash[h];
      if (!name || name === opt.lost) return { status: 'NOT_FOUND' };
      return { ...(opt.onChain?.[name] ?? (name === 'valid'
        ? raw('SUCCESS', result(xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(Buffer.alloc(32)), true))
        : raw('FAILED', trapped(), [errEvent(REGISTRY, EXPECT[name]!)]))), envelopeXdr: envs[h] };
    },
  } as unknown as Server;
  const horizon = async (path: string) => {
    assert.ok(path.startsWith(`/accounts/${a.wallet}/transactions`), path);
    return { _embedded: { records: hz } };
  };
  return { server, sent, events, opt, hz, horizon };
}

const key = Keypair.random();
const { buildApprovalProof } = await import('../../shared/approval-proof.js');
const { publicSignals } = await import('../../shared/encode.js');
/** The sample proof with the wallet set to `key` (the fields, not the SNARK, are what the fake chain checks). */
const fields = { ...sample.fields, wallet: key.publicKey() };
const p = buildApprovalProof({ fields, publicSignals: publicSignals(fields, BigInt(sample.publicSignals[5]), BigInt(sample.publicSignals[6])), proof: { pi_a: [...sample.proof.a, '1'], pi_b: [...sample.proof.b, ['1', '0']], pi_c: [...sample.proof.c, '1'], protocol: 'groth16', curve: 'bn128' }, note: sample.note });
const pa = toSorobanArgs(p) as SubmitArgs;
function ctxFor(c: ReturnType<typeof chain>, extra: Partial<Ctx> = {}) {
  const writes: Record<string, unknown>[] = [];
  const ctx: Ctx = { dep, server: c.server, write: async (_n, rec) => void writes.push(rec), sleep: async () => {}, log: (s) => void c.events.push(s), ...extra };
  return { ctx, writes };
}

test('key-file mode: the four rejections by default, never the valid one unless named; stops write nothing', async () => {
  const c = chain(pa), { ctx, writes } = ctxFor(c);
  await assert.rejects(run(ctx, Keypair.random(), p), /not the wallet the proof names/);
  const recs = await run(ctx, key, p);
  assert.deepEqual(c.sent, REJECTIONS);
  assert.deepEqual(recs.map((r: any) => r.onChainCode), [3, 5, 8, 8]);
  assert.equal(writes.length, 4);

  const res = chain(pa, { onChain: { 'wrong-project': raw('FAILED', result(xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded())) } });
  const r2 = ctxFor(res);
  await assert.rejects(run(r2.ctx, key, p), /ResourceLimitExceeded/);
  assert.deepEqual([res.sent, r2.writes.length], [['wrong-project'], 0]);

  const bad = chain(pa, { codes: { 'wrong-project': 7 } });
  await assert.rejects(run(ctxFor(bad).ctx, key, p), /dry run gave HostError: Error\(Contract, #7\); nothing sent/);
  assert.equal(bad.sent.length, 0);

  const late = chain(pa, { used: true });
  await assert.rejects(run(ctxFor(late).ctx, key, p, ['wrong-artifact']), /must run before the valid approval/);
  await assert.rejects(run(ctxFor(chain(pa)).ctx, key, p, ['replay']), /needs the valid approval first/);
  await assert.rejects(run(ctxFor(late).ctx, key, p, ['replay']), /valid approval in the same run/);
  assert.equal(late.sent.length, 0);

  const both = chain(pa), rb = ctxFor(both);
  assert.deepEqual((await run(rb.ctx, key, p, ['valid', 'replay'])).map((r: any) => r.onChainCode), [null, 6]);
  assert.deepEqual(both.sent, ['valid', 'replay']);
});

test('--simulate sends nothing and skips the replay while the nullifier is unused', async () => {
  const c = chain(pa), { ctx } = ctxFor(c, { simulate: true });
  const out = await run(ctx, key, p, ['wrong-project', 'valid', 'replay']);
  assert.deepEqual(out, [{ case: 'wrong-project', simulated: true, dryRunCode: 3 }, { case: 'valid', simulated: true, dryRunCode: null }]);
  assert.equal(c.sent.length, 0);
  assert.ok(c.events.some((e) => e.startsWith('replay: skipped in --simulate')));
});

test('the hash is logged before the send, and a failed poll is retried as "not yet"', async () => {
  const c = chain(pa), { ctx } = ctxFor(c);
  const get = c.server._getTransaction.bind(c.server);
  let calls = 0;
  c.server._getTransaction = async (h: string) => (calls++ === 0 ? Promise.reject(new Error('503')) : get(h));
  const [rec] = await run(ctx, key, p, ['wrong-project']) as any[];
  assert.equal(calls, 2);
  const i = c.events.indexOf(`wrong-project: sending ${rec.hash}`);
  assert.ok(i >= 0 && i < c.events.indexOf(`send ${rec.hash}`));
});

async function signedBatch() {
  const batch = await prepareBatch(ctxFor(chain(pa)).ctx, p);
  const sign = (x: string, ...ks: Keypair[]) => { const t = new Transaction(x, dep.networkPassphrase); ks.forEach((k) => t.sign(k)); return t.toXDR(); };
  return { batch, sign, signed: batch.unsigned.map((x) => sign(x, key)) };
}

test('prepare: the six in order, consecutive sequence numbers of the wallet, a two-hour time bound; refused once the nullifier is used', async () => {
  const { batch } = await signedBatch();
  assert.deepEqual(batch.cases, ORDER);
  const txs = batch.unsigned.map((x) => new Transaction(x, dep.networkPassphrase));
  assert.deepEqual(txs.map((t) => [t.source, t.sequence]), ORDER.map((_, i) => [key.publicKey(), String(2 + i)]));
  for (const t of txs) assert.ok(Math.abs(Number(t.timeBounds!.maxTime) - Date.now() / 1000 - BATCH_TIMEOUT) < 30);
  await assert.rejects(prepareBatch(ctxFor(chain(pa, { used: true })).ctx, p), /already used/);
});

test('signed file: refused unless each line is its own transaction with exactly one signature by the wallet', async () => {
  const { batch, sign, signed } = await signedBatch();
  const w = key.publicKey(), u = batch.unsigned;
  assert.equal(checkSigned(w, u, signed).length, 6);
  assert.throws(() => checkSigned(w, u, signed.slice(1)), /5 lines, the batch has 6/);
  assert.throws(() => checkSigned(w, u, [signed[1]!, signed[0]!, ...signed.slice(2)]), /line 1 is not the batch's transaction 1/);
  const env = xdr.TransactionEnvelope.fromXDR(u[0]!, 'base64');
  assert.equal(env.type, 'envelopeTypeTx');
  if (env.type === 'envelopeTypeTx') (env.v1.tx as { fee: number }).fee += 1;
  assert.throws(() => checkSigned(w, u, [sign(env.toXDR('base64'), key), ...signed.slice(1)]), /changed or out of order/);
  for (const bad of [u[2]!, sign(u[2]!, Keypair.random()), sign(u[2]!, key, Keypair.random())]) {
    assert.throws(() => checkSigned(w, u, [...signed.slice(0, 2), bad, ...signed.slice(3)]), /line 3 must carry exactly one signature/);
  }
  assert.throws(() => checkSigned(w, u, ['nonsense', ...signed.slice(1)]), /line 1 is not a transaction/);
});

test('send: the batch lands in order, the replay dry-runs to #6 after the valid one; a wrong outcome stops the rest', async () => {
  const { batch, signed } = await signedBatch();
  const c = chain(pa), { ctx, writes } = ctxFor(c);
  const recs = await sendBatch(ctx, p, batch, signed);
  assert.deepEqual(c.sent, ORDER);
  assert.deepEqual(recs.map((r: any) => [r.case, r.dryRunCode, r.onChainCode]), [
    ['wrong-project', 3, 3], ['unregistered-key', 5, 5], ['wrong-artifact', 8, 8], ['tampered-proof', 8, 8], ['valid', null, null], ['replay', 6, 6],
  ]);
  assert.equal(writes.length, 6);
  assert.deepEqual((recs[4] as any).after, { approved: true, nullifierUsed: true });

  const wrong = chain(pa, { onChain: { 'wrong-artifact': raw('FAILED', trapped(), [errEvent(REGISTRY, 5)]) } }), w = ctxFor(wrong);
  await assert.rejects(sendBatch(w.ctx, p, batch, signed), /wrong-artifact: registry error #5, expected #8/);
  assert.deepEqual(wrong.sent, ['wrong-project', 'unregistered-key', 'wrong-artifact']);
  assert.equal(w.writes.length, 2);
});

test('records: a missing Horizon answer or screenshot is written as missing, and the README lists every contract id', async () => {
  const out = mkdtempSync(join(tmpdir(), 'evidence-'));
  await fileWriter(out)('wrong-project', { case: 'wrong-project', registry: REGISTRY, label: 'Wrong project', onChainCode: 3, hash: 'ab'.repeat(32), link: 'x' }, { status: 'FAILED' });
  const read = () => JSON.parse(readFileSync(join(out, 'wrong-project', 'case.json'), 'utf8'));
  // Written at once; the slow records come after the last send.
  assert.deepEqual(read().files, { rpc: 'rpc-getTransaction.json', horizon: 'pending', expert: 'pending' });
  await collectRecords(out, dep, { fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, shot: async () => { throw new Error('no browser'); }, sleep: async () => {} });
  assert.deepEqual(read().files, { rpc: 'rpc-getTransaction.json', horizon: 'missing: Horizon did not answer', expert: 'missing: could not take it (Error: no browser)' });
  const CONSUMER = Address.contract(new Uint8Array(32).fill(3)).toString();
  const ids = contractIds({ registry: REGISTRY, consumer: CONSUMER, rpcUrl: 'https://rpc.test' }, { verifier: VERIFIER, dkimRegistry: DKIM });
  assert.deepEqual(Object.values(ids).sort(), [REGISTRY, CONSUMER, VERIFIER, DKIM].sort());
  // docs/deployments/testnet.json keeps the four under `contracts`: each listed once, the consumer included.
  const nested = contractIds({ registry: REGISTRY, contracts: { verifier: VERIFIER, dkimRegistry: DKIM, registry: REGISTRY, consumer: CONSUMER } }, { verifier: VERIFIER, dkimRegistry: DKIM });
  assert.deepEqual(nested, { registry: REGISTRY, verifier: VERIFIER, dkimRegistry: DKIM, consumer: CONSUMER });
  writeIndex(out, ids);
  const readme = readFileSync(join(out, 'README.md'), 'utf8');
  for (const id of [REGISTRY, CONSUMER, VERIFIER, DKIM]) assert.ok(readme.includes(id), id);
  assert.ok(readme.includes('| Wrong project | #3 |'));
});

test('send: a run that stopped after sending goes on where it stopped, recording what landed without resending it', async () => {
  const { batch, signed } = await signedBatch();
  const c = chain(pa, { lost: 'replay' }), { ctx, writes } = ctxFor(c);
  await assert.rejects(sendBatch(ctx, p, batch, signed), /replay: \w+ not confirmed in 2 minutes; with --signed, running it again records it/);
  assert.equal(writes.length, 5);
  c.opt.lost = undefined; // it landed after all
  const again = await sendBatch(ctx, p, batch, signed);
  assert.deepEqual(c.sent, ORDER); // each sent once
  assert.deepEqual(again.map((r: any) => [r.case, r.onChainCode, r.before]), ORDER.map((n) => [n, EXPECT[n], null]));
  assert.ok(c.events.some((e) => e.startsWith('valid: ') && e.endsWith('is already on chain, recording it')));

  // A busy RPC is asked again, not a stop.
  const busy = chain(pa), b = ctxFor(busy);
  const send = busy.server.sendTransaction.bind(busy.server);
  let tries = 0;
  busy.server.sendTransaction = (async (tx: Transaction) => (tries++ === 0 ? { status: 'TRY_AGAIN_LATER', hash: hex(tx), latestLedger: 9, latestLedgerCloseTime: 0 } : send(tx))) as Server['sendTransaction'];
  await sendBatch(b.ctx, p, batch, signed);
  assert.deepEqual(busy.sent, ORDER);
});

test('send: refused when the proof given does not hold the arguments the signed batch sends', async () => {
  const { batch, signed } = await signedBatch();
  const other = buildApprovalProof({ fields, publicSignals: publicSignals(fields, BigInt(sample.publicSignals[5]) + 1n, BigInt(sample.publicSignals[6])), proof: { pi_a: [...sample.proof.a, '1'], pi_b: [...sample.proof.b, ['1', '0']], pi_c: [...sample.proof.c, '1'], protocol: 'groth16', curve: 'bn128' }, note: sample.note });
  const c = chain(pa);
  await assert.rejects(sendBatch(ctxFor(c).ctx, other, batch, signed), /line 1 \(wrong-project\) does not submit this case to this registry from the proof's wallet; nothing sent/);
  assert.equal(c.sent.length, 0);
});

test('send and resume refuse to mix two approval registries or proofs', async () => {
  const { batch, signed } = await signedBatch();
  const c = chain(pa);
  const otherDep = { ...dep, registry: VERIFIER };
  await assert.rejects(sendBatch(ctxFor(c, { dep: otherDep }).ctx, p, batch, signed), /line 1 .* does not submit this case to this registry/);
  assert.deepEqual(c.sent, []);

  const out = mkdtempSync(join(tmpdir(), 'evidence-'));
  const name = 'wrong-project';
  const record = { case: name, registry: REGISTRY, projectId: dep.projectId, hash: 'ab'.repeat(32), arguments: cases(pa)[name].args };
  await fileWriter(out)(name, record, { status: 'FAILED' });
  assert.equal(recordedHash(out, dep, pa)(name), record.hash);
  assert.throws(() => recordedHash(out, otherDep, pa)(name), /belongs to another registry/);
  assert.throws(() => recordedHash(out, dep, { ...pa, artifactHash: 'bb'.repeat(32) })(name), /belongs to another proof/);
  assert.throws(() => writeIndex(out, { registry: VERIFIER }), /belongs to another registry/);
});

test("key-file mode: wrong-project runs when no valid call simulates (the registry's instance and code as footprint); nothing else does", async () => {
  const c = chain(pa, { codes: { valid: 8 } }), { ctx } = ctxFor(c);
  const [rec] = (await run(ctx, key, p, ['wrong-project'])) as any[];
  assert.deepEqual([c.sent, rec.onChainCode], [['wrong-project'], 3]);
  await assert.rejects(run(ctx, key, p, ['wrong-project', 'unregistered-key']), /does not simulate \(HostError: Error\(Contract, #8\)\); only wrong-project can run without it/);
  assert.equal(c.sent.length, 1);
});

test('send: a rerun after a stop on the replay keeps the records already written byte for byte', async () => {
  const { batch, signed } = await signedBatch();
  const out = mkdtempSync(join(tmpdir(), 'evidence-'));
  const c = chain(pa, { lost: 'replay' }), { ctx } = ctxFor(c, { write: fileWriter(out), recorded: recordedHash(out, dep, pa) });
  await assert.rejects(sendBatch(ctx, p, batch, signed), /replay: \w+ not confirmed/);
  const done = ORDER.filter((n) => n !== 'replay'), bytes = () => done.map((n) => readFileSync(join(out, n, 'case.json'), 'utf8'));
  const first = bytes();
  c.opt.lost = undefined;
  const again = await sendBatch(ctx, p, batch, signed);
  assert.deepEqual(bytes(), first);
  assert.deepEqual(again.map((r: any) => r.kept ?? false), [...done.map(() => true), false]);
  const replay = JSON.parse(readFileSync(join(out, 'replay', 'case.json'), 'utf8'));
  assert.deepEqual([replay.onChainCode, replay.before, typeof replay.resumed], [6, null, 'string']);
  assert.deepEqual(c.sent, ORDER);
});

test('records: an error in the index step after a stop is logged and the stop stays the result', async () => {
  const out = mkdtempSync(join(tmpdir(), 'evidence-'));
  const c = chain(pa), { ctx } = ctxFor(c);
  c.server.getLedgerEntries = (async () => { throw new Error('rpc down'); }) as Server['getLedgerEntries'];
  const io = { fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, shot: async () => { throw new Error('no browser'); }, sleep: async () => {} };
  const stop = new Stop('replay: not confirmed');
  await assert.rejects(withRecords(ctx, out, { registry: REGISTRY }, async () => { throw stop; }, io), (e) => e === stop);
  assert.ok(c.events.some((e) => e.startsWith('records index not written (Error: rpc down)')));
});

test('replay-only: after the valid approval, one replay line from the footprint kept at prepare time, dry-run to #6', async () => {
  const { batch, sign } = await signedBatch();
  assert.equal(batch.validData, sorobanData(new Transaction(batch.unsigned[ORDER.indexOf('valid')]!, dep.networkPassphrase)).toXDR('base64'));
  const validRec = { recorded: (n: string) => (n === 'valid' ? 'ab'.repeat(32) : undefined) };
  // The valid approval must be recorded first: a replay-only send never records it.
  await assert.rejects(prepareReplay(ctxFor(chain(pa, { used: true })).ctx, p, batch), /valid has no record yet: first run the original --signed command again \(--batch with its batch\.json\), which records the valid approval; then --replay; nothing built/);
  await assert.rejects(prepareReplay(ctxFor(chain(pa), validRec).ctx, p, batch), /valid approval has not landed/);
  const c = chain(pa, { used: true }), { ctx } = ctxFor(c, validRec), sims: string[] = [];
  const sim = c.server.simulateTransaction.bind(c.server);
  c.server.simulateTransaction = (async (tx: Transaction) => { sims.push(hex(tx)); return sim(tx); }) as Server['simulateTransaction'];
  const r = await prepareReplay(ctx, p, batch);
  const tx = new Transaction(r.unsigned[0]!, dep.networkPassphrase);
  assert.deepEqual(r.cases, ['replay']);
  assert.deepEqual(sims, [hex(tx)]); // its own dry run only: the valid call is not simulated again
  // The dry run must give #6, else no line is written.
  await assert.rejects(prepareReplay(ctxFor(chain(pa, { used: true, codes: { valid: 7 } }), validRec).ctx, p, batch), /dry run gave HostError: Error\(Contract, #7\)/);
  const fp = (d: xdr.SorobanTransactionData) => [d.resources.footprint.readOnly.map(xdrOf), d.resources.footprint.readWrite.map(xdrOf)];
  assert.deepEqual(fp(sorobanData(tx)), fp(xdr.SorobanTransactionData.fromXDR(batch.validData!, 'base64')));
  assert.ok(Math.abs(Number(tx.timeBounds!.maxTime) - Date.now() / 1000 - BATCH_TIMEOUT) < 30);
  const recs = await sendBatch(ctx, p, r, [sign(r.unsigned[0]!, key)]);
  assert.deepEqual([c.sent, recs.map((x: any) => x.onChainCode)], [['replay'], [6]]);
});

const sign1 = (x: string) => { const t = new Transaction(x, dep.networkPassphrase); t.sign(key); return t.toXDR(); };
async function pageBatch() {
  const batch = await prepareBatch(ctxFor(chain(pa)).ctx, p, true);
  return { batch, signed: batch.unsigned.map(sign1) };
}
/** The page's valid transaction at `seq`, with one read-only key of its own so its footprint can be told apart. */
const PAGE_KEY = approvalLedgerKey(VERIFIER, 'cc'.repeat(32));
function pageTx(batch: Batch, seq: string, a: SubmitArgs = pa) {
  const tx = failingTx(new Account(key.publicKey(), String(BigInt(seq) - 1n)), REGISTRY, a, xdr.SorobanTransactionData.fromXDR(batch.validData!, 'base64'), [PAGE_KEY]);
  tx.sign(key);
  return tx;
}
function memo() { let s: State | undefined; return { get: () => s, set: (x: State) => void (s = x) }; }
/** A page-valid run on a fake chain writing its records to a folder. */
function pageRun(opt: Parameters<typeof chain>[1] = {}) {
  const out = mkdtempSync(join(tmpdir(), 'evidence-')), c = chain(pa, opt), before = memo();
  const { ctx } = ctxFor(c, { write: fileWriter(out), recorded: recordedHash(out, dep, pa), horizon: c.horizon, pageBefore: before });
  const read = (n: CaseName) => readFileSync(join(out, n, 'case.json'), 'utf8');
  return { out, c, ctx, before, read, has: (n: CaseName) => existsSync(join(out, n, 'case.json')) };
}

test('page-valid prepare: five lines, the four rejections, one sequence number kept free for the page, then the replay', async () => {
  const { batch } = await pageBatch();
  assert.deepEqual(batch.cases, [...REJECTIONS, 'replay']);
  assert.deepEqual(batch.unsigned.map((x) => new Transaction(x, dep.networkPassphrase).sequence), ['2', '3', '4', '5', '7']);
  assert.equal(batch.pageSeq, '6');
  assert.ok(batch.validData);
});

test('page-valid send: the four land, the registry state is kept, and the run pauses for the page without the replay', async () => {
  const { batch, signed } = await pageBatch();
  const r = pageRun();
  await assert.rejects(sendBatch(r.ctx, p, batch, signed), (e: unknown) => e instanceof Pause && !e.replay
    && /now record it on the page \(sequence number 6 is kept/i.test(e.message) && /npm run preview --prefix web/.test(e.message) && /http:\/\/localhost:4173/.test(e.message) && !/ssh|scp/.test(e.message));
  assert.deepEqual(r.c.sent, REJECTIONS);
  assert.deepEqual(REJECTIONS.map(r.has), [true, true, true, true]);
  assert.deepEqual(r.before.get(), { approved: false, nullifierUsed: false });
});

test("page-valid: a found transaction that is not this proof's successful submit is refused and nothing is recorded", async () => {
  const { batch, signed } = await pageBatch();
  // Another call of the wallet took the kept sequence number.
  const a = pageRun();
  await assert.rejects(sendBatch(a.ctx, p, batch, signed), Pause);
  const other = pageTx(batch, '6', cases(pa)['wrong-project'].args);
  a.c.hz.unshift({ hash: hex(other), successful: false, source_account_sequence: '6', envelope_xdr: other.toXDR() });
  await assert.rejects(sendBatch(a.ctx, p, batch, signed), /sequence number 6 \(\w+\) is not this proof's submit to this registry; nothing recorded/);
  // This proof's submit at the kept number, but it failed on chain.
  const b = pageRun({ onChain: { valid: raw('FAILED', trapped(), [errEvent(REGISTRY, 8)]) } });
  await assert.rejects(sendBatch(b.ctx, p, batch, signed), Pause);
  await b.c.server.sendTransaction(pageTx(batch, '6'));
  await assert.rejects(sendBatch(b.ctx, p, batch, signed), /did not succeed \(FAILED, txFailed\/invokeHostFunctionTrapped\); nothing recorded/);
  for (const r of [a, b]) assert.deepEqual([r.has('valid'), r.has('replay'), r.c.sent.filter((n) => n === 'replay')], [false, false, []]);
});

test("page-valid rerun: the four kept byte for byte, the page's transaction recorded with before and after, then the signed replay sent", async () => {
  const { batch, signed } = await pageBatch();
  const r = pageRun();
  await assert.rejects(sendBatch(r.ctx, p, batch, signed), Pause);
  const first = REJECTIONS.map(r.read);
  const page = pageTx(batch, '6');
  await r.c.server.sendTransaction(page); // the owner records it on the page
  const recs = await sendBatch(r.ctx, p, batch, signed);
  assert.deepEqual(REJECTIONS.map(r.read), first);
  assert.deepEqual(recs.map((x: any) => [x.case, x.kept ?? false]), [...REJECTIONS.map((n) => [n, true]), ['valid', false], ['replay', false]]);
  const v = JSON.parse(r.read('valid'));
  assert.deepEqual([v.hash, v.sequence, v.before, v.after, v.onChainCode, v.resumed], [hex(page), '6', { approved: false, nullifierUsed: false }, { approved: true, nullifierUsed: true }, null, undefined]);
  const replay = JSON.parse(r.read('replay'));
  assert.deepEqual([replay.hash, replay.onChainCode], [hex(new Transaction(signed[4]!, dep.networkPassphrase)), 6]);
  assert.deepEqual(r.c.sent, [...REJECTIONS, 'valid', 'replay']);
});

test("page-valid rerun: the page took another sequence number, so a new replay line is built from its footprint, not a simulation of the valid call", async () => {
  const { batch, signed } = await pageBatch();
  const r = pageRun();
  await assert.rejects(sendBatch(r.ctx, p, batch, signed), Pause);
  const page = pageTx(batch, '7'); // something else used 6
  await r.c.server.sendTransaction(page);
  const sims: string[] = [], sim = r.c.server.simulateTransaction.bind(r.c.server);
  r.c.server.simulateTransaction = (async (tx: Transaction) => { sims.push(hex(tx)); return sim(tx); }) as Server['simulateTransaction'];
  let paused: Pause | undefined;
  await assert.rejects(sendBatch(r.ctx, p, batch, signed), (e: unknown) => (paused = e as Pause) instanceof Pause && !!paused.replay);
  assert.equal(JSON.parse(r.read('valid')).hash, hex(page));
  const line = new Transaction(paused!.replay!.unsigned[0]!, dep.networkPassphrase);
  assert.deepEqual(paused!.replay!.cases, ['replay']);
  assert.deepEqual(sims, [hex(line)]); // its own dry run only
  const ro = sorobanData(line).resources.footprint.readOnly.map(xdrOf);
  assert.ok(ro.includes(xdrOf(PAGE_KEY)), "the page transaction's footprint");
  assert.ok(!r.c.sent.includes('replay'));
  const recs = await sendBatch(r.ctx, p, paused!.replay!, [sign1(paused!.replay!.unsigned[0]!)]);
  assert.deepEqual(recs.map((x: any) => [x.case, x.onChainCode]), [['replay', 6]]);
});

test('batch guards: records that cannot exist with the nullifier unused stop prepare, with or without the page', async () => {
  const only = (...names: string[]) => (n: string) => (names.includes(n) ? 'ab'.repeat(32) : undefined);
  const all = only(...ORDER), four = only('wrong-project', 'unregistered-key', 'wrong-artifact', 'tampered-proof');
  const other = (what: string) => (e: Error) => e instanceof Stop && e.message.startsWith(what) && /nullifier is unused on this registry.*Check that --deployment and --out belong to the same evidence run; nothing built$/.test(e.message);
  for (const page of [false, true]) {
    await assert.rejects(prepareBatch(ctxFor(chain(pa), { recorded: all }).ctx, p, page), other('valid and replay already have records'));
    await assert.rejects(prepareBatch(ctxFor(chain(pa), { recorded: only('valid') }).ctx, p, page), other('valid already has a record'));
    await assert.rejects(prepareBatch(ctxFor(chain(pa), { recorded: only('replay') }).ctx, p, page), other('replay already has a record'));
  }
  // The four rejections recorded, then the page: a batch of the replay alone, after the sequence number kept for it.
  const b = await prepareBatch(ctxFor(chain(pa), { recorded: four }).ctx, p, true);
  assert.deepEqual(b.cases, ['replay']);
  assert.ok(b.pageSeq);
  assert.equal(new Transaction(b.unsigned[0]!, dep.networkPassphrase).sequence, String(BigInt(b.pageSeq!) + 1n));
});

test('batch guards: with the nullifier used, the message follows what is still missing', async () => {
  const only = (...names: string[]) => (n: string) => (names.includes(n) ? 'ab'.repeat(32) : undefined);
  const used = (recorded: (n: string) => string | undefined, page = false) => prepareBatch(ctxFor(chain(pa, { used: true }), { recorded }).ctx, p, page);
  for (const page of [false, true]) await assert.rejects(used(only(...ORDER), page), /: every case already has a record: there is nothing to prepare$/);
  await assert.rejects(used(only('wrong-project', 'unregistered-key', 'wrong-artifact', 'tampered-proof', 'valid')), /only the replay is left: .*--replay for a new one/);
  await assert.rejects(used(only('wrong-project', 'unregistered-key', 'wrong-artifact', 'tampered-proof'), true), /valid has no record: run the same --signed command again \(it finds the valid transaction, the page's too/);
  await assert.rejects(used(only('wrong-project', 'unregistered-key', 'tampered-proof', 'valid', 'replay')), /nullifier is already used and wrong-artifact has no record: if a transaction reached the chain, the same --signed command records it from its hash; if not, it can no longer be recorded, because the four rejections must come before the valid approval \(evidence order\); nothing built/);
  await assert.rejects(used(only('valid')), /and wrong-project, unregistered-key, wrong-artifact, tampered-proof have no record: if a transaction reached the chain/);
});

test('batch guards: an RPC that cannot be read stops prepare with a plain message', async () => {
  const c = chain(pa), { ctx } = ctxFor(c, { recorded: () => 'ab'.repeat(32) });
  c.server.getLedgerEntries = (async () => { throw new Error('rpc down\nstack'); }) as Server['getLedgerEntries'];
  await assert.rejects(prepareBatch(ctx, p), (e: Error) => e instanceof Stop && e.message === 'the registry state could not be read: Error: rpc down');
});

test('batch guards: prepare builds only the cases with no record; batch.json is replaced only with --force; --replay refuses a recorded or landed replay', async () => {
  const some = await prepareBatch(ctxFor(chain(pa), { recorded: (n) => (n === 'wrong-project' ? 'ab'.repeat(32) : undefined) }).ctx, p);
  assert.deepEqual(some.cases, ORDER.filter((n) => n !== 'wrong-project'));
  assert.deepEqual(some.unsigned.map((x) => new Transaction(x, dep.networkPassphrase).sequence), ['2', '3', '4', '5', '6']);

  const dir = mkdtempSync(join(tmpdir(), 'batch-'));
  saveBatch(dir, some);
  writeFileSync(join(dir, 'page-before.json'), '{}');
  const kept = readFileSync(join(dir, 'batch.json'), 'utf8');
  assert.throws(() => saveBatch(dir, { ...some, unsigned: [] }), /batch\.json exists \(its lines may already be signed or sent\); --force replaces it/);
  assert.equal(readFileSync(join(dir, 'batch.json'), 'utf8'), kept);
  saveBatch(dir, { ...some, unsigned: ['x'] }, true);
  assert.deepEqual([JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')).unsigned, existsSync(join(dir, 'page-before.json'))], [['x'], false]);

  const { batch, signed } = await signedBatch();
  await assert.rejects(prepareReplay(ctxFor(chain(pa, { used: true }), { recorded: (n) => (n === 'replay' ? 'ab'.repeat(32) : undefined) }).ctx, p, batch), /the replay already has a record; nothing built/);
  const c = chain(pa), { ctx } = ctxFor(c);
  await sendBatch(ctx, p, batch, signed);
  await assert.rejects(prepareReplay({ ...ctx, recorded: (n) => (n === 'valid' ? 'ab'.repeat(32) : undefined) }, p, batch), /the batch's replay line \w+ landed: run the --signed command again to record it; nothing built/);
});

test('records: a state read that fails after a send names the transaction on chain and the --signed rerun', async () => {
  const c = chain(pa), { ctx, writes } = ctxFor(c);
  const get = c.server.getLedgerEntries.bind(c.server);
  c.server.getLedgerEntries = (async (...k: Parameters<Server['getLedgerEntries']>) => {
    if (c.sent.length) throw new Error('rpc down');
    return get(...k);
  }) as Server['getLedgerEntries'];
  await assert.rejects(run(ctx, key, p), (e: Error) => e instanceof Stop && /^wrong-project: [0-9a-f]{64} is on chain, but the registry state could not be read: Error: rpc down; running the same --signed command again completes its record$/.test(e.message));
  assert.equal(writes.length, 0);
});

test('records: "run again" is advised only for a --signed run', async () => {
  const out = mkdtempSync(join(tmpdir(), 'evidence-'));
  const io = { fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, shot: async () => { throw new Error('no browser'); }, sleep: async () => {} };
  for (const signed of [false, true]) {
    const c = chain(pa), { ctx } = ctxFor(c);
    c.server.getLedgerEntries = (async () => { throw new Error('rpc down'); }) as Server['getLedgerEntries'];
    await withRecords(ctx, out, { registry: REGISTRY }, async () => {}, io, signed);
    const line = c.events.find((e) => e.startsWith('records index not written'))!;
    assert.equal(/again/.test(line), signed, line);
  }
});
