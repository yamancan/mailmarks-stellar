// Every Stellar call the page makes (no DOM): the calls, the checks before signing and the read path.
// All ScVals are built here from web's own stellar-sdk; shared/approval-proof.js only hands over strings and hex.
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { PROJECT_RE, hexToBytes, bytesToHex } from '../../shared/encode.js';

export const TESTNET = Networks.TESTNET;
/** Screen 18. */
export const WRONG_NETWORK = 'Your wallet is on another network. Switch it to Testnet and try again.';
/** Screen 22: sent, but no answer yet. */
export const LOST = 'Still waiting to hear back. It may still go through. Check again in a minute.';
const STROOPS_PER_XLM = 10_000_000n;
// shortcut: testnet base reserve is fixed at 0.5 XLM; read it from the ledger header if the network ever changes it.
const BASE_RESERVE = 5_000_000n;
const TX_TIMEOUT_S = 300;
// Per RPC request; the sdk's default is no limit, so a stalled connection would hang a step with no message.
const RPC_TIMEOUT_MS = 20_000;
// Waiting longer than this for confirmation is past the useful window (ledgers close every ~5 s).
const POLL_DEADLINE_MS = 90_000;

/** What the page can offer next after an error: one action per error. */
export type Action = 'retry' | 'rebuild' | 'pick-file' | 'switch-account' | 'switch-network' | 'fund' | 'add-xlm' | 'check-status' | 'none';

export class ChainError extends Error {
  readonly kind: string;
  readonly action: Action;
  /** Diagnostic text for a "Details" toggle; never the main message. */
  readonly detail: string | undefined;
  /** Set when a transaction was sent (or may have been): the user can look it up. */
  readonly txHash: string | undefined;
  constructor(kind: string, message: string, action: Action, detail?: string, txHash?: string) {
    super(message);
    this.kind = kind;
    this.action = action;
    this.detail = detail;
    this.txHash = txHash;
  }
}

/** Registry `Error` codes (contracts/approval-registry/src/lib.rs) as plain sentences with one next action. */
export const CONTRACT_ERRORS: Record<number, [kind: string, message: string, action: Action]> = {
  1: ['bad-config', 'This page is not set up correctly. Nothing was recorded.', 'none'],
  2: ['bad-wallet', 'The wallet named in this approval is not a regular Stellar account, so it cannot sign.', 'pick-file'],
  3: ['wrong-project', 'This approval is for a different project than this page records.', 'pick-file'],
  4: ['non-canonical', 'This proof is damaged. Make it again from the original email.', 'pick-file'],
  5: ['unknown-key', 'This project does not recognize the signing key. If the mail provider changed its key, ask the project for its new approval page.', 'none'],
  // One email binds one release, so a used email also means this release is approved: both lead to its record.
  6: ['nullifier-used', 'This approval email has already been used to record an approval.', 'check-status'],
  7: ['already-approved', 'This release is already approved.', 'check-status'],
  8: ['invalid-proof', 'This proof doesn’t match the email. Make it again from the original email.', 'pick-file'],
  9: ['malformed-proof', 'This proof is damaged. Make it again from the original email.', 'pick-file'],
};

/** Screen 23's words, also for any other lost connection. */
export const OFFLINE = 'Can’t connect right now. Check your internet connection and try again.';
const rpcError = (detail: unknown) => new ChainError('rpc', OFFLINE, 'retry', String(detail));

export interface Deployment {
  rpcUrl: string;
  networkPassphrase: string;
  registry: string;
  projectId: string;
  expert: string;
  /** The approving sender's mail domain (DKIM d=), for the status view's "Approved by" row; shown only when set. */
  senderDomain?: string;
}

/** Checks deployment.json. Testnet only: any other passphrase is refused, whatever the file says. */
export function parseDeployment(d: unknown): Deployment {
  const bad = (what: string) => new ChainError('bad-deployment', `This page's configuration is broken (${what}).`, 'none');
  if (typeof d !== 'object' || d === null) throw bad('not an object');
  const o = d as Record<string, unknown>;
  for (const k of ['rpcUrl', 'networkPassphrase', 'registry', 'projectId', 'expert']) if (typeof o[k] !== 'string') throw bad(`missing ${k}`);
  const dep = o as unknown as Deployment;
  if (dep.networkPassphrase !== TESTNET) throw new ChainError('not-testnet', 'This page only works on Stellar testnet.', 'none');
  if (!/^https:\/\/[^/\s]+(\/\S*)?$/.test(dep.rpcUrl)) throw bad('rpcUrl must be https');
  if (!/^https:\/\/[^/\s]+(\/\S*)?$/.test(dep.expert)) throw bad('expert must be https');
  if (!StrKey.isValidContract(dep.registry)) throw bad('registry is not a contract address');
  if (!PROJECT_RE.test(dep.projectId)) throw bad('projectId');
  const domain = o.senderDomain;
  if (domain !== undefined && (typeof domain !== 'string' || !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain))) throw bad('senderDomain');
  return { rpcUrl: dep.rpcUrl, networkPassphrase: TESTNET, registry: dep.registry, projectId: dep.projectId, expert: dep.expert, ...(domain ? { senderDomain: domain } : {}) };
}

/** Fetches deployment.json next to the page. A missing file means no testnet deployment yet, not a crash. */
export async function loadDeployment(fetchFn: typeof fetch = fetch, url = 'deployment.json'): Promise<Deployment> {
  let res: Response;
  try {
    res = await fetchFn(url, { cache: 'no-store' });
  } catch (e) {
    throw new ChainError('no-deployment', OFFLINE, 'retry', String(e));
  }
  if (res.status === 404) throw new ChainError('no-deployment', 'No testnet deployment is configured yet.', 'none');
  if (!res.ok) throw new ChainError('no-deployment', OFFLINE, 'retry', `HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ChainError('bad-deployment', "This page's configuration is broken (not JSON).", 'none');
  }
  return parseDeployment(body);
}

/** On file load, before any wallet: the file must be for the project this registry records. */
export function checkProject(fileProject: string, dep: Deployment): void {
  if (fileProject !== dep.projectId) {
    throw new ChainError('project-mismatch', `This approval is for project "${fileProject}"; this page records approvals for "${dep.projectId}".`, 'pick-file');
  }
}

/** The connected account must be the wallet the email names. */
export function checkWallet(connected: string, expected: string): void {
  if (connected !== expected) {
    const short = `${expected.slice(0, 4)}…${expected.slice(-4)}`;
    throw new ChainError('wrong-account', `This approval is for ${short}. Switch accounts in your wallet. Nothing was sent.`, 'switch-account');
  }
}

/** `submit` arguments from `toSorobanArgs` (shared/approval-proof.js). */
export interface SubmitArgs {
  wallet: string;
  projectId: string;
  artifactHash: string;
  dkimKeyHash: string;
  nullifier: string;
  proof: { a: string; b: string; c: string };
}

const bytes = (hex: string) => xdr.ScVal.scvBytes(hexToBytes(hex));

/** A release hash typed or pasted by the user: refused here, before it can reach simulation as an unhelpful error.
 * The message says what is wrong with this one (screen 26). */
export function checkHash(hex: string): string {
  if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  const off = Math.abs(hex.length - 64), chars = off === 1 ? 'One character' : `${off} characters`;
  const message = /[^0-9a-f]/.test(hex) ? 'A checksum uses only 0–9 and a–f.' : `${chars} ${hex.length < 64 ? 'short' : 'too many'}. A checksum has 64.`;
  throw new ChainError('bad-hash', message, 'none');
}
const sym = (s: string) => xdr.ScVal.scvSymbol(s);

/** `submit(wallet, project_id, artifact_hash, dkim_key_hash, nullifier, proof)`; `Proof` is a struct, i.e. a map keyed a, b, c. */
export function submitArgs(a: SubmitArgs): xdr.ScVal[] {
  const proof = xdr.ScVal.scvMap(
    (['a', 'b', 'c'] as const).map((k) => new xdr.ScMapEntry({ key: sym(k), val: bytes(a.proof[k]) })),
  );
  return [new Address(a.wallet).toScVal(), xdr.ScVal.scvString(a.projectId), bytes(a.artifactHash), bytes(a.dkimKeyHash), bytes(a.nullifier), proof];
}

/** `DataKey::Approval(artifact_hash)` as stored: a vec of the variant symbol and the 32 bytes. */
export function approvalKey(artifactHex: string): xdr.ScVal {
  return xdr.ScVal.scvVec([sym('Approval'), bytes(checkHash(artifactHex))]);
}

export interface ApprovalRecord {
  wallet: string;
  nullifier: string;
  ledger: number;
  liveUntilLedger: number | undefined;
}

/** Wallets Kit's `signTransaction` shape, so the kit and the test signer plug in the same way. */
export interface Signer {
  signTransaction(xdr: string, opts: { networkPassphrase: string; address: string }): Promise<{ signedTxXdr: string }>;
}

export interface ChainOptions {
  server?: rpc.Server;
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
  rpcTimeoutMs?: number;
  now?: () => number;
}

export class Chain {
  readonly dep: Deployment;
  readonly server: rpc.Server;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollAttempts: number;
  readonly pollIntervalMs: number;
  readonly pollDeadlineMs: number;
  readonly now: () => number;

  constructor(dep: Deployment, opts: ChainOptions = {}) {
    this.dep = dep;
    this.server = opts.server ?? new rpc.Server(dep.rpcUrl, { timeout: opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS });
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollAttempts = opts.pollAttempts ?? 45;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.pollDeadlineMs = opts.pollDeadlineMs ?? POLL_DEADLINE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Stellar Expert link for a transaction. */
  txLink(hash: string): string {
    return `${this.dep.expert.replace(/\/$/, '')}/tx/${hash}`;
  }

  private async call<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ChainError) throw e;
      throw rpcError(e);
    }
  }

  private build(source: Account, args: xdr.ScVal[], fn: string): Transaction {
    return new TransactionBuilder(source, { fee: '100', networkPassphrase: TESTNET })
      .addOperation(new Contract(this.dep.registry).call(fn, ...args))
      .setTimeout(TX_TIMEOUT_S)
      .build();
  }

  private async simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
    const sim = await this.call(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw simulationError(sim.error);
    if (rpc.Api.isSimulationRestore(sim)) {
      // shortcut: protocol ≥ 23 restores through the footprint; a restore preamble means an older RPC. Upgrade path:
      // send the restore transaction first (docs/contract-storage.md lists the manual fallback).
      throw new ChainError('needs-restore', 'Part of the approval record must be restored first. Try again in a few minutes.', 'retry');
    }
    return sim;
  }

  /** `is_approved(project_id, artifact_hash)`, read through simulation (no account or signature needed). */
  async isApproved(projectId: string, artifactHex: string): Promise<boolean> {
    // Any well-formed source works for a read-only simulation; it is never signed or sent.
    const source = new Account(Keypair.random().publicKey(), '0');
    const sim = await this.simulate(this.build(source, [xdr.ScVal.scvString(projectId), bytes(checkHash(artifactHex))], 'is_approved'));
    const v = sim.result ? scValToNative(sim.result.retval) : undefined;
    if (typeof v !== 'boolean') throw rpcError(`is_approved returned ${String(v)}`);
    return v;
  }

  /** The stored approval (wallet, nullifier, ledger), or null. `is_approved` stays the authority; this adds detail. */
  async approvalRecord(artifactHex: string): Promise<ApprovalRecord | null> {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(this.dep.registry).toScAddress(),
        key: approvalKey(artifactHex),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const res = await this.call(() => this.server.getLedgerEntries(key));
    const e = res.entries[0];
    if (!e) return null;
    if (e.val.type !== 'contractData') throw rpcError(`unexpected entry ${e.val.type}`);
    const rec = scValToNative(e.val.value.val) as { wallet: string; nullifier: Uint8Array; ledger: number };
    return { wallet: rec.wallet, nullifier: bytesToHex(rec.nullifier), ledger: Number(rec.ledger), liveUntilLedger: e.liveUntilLedgerSeq };
  }

  /** Spendable XLM in stroops, or null when the account does not exist on testnet. */
  async spendable(address: string): Promise<bigint | null> {
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }));
    const res = await this.call(() => this.server.getLedgerEntries(key));
    const e = res.entries[0];
    if (!e) return null;
    if (e.val.type !== 'account') throw rpcError(`unexpected entry ${e.val.type}`);
    const acc = e.val.value;
    let selling = 0n, sponsoring = 0, sponsored = 0;
    if (acc.ext.type === 'v1') {
      selling = acc.ext.value.liabilities.selling;
      if (acc.ext.value.ext.type === 'v2') {
        sponsoring = acc.ext.value.ext.value.numSponsoring;
        sponsored = acc.ext.value.ext.value.numSponsored;
      }
    }
    const reserve = BigInt(2 + acc.numSubEntries + sponsoring - sponsored) * BASE_RESERVE;
    return acc.balance - reserve - selling;
  }

  /**
   * Builds `submit`, simulates it (a contract error comes back as its plain sentence) and assembles footprint and fee.
   * Then checks, now that the fee is known: the account can pay it, and the release is still not approved.
   */
  async prepareSubmit(a: SubmitArgs): Promise<{ tx: Transaction; fee: bigint }> {
    const balance = await this.spendable(a.wallet);
    if (balance === null) {
      // Screen 19: a new testnet account has no XLM at all; Friendbot creates and funds it.
      throw new ChainError('account-missing', 'Not enough XLM for the fee. Test XLM is free. Get it in one tap.', 'fund');
    }
    const seq = await this.call(() => this.server.getAccount(a.wallet));
    // Built once: each build() bumps the account's sequence, so the assembled tx must be the simulated one.
    const raw = this.build(seq, submitArgs(a), 'submit');
    const tx = rpc.assembleTransaction(raw, await this.simulate(raw)).build();
    const fee = BigInt(tx.fee);
    if (balance < fee) {
      throw new ChainError('underfunded', `Not enough XLM for the fee. You need ${xlm(fee - balance)} more for a fee of ${xlm(fee)}.`, 'add-xlm');
    }
    if (await this.isApproved(a.projectId, a.artifactHash)) throw contractError(7);
    return { tx, fee };
  }

  /**
   * Asks the wallet to sign, checks the signature against the testnet hash before anything is sent, sends and waits.
   * Returns the transaction hash and ledger.
   */
  async signAndSend(tx: Transaction, signer: Signer, a: SubmitArgs, onStage?: (s: 'send' | 'confirm') => void): Promise<{ hash: string; ledger: number }> {
    const wallet = a.wallet;
    let signedXdr: string;
    try {
      ({ signedTxXdr: signedXdr } = await signer.signTransaction(tx.toXDR(), { networkPassphrase: TESTNET, address: wallet }));
    } catch (e) {
      throw new ChainError('wallet-refused', 'The wallet did not sign. Nothing was sent.', 'retry', String((e as Error)?.message ?? e));
    }
    const signed = verifySigned(tx, signedXdr, wallet);

    // Known before sending, so a lost answer never loses the transaction: the user can still look it up.
    const hash = bytesToHex(signed.hash());
    const pending = (kind: string, message: string) => new ChainError(kind, message, 'check-status', undefined, hash);

    onStage?.('send');
    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.server.sendTransaction(signed);
    } catch {
      // The server may have the transaction already; signing again would only fail on the used sequence.
      throw pending('send-unknown', LOST);
    }
    if (sent.status === 'ERROR') throw sendError(sent.errorResult?.result.type);
    if (sent.status === 'TRY_AGAIN_LATER') throw new ChainError('busy', 'Stellar is busy right now. Try again in a moment.', 'rebuild');

    onStage?.('confirm');
    const start = this.now();
    for (let i = 0; i < this.pollAttempts && this.now() - start < this.pollDeadlineMs; i++) {
      // Raw status only: the parsed form decodes the full result meta, which the page does not need.
      // A failed poll request counts as "not yet": the transaction is out, only the answer was lost.
      const got = await this.server._getTransaction(hash).catch(() => undefined);
      if (got?.status === 'SUCCESS') return { hash, ledger: got.ledger ?? 0 };
      if (got?.status === 'FAILED') throw await this.failedOnChain(a, hash);
      await this.sleep(this.pollIntervalMs);
    }
    throw pending('timeout', LOST);
  }

  /** Most likely cause of an on-chain failure after a clean simulation: another submit for this release landed first. */
  private async failedOnChain(a: SubmitArgs, hash: string): Promise<ChainError> {
    let approved: boolean;
    try {
      approved = await this.isApproved(a.projectId, a.artifactHash);
    } catch {
      return new ChainError('failed', 'Stellar turned this down. Check the status of this release.', 'check-status', undefined, hash);
    }
    if (approved) return new ChainError('already-approved', CONTRACT_ERRORS[7]![1], 'check-status', undefined, hash);
    return new ChainError('failed', 'Stellar turned this down. Nothing was recorded. Try again.', 'rebuild', undefined, hash);
  }
}


export function xlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} XLM`;
}

export function contractError(code: number): ChainError {
  const [kind, message, action] = CONTRACT_ERRORS[code] ?? ['contract', `The approval was refused (code ${code}).`, 'none'];
  return new ChainError(kind, message, action);
}

/**
 * Simulation errors carry the host error as text, e.g. `HostError: Error(Contract, #7)` then an event log. Only the
 * first line is the call's own error; the log below can name a nested contract's error.
 */
export function simulationError(text: string): ChainError {
  const m = /^HostError: Error\(Contract, #(\d+)\)/.exec(text.trimStart().split('\n')[0] ?? '');
  if (m) return contractError(Number(m[1]));
  return new ChainError('simulation', 'This couldn’t be prepared. Try again.', 'retry', text);
}

export function sendError(code: string | undefined): ChainError {
  switch (code) {
    case 'txTooLate':
    case 'txBadSeq':
      return new ChainError(code, 'That took too long or your account changed. Try again.', 'rebuild');
    case 'txInsufficientBalance':
      return new ChainError(code, 'Not enough XLM for the fee. Get Test XLM and try again.', 'add-xlm');
    case 'txInsufficientFee':
      return new ChainError(code, 'The network fee went up. Try again.', 'rebuild');
    default:
      return new ChainError('send-failed', 'Stellar refused this. Nothing was recorded. Try again.', 'rebuild', code);
  }
}

/**
 * The wallet must return the same transaction, signed by `wallet` over the testnet hash. A wallet set to another
 * network signs another hash, so its signature does not verify here and nothing is sent.
 */
export function verifySigned(tx: Transaction, signedXdr: string, wallet: string): Transaction {
  let signed: Transaction;
  try {
    signed = TransactionBuilder.fromXDR(signedXdr, TESTNET) as Transaction;
  } catch {
    throw new ChainError('bad-signature', 'Your wallet sent back something unexpected. Nothing was sent.', 'retry');
  }
  if (!('operations' in signed) || bytesToHex(signed.hash()) !== bytesToHex(tx.hash())) {
    throw new ChainError('tx-changed', 'Your wallet changed the request before signing. Nothing was sent. Try again.', 'rebuild');
  }
  const kp = Keypair.fromPublicKey(wallet);
  const mine = signed.signatures.filter((s) => bytesToHex(s.hint.value) === bytesToHex(kp.signatureHint()));
  if (mine.length === 0) {
    throw new ChainError('wrong-signer', 'Another account in your wallet signed. Nothing was sent; switch to the account this approval names.', 'switch-account');
  }
  // Signed by this key but not over the testnet hash: the wallet is set to another network.
  if (!mine.some((s) => kp.verify(signed.hash(), s.signature))) {
    throw new ChainError('wrong-network', WRONG_NETWORK, 'switch-network', `This page: ${TESTNET}`);
  }
  return signed;
}

export const FRIENDBOT = 'https://friendbot.stellar.org';

/** Creates a testnet account with Friendbot's XLM. An account that exists already counts as funded. */
export async function friendbot(address: string, fetchFn: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
  } catch (e) {
    throw new ChainError('friendbot', 'Can’t reach the free Test XLM service. Try again.', 'fund', String(e));
  }
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  if (/createAccountAlreadyExist|already funded/i.test(body)) return;
  throw new ChainError('friendbot', 'The free Test XLM didn’t arrive. Try again in a minute.', 'fund', `HTTP ${res.status} ${body.slice(0, 200)}`);
}
