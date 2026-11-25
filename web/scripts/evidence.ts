// Delivery evidence (docs/scope.md, deliverable 3): four REAL rejected transactions, the one valid approval and the
// replay on testnet, all from the one approval-proof.json, and each transaction's full record copied into
// docs/evidence/ (explorer links die in the testnet reset).
//
// A failing call has no simulation to assemble from, so each rejected case reuses the valid call's simulated footprint
// and resources (plus the keys only its failing path reads, plus a margin) with its own arguments and source-account
// auth. Each transaction is dry-run right before it is sent and must give its expected code; a case that fails on
// chain in any other way than its expected registry error stops the run and is never recorded as evidence.
//
// Order matters: the registry checks the email's nullifier before the proof, so the four argument cases run while the
// nullifier is unused, then the valid approval, then the replay.
//
// The proof's wallet must authorize every submit. Two ways to sign:
//   owner's key elsewhere (stellar-cli on their machine): --sign external [--batch <dir>] writes the six unsigned, one per
//     line, to <dir>/unsigned.txt; he signs every line; --sign external --signed <file> checks them and sends in order.
//     Run again after a stop, it keeps what is recorded and records what landed. A replay line whose bound ran out:
//     --sign external --replay builds a new one from the valid call's data in batch.json; --replay --signed sends it.
//     Only the cases with no record are prepared, and an existing batch.json is replaced only with --force.
//   the valid one through the page (owner's wallet, README steps 4-5): --sign external --page-valid prepares five
//     lines, the four rejections, a sequence number kept free for the page, then the replay. --signed sends the four,
//     keeps the registry state it reads next to batch.json and pauses for the page. Run again, it finds the page's
//     transaction itself (Horizon, the wallet's transactions), records it as `valid` once the chain shows it is this
//     proof's successful submit, then sends the replay line; if the page took another sequence number, it writes a new
//     replay line from the page transaction's footprint for the owner to sign (--replay --signed sends it).
//   a key file here (a testnet key of your own, e.g. for a diagnostic check):
//     --secret-file <file> [--only a,b]   (default: the four rejections; 'valid' only when named)
// Run: npm run evidence --prefix web -- --proof <approval-proof.json> (--sign external [--replay] [--signed <file>] | --secret-file <file>)
//        [--deployment ../docs/deployments/testnet.json] [--out ../docs/evidence] [--simulate]
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import {
  Account, Address, Contract, Keypair, Operation, SorobanDataBuilder, Transaction, TransactionBuilder, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';
import { BN254_P, parseApprovalProof, toSorobanArgs } from '../../shared/approval-proof.js';
import { bytesToHex, hexToBytes } from '../../shared/encode.js';
import { TESTNET, approvalKey, parseDeployment, submitArgs, type Deployment, type SubmitArgs } from '../src/chain.ts';

export const ORDER = ['wrong-project', 'unregistered-key', 'wrong-artifact', 'tampered-proof', 'valid', 'replay'] as const;
export type CaseName = (typeof ORDER)[number];
export interface Case { args: SubmitArgs; expect: number[]; label: string }

export const REJECTIONS: CaseName[] = ['wrong-project', 'unregistered-key', 'wrong-artifact', 'tampered-proof'];
export const HORIZON = 'https://horizon-testnet.stellar.org';
const MARGIN = 1.25;
/** Time bound of a batch the owner signs elsewhere: enough to copy, sign and copy back. */
export const BATCH_TIMEOUT = 2 * 60 * 60;

/** Last byte XOR 1: still canonical (below r) for any real hash, and different. */
const flip = (hex: string) => hex.slice(0, -2) + (parseInt(hex.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
/** -P for a G1 point given as x‖y (32-byte big-endian each): y becomes p − y. */
export const negateG1 = (hex: string) => hex.slice(0, 64) + (BN254_P - BigInt('0x' + hex.slice(64))).toString(16).padStart(64, '0');

/** The six cases from the one real proof. Expected codes: contracts/approval-registry/src/lib.rs `Error`. */
export function cases(a: SubmitArgs): Record<CaseName, Case> {
  return {
    'wrong-project': { args: { ...a, projectId: a.projectId === 'other-project' ? 'another-project' : 'other-project' }, expect: [3], label: 'Wrong project (WrongProject, #3)' },
    'unregistered-key': { args: { ...a, dkimKeyHash: flip(a.dkimKeyHash) }, expect: [5], label: 'Unregistered DKIM key (UnknownKey, #5)' },
    'wrong-artifact': { args: { ...a, artifactHash: flip(a.artifactHash) }, expect: [8], label: 'Wrong artifact (InvalidProof, #8)' },
    // A negated: still a curve point, so the pairing runs and fails (a flipped byte would be MalformedProof #9 instead).
    'tampered-proof': { args: { ...a, proof: { ...a.proof, a: negateG1(a.proof.a) } }, expect: [8], label: 'Tampered proof (InvalidProof, #8)' },
    valid: { args: a, expect: [], label: 'Valid approval' },
    replay: { args: a, expect: [6], label: 'Replay of the same email (NullifierUsed, #6)' },
  };
}

const persistentKey = (contract: string, key: xdr.ScVal) =>
  xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Address(contract).toScAddress(), key, durability: xdr.ContractDataDurability.persistent,
  }));
export const nullifierKey = (registry: string, hex: string) =>
  persistentKey(registry, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Nullifier'), xdr.ScVal.scvBytes(hexToBytes(hex))]));
export const approvalLedgerKey = (registry: string, hex: string) => persistentKey(registry, approvalKey(hex));

/** `require_auth` of the source account for exactly this call (the valid call's auth would not match other arguments). */
export function sourceAuth(contract: string, fn: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(), functionName: fn, args,
      })),
      subInvocations: [],
    }),
  });
}

const keyId = (k: xdr.LedgerKey) => k.toXDR('base64');

/** The rejected case's transaction: the valid call's resources and footprint plus `extra` read-only keys, with margin. */
export function failingTx(source: Account, registry: string, args: SubmitArgs, valid: xdr.SorobanTransactionData, extra: xdr.LedgerKey[], timeout = 300): Transaction {
  const fnArgs = submitArgs(args);
  const b = new SorobanDataBuilder(valid);
  const rw = new Set(b.getReadWrite().map(keyId));
  const ro = new Map<string, xdr.LedgerKey>();
  for (const k of [...b.getReadOnly(), ...extra]) if (!rw.has(keyId(k))) ro.set(keyId(k), k);
  const r = valid.resources;
  const fee = BigInt(Math.ceil(Number(valid.resourceFee) * MARGIN));
  const data = b.setReadOnly([...ro.values()])
    .setResources(Math.ceil(r.instructions * MARGIN), r.diskReadBytes + 1024 * extra.length, r.writeBytes)
    .setResourceFee(fee)
    .build();
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: registry, function: 'submit', args: fnArgs, auth: [sourceAuth(registry, 'submit', fnArgs)] }))
    .setSorobanData(data)
    .setTimeout(timeout)
    .build();
}

export interface Outcome { status: string; txResult: string; opResult: string | null; code: number | null }

/** The transaction's on-chain result and the registry's own error code from the diagnostic events (null if absent). */
export function decodeOutcome(raw: rpc.Api.RawGetTransactionResponse, registry: string): Outcome {
  const res = raw.resultXdr ? xdr.TransactionResult.fromXDR(raw.resultXdr, 'base64') : undefined;
  const r = res?.result;
  const op = r && (r.type === 'txFailed' || r.type === 'txSuccess') ? r.results[0] : undefined;
  const tr = op?.type === 'opInner' && op.tr.type === 'invokeHostFunction' ? op.tr.invokeHostFunctionResult : undefined;
  const events: xdr.DiagnosticEvent[] = (raw.diagnosticEventsXdr ?? []).map((e) => xdr.DiagnosticEvent.fromXDR(e, 'base64'));
  if (raw.resultMetaXdr) {
    const meta = xdr.TransactionMeta.fromXDR(raw.resultMetaXdr, 'base64');
    if (meta.type === 'v4') events.push(...meta.v4.diagnosticEvents);
  }
  let code: number | null = null;
  for (const d of events) {
    const id = d.event.contractId;
    if (!id || Address.contract(id.value).toString() !== registry) continue;
    for (const t of d.event.body.v0.topics) {
      if (t.type === 'scvError' && t.error.type === 'sceContract') code = t.error.contractCode;
    }
  }
  return { status: raw.status, txResult: r?.type ?? 'none', opResult: tr?.type ?? op?.type ?? null, code };
}

export class Stop extends Error {}
/** Not a failure: the run waits for the owner (the page step, or a new replay line to sign, in `replay`). */
export class Pause extends Stop {
  readonly replay?: Batch;
  constructor(message: string, replay?: Batch) { super(message); this.replay = replay; }
}

/** Evidence only if the chain says exactly what the case claims; anything else stops the run. */
export function checkOutcome(name: CaseName, c: Case, o: Outcome): void {
  if (name === 'valid') {
    if (o.status !== 'SUCCESS') throw new Stop(`valid: expected SUCCESS, got ${o.status} (${o.txResult}/${o.opResult})`);
    return;
  }
  if (o.status !== 'FAILED' || o.opResult !== 'invokeHostFunctionTrapped') {
    throw new Stop(`${name}: expected a contract rejection, got ${o.status} (${o.txResult}/${o.opResult}); not evidence`);
  }
  if (o.code === null) throw new Stop(`${name}: the RPC returned no diagnostic events, so the registry's error cannot be read from the chain; not evidence`);
  if (!c.expect.includes(o.code)) throw new Stop(`${name}: registry error #${o.code}, expected ${c.expect.map((n) => '#' + n).join(' or ')}; not evidence`);
}

/** The first line of a simulation error, `HostError: Error(Contract, #N)`, as N. */
export const simCode = (text: string) => {
  const m = /^HostError: Error\(Contract, #(\d+)\)/.exec(text.trimStart().split('\n')[0] ?? '');
  return m ? Number(m[1]) : null;
};

/** What the RPC calls of a run need; a real rpc.Server fits, tests pass a fake. */
export type Server = Pick<rpc.Server, 'simulateTransaction' | 'sendTransaction' | '_getTransaction' | 'getAccount' | 'getLedgerEntries'>;

export interface Ctx {
  dep: Deployment;
  server: Server;
  write: (name: CaseName, rec: Record<string, unknown>, raw: unknown) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** The hash a case's record already holds, if any: a resumed run keeps that record as it is. */
  recorded?: (name: CaseName) => string | undefined;
  simulate?: boolean;
  log?: (s: string) => void;
  /** A Horizon GET (path after the host) as parsed JSON: how the page's transaction is found. */
  horizon?: (path: string) => Promise<unknown>;
  /** The registry state read after the four rejections, kept next to batch.json: the page transaction's `before`. */
  pageBefore?: { get(): State | undefined; set(s: State): void };
}

async function exists(ctx: Ctx, key: xdr.LedgerKey) {
  return (await ctx.server.getLedgerEntries(key)).entries.length > 0;
}

export const instanceKey = (registry: string) => xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
  contract: new Address(registry).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent,
}));

/** The registry's fixed configuration, from its instance storage (it has no getter). */
export async function registryConfig(ctx: Ctx): Promise<{ verifier: string; dkimRegistry: string; domainHash: string }> {
  const e = (await ctx.server.getLedgerEntries(instanceKey(ctx.dep.registry))).entries[0];
  if (!e || e.val.type !== 'contractData') throw new Stop('registry instance not found');
  const inst = e.val.value.val;
  const storage = inst.type === 'scvContractInstance' ? inst.instance.storage ?? [] : [];
  const isConfig = (k: xdr.ScVal) => k.type === 'scvVec' && k.vec?.[0]?.type === 'scvSymbol' && String(k.vec[0].sym) === 'Config';
  const cfg = storage.find((m) => isConfig(m.key));
  if (!cfg) throw new Stop('registry Config not found');
  const v = scValToNative(cfg.val) as { verifier: string; dkim_registry: string; domain_hash: Uint8Array };
  return { verifier: v.verifier, dkimRegistry: v.dkim_registry, domainHash: bytesToHex(v.domain_hash) };
}

/** Every contract id for the README: the deployment file's (its `contracts` too), plus the verifier and DKIM registry the registry names. */
export function contractIds(depFile: Record<string, unknown>, cfg: { verifier: string; dkimRegistry: string }): Record<string, string> {
  const ids: Record<string, string> = {};
  const nested = typeof depFile.contracts === 'object' && depFile.contracts !== null ? Object.entries(depFile.contracts) : [];
  for (const [k, v] of [...Object.entries(depFile), ...nested]) {
    if (typeof v === 'string' && /^C[A-Z2-7]{55}$/.test(v) && !Object.values(ids).includes(v)) ids[k] = v;
  }
  const have = new Set(Object.values(ids));
  if (!have.has(cfg.verifier)) ids['verifier (from the registry Config)'] = cfg.verifier;
  if (!have.has(cfg.dkimRegistry)) ids['DKIM registry (from the registry Config)'] = cfg.dkimRegistry;
  return ids;
}

const probe = () => new Account(Keypair.random().publicKey(), '0');

/** Ledger keys read by `is_key_hash_valid(domain, hash)` on the DKIM registry: what the unregistered-key case adds. */
async function dkimReadKeys(ctx: Ctx, hash: string): Promise<xdr.LedgerKey[]> {
  const { dkimRegistry, domainHash } = await registryConfig(ctx);
  const tx = new TransactionBuilder(probe(), { fee: '100', networkPassphrase: TESTNET })
    .addOperation(new Contract(dkimRegistry).call('is_key_hash_valid', xdr.ScVal.scvBytes(hexToBytes(domainHash)), xdr.ScVal.scvBytes(hexToBytes(hash))))
    .setTimeout(300).build();
  const sim = await ctx.server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Stop('DKIM registry read failed: ' + ('error' in sim ? sim.error : 'restore needed'));
  return sim.transactionData.getReadOnly();
}

export function sorobanData(tx: Transaction): xdr.SorobanTransactionData {
  const env = tx.toEnvelope();
  if (env.type !== 'envelopeTypeTx' || env.v1.tx.ext.type !== 'sorobanData') throw new Stop('assembled transaction has no Soroban data');
  return env.v1.tx.ext.sorobanData;
}

/**
 * What the registry reads before it refuses a wrong project: its instance and code, with fixed resources. For
 * wrong-project when no valid call simulates (a proof that does not verify); the dry run still decides.
 */
export async function bareData(ctx: Ctx): Promise<xdr.SorobanTransactionData> {
  const inst = instanceKey(ctx.dep.registry);
  const e = (await ctx.server.getLedgerEntries(inst)).entries[0];
  const v = e?.val.type === 'contractData' ? e.val.value.val : undefined;
  const ex = v?.type === 'scvContractInstance' ? v.instance.executable : undefined;
  if (ex?.type !== 'contractExecutableWasm') throw new Stop('registry instance not found');
  const code = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: ex.wasmHash }));
  return new SorobanDataBuilder().setFootprint([inst, code], []).setResources(10_000_000, 80_000, 0).setResourceFee(2_000_000n).build();
}

export interface Prepared { name: CaseName; tx: Transaction }

/**
 * The named cases in ORDER as transactions of the wallet's account, with consecutive sequence numbers, so they land
 * in this order. The valid call is simulated once, while the nullifier is unused; every other case borrows its data.
 */
export async function build(ctx: Ctx, a: SubmitArgs, names: CaseName[], timeout = 300): Promise<Prepared[]> {
  const source = await ctx.server.getAccount(a.wallet);
  const op = () => new Contract(ctx.dep.registry).call('submit', ...submitArgs(a));
  const raw = (acct: Account) => new TransactionBuilder(acct, { fee: '100', networkPassphrase: TESTNET }).addOperation(op()).setTimeout(timeout).build();
  const sim = await ctx.server.simulateTransaction(raw(new Account(a.wallet, source.sequenceNumber())));
  let validData: xdr.SorobanTransactionData;
  if (rpc.Api.isSimulationSuccess(sim)) validData = sorobanData(rpc.assembleTransaction(raw(new Account(a.wallet, source.sequenceNumber())), sim).build());
  else if (names.every((n) => n === 'wrong-project')) validData = await bareData(ctx); // e.g. a key of your own with a proof that does not verify
  else throw new Stop('the valid submission does not simulate (' + ('error' in sim ? sim.error.split('\n')[0] : 'restore needed') + '); only wrong-project can run without it');
  const all = cases(a), out: Prepared[] = [];
  for (const name of ORDER.filter((n) => names.includes(n))) {
    const c = all[name];
    const extra = name === 'wrong-artifact' ? [approvalLedgerKey(ctx.dep.registry, c.args.artifactHash)]
      : name === 'unregistered-key' ? await dkimReadKeys(ctx, c.args.dkimKeyHash) : [];
    const tx = name === 'valid' ? rpc.assembleTransaction(raw(source), sim).build() : failingTx(source, ctx.dep.registry, c.args, validData, extra, timeout);
    out.push({ name, tx });
  }
  return out;
}

/** Dry run of this exact transaction: its expected error (a rejection) or success (the valid one), or nothing is sent. */
export async function dryRun(ctx: Ctx, name: CaseName, c: Case, tx: Transaction): Promise<number | null> {
  const pre = await ctx.server.simulateTransaction(tx);
  const code = rpc.Api.isSimulationError(pre) ? simCode(pre.error) : null;
  if (name === 'valid' ? rpc.Api.isSimulationError(pre) : !c.expect.includes(code ?? -1)) {
    throw new Stop(`${name}: dry run gave ${rpc.Api.isSimulationError(pre) ? pre.error.split('\n')[0] : 'success'}; nothing sent`);
  }
  return code;
}

export interface State { approved: boolean; nullifierUsed: boolean }
const state = async (ctx: Ctx, c: Case): Promise<State> => {
  try {
    return {
      approved: await exists(ctx, approvalLedgerKey(ctx.dep.registry, c.args.artifactHash)),
      nullifierUsed: await exists(ctx, nullifierKey(ctx.dep.registry, c.args.nullifier)),
    };
  } catch (e) {
    throw new Stop(`the registry state could not be read: ${String(e).split('\n')[0]}`);
  }
};

/**
 * One signed transaction: dry run, send, wait, check, record. Throws Stop on anything that is not clean evidence.
 * With `resume`, a transaction already on chain (an earlier run that stopped after sending it) is recorded, not resent.
 */
async function sendOne(ctx: Ctx, name: CaseName, c: Case, tx: Transaction, resume = false): Promise<Record<string, unknown>> {
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), log = ctx.log ?? (() => {});
  const hash = bytesToHex(tx.hash());
  if (resume && ctx.recorded?.(name) === hash) {
    log(`${name}: ${hash} is already recorded, kept as it is`);
    return { case: name, hash, kept: true };
  }
  // A failed poll is "not yet", as on the page.
  const poll = async () => {
    const r = await ctx.server._getTransaction(hash).catch(() => undefined);
    return r && r.status !== 'NOT_FOUND' ? r : undefined;
  };
  let raw = resume ? await poll() : undefined;
  let before: State | null = null, preCode: number | null = null;
  if (raw) log(`${name}: ${hash} is already on chain, recording it`);
  else {
    before = await state(ctx, c);
    preCode = await dryRun(ctx, name, c, tx);
    log(`${name}: sending ${hash}`);
    for (let i = 0; ; i++) {
      const sent = await ctx.server.sendTransaction(tx);
      if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') break;
      if (sent.status === 'TRY_AGAIN_LATER' && i < 5) { await sleep(5000); continue; }
      throw new Stop(`${name}: send ${sent.status} ${sent.errorResult?.result.type ?? ''}; nothing recorded`);
    }
    for (let i = 0; i < 60 && !raw; i++) if (!(raw = await poll())) await sleep(2000);
    if (!raw) throw new Stop(`${name}: ${hash} not confirmed in 2 minutes; with --signed, running it again records it once it lands`);
  }
  return record(ctx, name, c, hash, raw, before, preCode, before ? {} : { resumed: 'sent by an earlier run; state before not read' });
}

/** Checks a landed transaction's outcome and the state it left, then writes its record. */
async function record(ctx: Ctx, name: CaseName, c: Case, hash: string, raw: rpc.Api.RawGetTransactionResponse, before: State | null, preCode: number | null, note: Record<string, unknown>) {
  const outcome = decodeOutcome(raw, ctx.dep.registry);
  checkOutcome(name, c, outcome);
  // The transaction is on chain here: a failed read leaves it unrecorded, and a --signed rerun records it from its hash.
  const after = await state(ctx, c).catch((e) => {
    throw new Stop(`${name}: ${hash} is on chain, but ${e instanceof Stop ? e.message : String(e)}; running the same --signed command again completes its record`);
  });
  if (name === 'valid' ? !(after.approved && after.nullifierUsed) : before && (after.approved !== before.approved || after.nullifierUsed !== before.nullifierUsed)) {
    throw new Stop(`${name}: the registry's state is not what this case must leave`);
  }
  const rec = {
    case: name, label: c.label, hash, ledger: raw.ledger, expectedCodes: c.expect, onChainCode: outcome.code, dryRunCode: preCode,
    result: `${outcome.txResult}/${outcome.opResult}`, before, after, ...note,
    registry: ctx.dep.registry, projectId: ctx.dep.projectId, arguments: { ...c.args }, link: `${ctx.dep.expert.replace(/\/$/, '')}/tx/${hash}`,
  };
  await ctx.write(name, rec, raw);
  ctx.log?.(`${name}: ${hash} ${outcome.code === null ? 'SUCCESS' : '#' + outcome.code}`);
  return rec;
}

/** The order the registry forces, checked against its state before anything is built. */
async function orderCheck(ctx: Ctx, a: SubmitArgs, names: CaseName[]): Promise<CaseName[]> {
  const used = await exists(ctx, nullifierKey(ctx.dep.registry, a.nullifier));
  const late = names.find((n) => n !== 'replay' && n !== 'wrong-project' && n !== 'unregistered-key' && used);
  if (late) throw new Stop(`${late} must run before the valid approval: the email's nullifier is already used, so the registry would stop at #6`);
  if (names.includes('replay')) {
    if (ctx.simulate && !used) {
      (ctx.log ?? (() => {}))('replay: skipped in --simulate, the nullifier is still unused (it is dry-run right before it is sent)');
      return names.filter((n) => n !== 'replay');
    }
    if (!names.includes('valid')) throw new Stop(used ? 'replay needs the valid approval in the same run (its footprint and resources)' : 'replay needs the valid approval first');
  }
  return names;
}

/** Key-file mode: signs with `key` (the proof's wallet) and sends the named cases in ORDER. 'valid' only when named. */
export async function run(ctx: Ctx, key: Keypair, proof: unknown, only: CaseName[] = REJECTIONS): Promise<Record<string, unknown>[]> {
  const a = toSorobanArgs(proof) as SubmitArgs;
  if (a.wallet !== key.publicKey()) throw new Stop(`the key file is not the wallet the proof names (${a.wallet})`);
  const names = await orderCheck(ctx, a, only);
  const all = cases(a), done: Record<string, unknown>[] = [];
  // Built up front with consecutive sequence numbers; the slow records come after the last send (collectRecords).
  for (const { name, tx } of await build(ctx, a, names, 900)) {
    if (ctx.simulate) {
      const code = await dryRun(ctx, name, all[name], tx);
      done.push({ case: name, simulated: true, dryRunCode: code });
      ctx.log?.(`${name}: dry run ${code === null ? 'succeeds' : '#' + code} (not sent)`);
      continue;
    }
    tx.sign(key);
    done.push(await sendOne(ctx, name, all[name], tx));
  }
  return done;
}

/** Owner mode, step 1: all six unsigned, in ORDER; the four rejections and the valid one dry-run now. */
export interface Batch {
  cases: CaseName[]; unsigned: string[];
  /** The valid call's Soroban data, kept for a later replay-only line. */ validData?: string;
  /** With the page: the sequence number kept free for the page's valid transaction (the replay line takes the next). */ pageSeq?: string;
}

/** Why prepare stops once the email's nullifier is used, from the cases that still have no record. */
export function usedNullifier(missing: readonly CaseName[]): string {
  const lost = missing.filter((n) => n !== 'valid' && n !== 'replay');
  if (!missing.length) return 'every case already has a record: there is nothing to prepare';
  if (lost.length) return `the email's nullifier is already used and ${lost.join(', ')} ${lost.length > 1 ? 'have' : 'has'} no record: if a transaction reached the chain, the same --signed command records it from its hash; if not, it can no longer be recorded, because the four rejections must come before the valid approval (evidence order); nothing built`;
  if (missing.includes('valid')) return "the email's nullifier is already used but valid has no record: run the same --signed command again (it finds the valid transaction, the page's too, and records it); nothing built";
  return "the email's nullifier is already used and only the replay is left: run the same --signed command again to record a replay line that landed, or --replay for a new one if its time bound ran out; nothing built";
}

/** The cases that have no record yet, in ORDER; with `page`, the valid line leaves the batch and its sequence number is kept. */
export async function prepareBatch(ctx: Ctx, proof: unknown, page = false): Promise<Batch> {
  const a = toSorobanArgs(proof) as SubmitArgs;
  const missing = ORDER.filter((n) => !ctx.recorded?.(n));
  if ((await state(ctx, cases(a).valid)).nullifierUsed) throw new Stop(usedNullifier(missing));
  // valid and replay can only be recorded once the nullifier is used, so with it unused such a record belongs to
  // another registry (another deployment, or before a testnet reset).
  const stale = ORDER.filter((n) => (n === 'valid' || n === 'replay') && !missing.includes(n));
  if (stale.length) throw new Stop(`${stale.join(' and ')} already ${stale.length > 1 ? 'have records' : 'has a record'}, but the email's nullifier is unused on this registry: the records in --out are from another deployment or from before a testnet reset. Check that --deployment and --out belong to the same evidence run; nothing built`);
  // Here valid and replay are both missing, so the batch holds the valid line (the page keeps its sequence number).
  const names = missing;
  const all = cases(a), batch = await build(ctx, a, names, BATCH_TIMEOUT);
  for (const { name, tx } of batch) if (name !== 'replay') await dryRun(ctx, name, all[name], tx);
  const valid = batch.find((b) => b.name === 'valid')!.tx;
  const lines = page ? batch.filter((b) => b.name !== 'valid') : batch;
  return {
    cases: lines.map((b) => b.name), unsigned: lines.map((b) => b.tx.toXDR()), validData: sorobanData(valid).toXDR('base64'),
    ...(page ? { pageSeq: valid.sequence } : {}),
  };
}

/** Writes batch.json and unsigned.txt; an existing batch.json may already be signed or sent, so only --force replaces it. */
export function saveBatch(dir: string, batch: Batch, force = false): void {
  const path = join(dir, 'batch.json');
  if (existsSync(path) && !force) throw new Stop(`${path} exists (its lines may already be signed or sent); --force replaces it`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(batch, null, 2) + '\n');
  writeFileSync(join(dir, 'unsigned.txt'), batch.unsigned.join('\n') + '\n');
  rmSync(join(dir, 'page-before.json'), { force: true }); // belonged to the batch it replaces
}

/**
 * After the valid approval landed, a replay line whose time bound ran out is built again from the valid call's data
 * kept in batch.json (the valid call no longer simulates), dry-run to #6, for the owner to sign.
 */
export async function prepareReplay(ctx: Ctx, proof: unknown, batch: Batch): Promise<Batch> {
  const a = toSorobanArgs(proof) as SubmitArgs, c = cases(a).replay;
  if (ctx.recorded?.('replay')) throw new Stop('the replay already has a record; nothing built');
  // The replay-only send never records the valid approval, so it must be recorded first.
  if (!ctx.recorded?.('valid')) throw new Stop('valid has no record yet: first run the original --signed command again (--batch with its batch.json), which records the valid approval; then --replay; nothing built');
  const line = batch.unsigned[batch.cases.indexOf('replay')];
  if (line) {
    const h = bytesToHex(new Transaction(line, TESTNET).hash());
    const r = await ctx.server._getTransaction(h).catch(() => undefined);
    if (r && r.status !== 'NOT_FOUND') throw new Stop(`the batch's replay line ${h} landed: run the --signed command again to record it; nothing built`);
  }
  if (!(await state(ctx, c)).nullifierUsed) throw new Stop('the valid approval has not landed: send the batch, not a replay line');
  let data: xdr.SorobanTransactionData;
  if (batch.pageSeq) {
    // The page's transaction is the valid call: its own footprint and resources (the valid call no longer simulates).
    const hash = ctx.recorded?.('valid') ?? await findPageTx(ctx, a, batch.pageSeq);
    if (!hash) throw new Stop("the page's transaction was not found among the wallet's transactions; nothing built");
    data = sorobanData((await checkPageTx(ctx, a, hash)).tx);
  } else if (batch.validData) data = xdr.SorobanTransactionData.fromXDR(batch.validData, 'base64');
  else throw new Stop('batch.json holds no valid-call data (made before it was kept)');
  const tx = failingTx(await ctx.server.getAccount(a.wallet), ctx.dep.registry, c.args, data, [], BATCH_TIMEOUT);
  await dryRun(ctx, 'replay', c, tx);
  return { cases: ['replay'], unsigned: [tx.toXDR()] };
}

/** Owner mode, step 2: each signed line must be its unsigned transaction plus one valid signature of the wallet. */
export function checkSigned(wallet: string, unsigned: string[], signed: string[]): Transaction[] {
  if (signed.length !== unsigned.length) throw new Stop(`signed file has ${signed.length} lines, the batch has ${unsigned.length}; nothing sent`);
  const pk = Keypair.fromPublicKey(wallet);
  return signed.map((line, i) => {
    let tx: Transaction;
    try {
      tx = new Transaction(line.trim(), TESTNET);
    } catch {
      throw new Stop(`signed line ${i + 1} is not a transaction; nothing sent`);
    }
    const want = new Transaction(unsigned[i]!, TESTNET);
    if (bytesToHex(tx.hash()) !== bytesToHex(want.hash())) throw new Stop(`signed line ${i + 1} is not the batch's transaction ${i + 1} (changed or out of order); nothing sent`);
    if (tx.signatures.length !== 1 || !pk.verify(tx.hash(), tx.signatures[0]!.signature)) {
      throw new Stop(`signed line ${i + 1} must carry exactly one signature, by ${wallet}; nothing sent`);
    }
    return tx;
  });
}

/** The one contract call a transaction makes, if that is all it does. */
const invoked = (tx: Transaction) => {
  const op = tx.operations[0];
  if (tx.operations.length !== 1 || op?.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') return undefined;
  const ic = op.func.invokeContract;
  return { contract: Address.fromScAddress(ic.contractAddress).toString(), fn: String(ic.functionName), args: ic.args.map((v) => v.toXDR('base64')).join() };
};
const txOf = (envelope: string) => { try { return new Transaction(envelope, TESTNET); } catch { return undefined; } };
/** The wallet's own submit of exactly this proof's arguments to this registry. */
const isProofSubmit = (ctx: Ctx, a: SubmitArgs, tx: Transaction) => {
  const call = invoked(tx);
  return tx.source === a.wallet && call?.contract === ctx.dep.registry && call.fn === 'submit' && call.args === submitArgs(a).map((v) => v.toXDR('base64')).join();
};

interface HorizonTx { hash: string; successful: boolean; source_account_sequence: string; envelope_xdr: string }

/**
 * The page's transaction among the wallet's transactions on Horizon: this proof's submit, the one at the kept sequence
 * number first, else one at another number. undefined when there is none yet; a stop when the kept number went to
 * something else and no submit of this proof is there.
 */
export async function findPageTx(ctx: Ctx, a: SubmitArgs, keptSeq: string): Promise<string | undefined> {
  if (!ctx.horizon) throw new Stop("no Horizon to find the page's transaction");
  const body = await ctx.horizon(`/accounts/${a.wallet}/transactions?order=desc&limit=200`).catch((e: unknown) => {
    throw new Stop(`Horizon did not answer (${String(e).split('\n')[0]}); run again`);
  }) as { _embedded?: { records?: HorizonTx[] } };
  const recs = body._embedded?.records ?? [];
  const at = (r: HorizonTx) => r.source_account_sequence === keptSeq;
  const mine = recs.filter((r) => { const tx = txOf(r.envelope_xdr); return !!tx && isProofSubmit(ctx, a, tx); });
  // Horizon's `successful` only orders the search; checkPageTx reads the outcome from the chain.
  const pick = mine.find((r) => r.successful && at(r)) ?? mine.find((r) => r.successful) ?? mine.find(at);
  const other = recs.find(at);
  if (!pick && other) throw new Stop(`the wallet's transaction at the kept sequence number ${keptSeq} (${other.hash}) is not this proof's submit to this registry; nothing recorded`);
  return pick?.hash;
}

/** The page's transaction as the chain has it: this proof's submit from the wallet to this registry, and a SUCCESS. */
export async function checkPageTx(ctx: Ctx, a: SubmitArgs, hash: string): Promise<{ raw: rpc.Api.RawGetTransactionResponse; tx: Transaction }> {
  const raw = await ctx.server._getTransaction(hash).catch(() => undefined);
  if (!raw || raw.status === 'NOT_FOUND' || !raw.envelopeXdr) throw new Stop(`the page's transaction ${hash} is not on the RPC yet; run again; nothing recorded`);
  const tx = txOf(raw.envelopeXdr);
  if (!tx || bytesToHex(tx.hash()) !== hash || !isProofSubmit(ctx, a, tx)) {
    throw new Stop(`${hash} is not this proof's submit from ${a.wallet} to the registry; nothing recorded`);
  }
  const o = decodeOutcome(raw, ctx.dep.registry);
  if (o.status !== 'SUCCESS') throw new Stop(`the page's transaction ${hash} did not succeed (${o.status}, ${o.txResult}/${o.opResult}); nothing recorded`);
  return { raw, tx };
}

const PAGE_STEPS = (wallet: string) => [
  'On the Mac, where this runs:',
  '  1. npm run preview --prefix web   (in another terminal; it serves the page at http://localhost:4173)',
  `  2. Freighter on Testnet holds the wallet ${wallet}`,
  '  3. open http://localhost:4173, drop the approval-proof.json given to this script (--proof), Record, approve in Freighter',
  'then run this same --signed command again: it finds the page\'s transaction itself and sends the replay.',
];

/**
 * Between the four and the replay: the page's valid transaction, recorded once it is checked, with the state read
 * after the four as `before`. Until it is there, the state is kept and the run pauses for the page.
 */
async function pageStep(ctx: Ctx, a: SubmitArgs, keptSeq: string): Promise<{ rec: Record<string, unknown>; seq: string }> {
  const c = cases(a).valid, kept = ctx.recorded?.('valid');
  const hash = kept ?? await findPageTx(ctx, a, keptSeq);
  if (!hash) {
    const now = await state(ctx, c);
    if (now.nullifierUsed || now.approved) throw new Stop(`the registry shows the approval, but no transaction of ${a.wallet} submits this proof to it; nothing recorded`);
    ctx.pageBefore?.set(now);
    throw new Pause([`The four rejections are on chain. Now record it on the page (sequence number ${keptSeq} is kept for it).`, ...PAGE_STEPS(a.wallet)].join('\n'));
  }
  const { raw, tx } = await checkPageTx(ctx, a, hash);
  if (kept) {
    ctx.log?.(`valid: ${hash} is already recorded, kept as it is`);
    return { rec: { case: 'valid', hash, kept: true }, seq: tx.sequence };
  }
  const before = ctx.pageBefore?.get() ?? null;
  const rec = await record(ctx, 'valid', c, hash, raw, before, null, {
    sentBy: 'the page, signed in the owner\'s wallet', sequence: tx.sequence, ...(before ? {} : { resumed: 'state before the page not kept' }),
  });
  return { rec, seq: tx.sequence };
}

/** Owner mode, step 3: send the checked batch in order; the first outcome that is not the expected one stops it. */
export async function sendBatch(ctx: Ctx, proof: unknown, batch: Batch, signed: string[]): Promise<Record<string, unknown>[]> {
  const a = toSorobanArgs(proof) as SubmitArgs;
  const inOrder = batch.cases.length > 0 && batch.cases.length === batch.unsigned.length
    && batch.cases.every((n, i) => ORDER.includes(n) && (i === 0 || ORDER.indexOf(n) > ORDER.indexOf(batch.cases[i - 1]!)));
  if (!inOrder || (batch.pageSeq && (batch.cases.includes('valid') || batch.cases.at(-1) !== 'replay'))) throw new Stop('the batch is not its cases in order');
  const txs = checkSigned(a.wallet, batch.unsigned, signed);
  const all = cases(a), done: Record<string, unknown>[] = [];
  // Check the whole call before any transaction is sent.
  txs.forEach((tx, i) => {
    const name = batch.cases[i]!;
    if (!isProofSubmit(ctx, all[name].args, tx)) throw new Stop(`line ${i + 1} (${name}) does not submit this case to this registry from the proof's wallet; nothing sent`);
  });
  for (const [i, tx] of txs.entries()) {
    const name = batch.cases[i]!;
    if (name === 'replay' && batch.pageSeq) {
      const page = await pageStep(ctx, a, batch.pageSeq);
      done.push(page.rec);
      if (page.seq !== batch.pageSeq) {
        // The signed replay line's sequence number is gone: a new line from the page transaction's data, to sign.
        ctx.log?.(`valid: the page used sequence number ${page.seq}, not the kept ${batch.pageSeq}; the replay line is built again`);
        throw new Pause('The page took another sequence number, so the signed replay line no longer fits; a new one is written to sign.', await prepareReplay(ctx, proof, batch));
      }
    }
    done.push(await sendOne(ctx, name, all[name], tx, true));
  }
  return done;
}

/** Writes one case's RPC record and summary as soon as it lands; the slow records follow in collectRecords. */
export function fileWriter(out: string) {
  return async (name: CaseName, rec: Record<string, unknown>, raw: unknown) => {
    const dir = join(out, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rpc-getTransaction.json'), JSON.stringify(raw, null, 2) + '\n');
    const files = { rpc: 'rpc-getTransaction.json', horizon: 'pending', expert: 'pending' };
    writeFileSync(join(dir, 'case.json'), JSON.stringify({ ...rec, files }, null, 2) + '\n');
  };
}

function readCaseRecord(out: string, name: CaseName, registry: string) {
  const path = join(out, name, 'case.json');
  if (!existsSync(path)) return undefined;
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  if (rec?.case !== name || rec.registry !== registry || typeof rec.hash !== 'string' || !/^[0-9a-f]{64}$/.test(rec.hash)) {
    throw new Stop(`${name}: the saved record is invalid or belongs to another registry. Choose another --out folder.`);
  }
  return rec;
}

/** Resume only the evidence cases belonging to the selected registry and proof. */
export function recordedHash(out: string, dep: Deployment, approval: SubmitArgs) {
  const expected = cases(approval);
  return (name: CaseName): string | undefined => {
    const rec = readCaseRecord(out, name, dep.registry);
    if (rec && (rec.projectId !== dep.projectId || !isDeepStrictEqual(rec.arguments, expected[name].args))) {
      throw new Stop(`${name}: the saved record belongs to another proof. Choose another --out folder.`);
    }
    return rec?.hash;
  };
}

/**
 * Sends, then (also after a stop: what landed is evidence too) the slow records and the README index. An error in the
 * index step is logged and never replaces the send's own result.
 */
export async function withRecords(ctx: Ctx, out: string, depFile: Record<string, unknown>, send: () => Promise<unknown>, io?: Parameters<typeof collectRecords>[2], signed = false) {
  try {
    return await send();
  } finally {
    try {
      if (existsSync(out)) {
        await collectRecords(out, ctx.dep, io);
        writeIndex(out, contractIds(depFile, await registryConfig(ctx)));
        ctx.log?.(`records: ${out} (${readdirSync(out).length} entries)`);
      }
    } catch (e) {
      // Only a --signed run is safe to repeat (it keeps what landed); a key-file run sends again.
      ctx.log?.(`records index not written (${String(e).split('\n')[0]})${signed ? '; run the same --signed command again to write it' : ''}`);
    }
  }
}

/**
 * After the last send (they take minutes, which a batch's time bound must not pay for): the Horizon answer and the
 * Stellar Expert screenshot of every recorded case that lacks them, or why each is missing.
 */
export async function collectRecords(out: string, dep: Deployment, io = { fetch: globalThis.fetch, shot: screenshot, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }) {
  const records = ORDER.map((name) => readCaseRecord(out, name, dep.registry));
  for (const rec of records) {
    if (!rec) continue;
    const dir = join(out, rec.case), path = join(dir, 'case.json'), files = rec.files;
    if (files.horizon !== 'horizon.json') {
      files.horizon = 'missing: Horizon did not answer';
      for (let i = 0; i < 10; i++) {
        const res = await io.fetch(`${HORIZON}/transactions/${rec.hash}`).catch(() => undefined);
        if (res?.ok) { writeFileSync(join(dir, 'horizon.json'), JSON.stringify(await res.json(), null, 2) + '\n'); files.horizon = 'horizon.json'; break; }
        await io.sleep(5000);
      }
    }
    if (files.expert !== 'stellar-expert.png') {
      // A screenshot that cannot be taken is recorded as missing, with why; the transaction is already on chain.
      const shot = await io.shot(`${dep.expert.replace(/\/$/, '')}/tx/${rec.hash}`, rec.hash, join(dir, 'stellar-expert.png')).catch((e: unknown) => `could not take it (${String(e).split('\n')[0]})`);
      files.expert = shot === true ? 'stellar-expert.png' : `missing: ${shot}`;
    }
    writeFileSync(path, JSON.stringify(rec, null, 2) + '\n');
  }
}

/** true once taken, or why not. */
async function screenshot(url: string, hash: string, path: string): Promise<true | string> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    for (let i = 0; i < 12; i++) {
      await page.goto(url, { waitUntil: 'networkidle' }).catch(() => undefined);
      const text = await page.locator('body').innerText().catch(() => '');
      if (text.includes(hash.slice(0, 12)) && !/not found/i.test(text)) { await page.screenshot({ path, fullPage: true }); return true; }
      await page.waitForTimeout(15_000);
    }
    return 'Stellar Expert had not indexed it';
  } finally {
    await browser.close();
  }
}

/** docs/evidence/README.md from every case.json in the folder. */
export function writeIndex(out: string, contracts: Record<string, string>) {
  const registry = contracts.registry;
  if (!registry) throw new Stop('The evidence index needs a registry address.');
  const recs = ORDER.map((name) => readCaseRecord(out, name, registry)).filter(Boolean);
  const rows = recs.map((r) => `| ${r.label} | ${r.onChainCode === null ? 'success' : '#' + r.onChainCode} | \`${r.hash}\` | [Stellar Expert](${r.link}) | [${r.case}/](${r.case}/) |`);
  writeFileSync(join(out, 'README.md'), [
    '# Testnet evidence', '',
    'Written by `web/scripts/evidence.ts`. Each folder holds the RPC `getTransaction` answer (envelope, result and meta XDR),',
    'the Horizon record, a Stellar Expert screenshot and `case.json` (arguments, expected and on-chain registry error, state',
    'before and after). The links stop working when testnet is reset; the files stay.', '',
    '| Contract | Id |', '|---|---|', ...Object.entries(contracts).map(([k, v]) => `| ${k} | \`${v}\` |`), '',
    '| Case | Registry result | Transaction | Link | Records |', '|---|---|---|---|---|', ...rows, '',
  ].join('\n'));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    proof: { type: 'string' }, 'secret-file': { type: 'string' }, sign: { type: 'string' }, batch: { type: 'string', default: 'evidence-batch' }, signed: { type: 'string' },
    deployment: { type: 'string', default: '../docs/deployments/testnet.json' }, out: { type: 'string', default: '../docs/evidence' },
    only: { type: 'string' }, simulate: { type: 'boolean', default: false }, replay: { type: 'boolean', default: false },
    'page-valid': { type: 'boolean', default: false }, force: { type: 'boolean', default: false },
  } });
  const usage = 'usage: --proof <approval-proof.json> (--sign external [--batch <dir>] [--page-valid [--force]] [--replay] [--signed <file>] | --secret-file <file> [--only a,b]) [--simulate]';
  if (!values.proof || !values['secret-file'] === !values.sign || (values.sign && values.sign !== 'external') || (values.signed && !values.sign) || (values.replay && !values.sign)
    || (values['page-valid'] && (!values.sign || values.signed || values.replay))) throw new Error(usage);
  const only = (values.only?.split(',') ?? REJECTIONS) as CaseName[];
  for (const n of only) if (!ORDER.includes(n)) throw new Error(`unknown case ${n}; cases: ${ORDER.join(', ')}`);
  const depFile = JSON.parse(readFileSync(values.deployment!, 'utf8'));
  const dep = parseDeployment(depFile);
  const proof = parseApprovalProof(readFileSync(values.proof, 'utf8'));
  const dir = resolve(values.batch!), batchFile = join(dir, values.replay ? 'replay.json' : 'batch.json'), beforeFile = join(dir, 'page-before.json');
  const ctx: Ctx = {
    dep, server: new rpc.Server(dep.rpcUrl, { timeout: 30_000 }), write: fileWriter(values.out!),
    recorded: recordedHash(values.out!, dep, toSorobanArgs(proof)), simulate: values.simulate, log: console.log,
    horizon: async (path) => {
      const res = await fetch(HORIZON + path, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Horizon ${res.status}`);
      return res.json();
    },
    pageBefore: {
      get: () => (existsSync(beforeFile) ? JSON.parse(readFileSync(beforeFile, 'utf8')) : undefined),
      set: (s) => writeFileSync(beforeFile, JSON.stringify(s, null, 2) + '\n'),
    },
  };
  /** A replay line for the owner to sign, and how. */
  const saveReplay = (batch: Batch) => {
    writeFileSync(join(dir, 'replay.json'), JSON.stringify(batch, null, 2) + '\n');
    writeFileSync(join(dir, 'unsigned-replay.txt'), batch.unsigned[0] + '\n');
    console.log([
      `The replay line, dry-run to #6, valid for ${BATCH_TIMEOUT / 3600} hours: ${join(dir, 'unsigned-replay.txt')}`,
      'On the Mac, in the folder holding it:',
      '  while read -r x; do stellar tx sign --sign-with-key mailmarks --network testnet "$x" < /dev/null; done < unsigned-replay.txt > signed-replay.txt',
      `then copy signed-replay.txt here and run this script with --sign external --batch ${dir} --replay --signed <signed-replay.txt>`,
    ].join('\n'));
  };
  try {
    if (!values.simulate && (values.signed || values['secret-file'])) {
      for (const name of ORDER) ctx.recorded?.(name);
    }
    if (values.sign && values.replay && !values.signed) {
      saveReplay(await prepareReplay(ctx, proof, JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8'))));
    } else if (values.sign && !values.signed) {
      const page = values['page-valid'];
      const batch = await prepareBatch(ctx, proof, page);
      saveBatch(dir, batch, values.force);
      console.log([
        `${batch.unsigned.length} transactions to sign (${batch.cases.join(', ')}), valid for ${BATCH_TIMEOUT / 3600} hours: ${join(dir, 'unsigned.txt')}`,
        page ? `Sequence number ${batch.pageSeq} is kept free for the page: use this wallet for nothing else, the page included, until the script says so.`
          : 'Do not use this key for anything else until they are sent.',
        'On the Mac, in the folder holding unsigned.txt:',
        '  while read -r x; do stellar tx sign --sign-with-key mailmarks --network testnet "$x" < /dev/null; done < unsigned.txt > signed.txt',
        `then copy signed.txt here and run this script with --sign external --batch ${dir} --signed <signed.txt>`,
        'If a send stops, run the same --signed command again: lines already on chain are recorded, not resent, and records',
        'already written are kept. If only the replay is left and its time bound ran out, add --replay (without --signed) for a new replay line.',
      ].join('\n'));
    } else {
      if (values.signed && values.simulate) throw new Error('--signed sends; --sign external alone dry-runs the batch');
      const send = () => values.signed
        ? sendBatch(ctx, proof, JSON.parse(readFileSync(batchFile, 'utf8')), readFileSync(values.signed, 'utf8').split('\n').filter((l) => l.trim()))
        : run(ctx, Keypair.fromSecret(readFileSync(values['secret-file']!, 'utf8').trim()), proof, only);
      if (values.simulate) await send(); else await withRecords(ctx, values.out!, depFile, send, undefined, !!values.signed);
    }
  } catch (e) {
    if (e instanceof Pause) { console.log(e.message); if (e.replay) saveReplay(e.replay); }
    else if (e instanceof Stop) { console.error('STOPPED: ' + e.message); process.exitCode = 1; } else throw e;
  }
}
