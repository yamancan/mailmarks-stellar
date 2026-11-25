// The page's state machine. No DOM: view.ts renders `state`, main.ts wires
// the real chain and wallet, the unit tests wire stubs. Every error names its step, says one plain sentence and
// carries one action; the loaded file stays loaded.
import { ApprovalProofError, MAX_FILE_BYTES, parseApprovalProof, toSorobanArgs } from '../../shared/approval-proof.js';
import {
  ChainError,
  TESTNET,
  WRONG_NETWORK,
  checkHash,
  checkProject,
  checkWallet,
  xlm,
  type Action,
  type ApprovalRecord,
  type Chain,
  type Deployment,
  type Signer,
  type SubmitArgs,
} from './chain.ts';
import type { Transaction } from '@stellar/stellar-sdk';
import { sha256File } from './hash.ts';

export interface WalletInfo {
  id: string;
  name: string;
  available: boolean;
  url?: string;
}

/** The wallet as the flow needs it; wallet.ts puts Stellar Wallets Kit behind it, the tests a stub. */
export interface WalletPort extends Signer {
  list(): Promise<WalletInfo[]>;
  /** Selects the wallet and asks it for the account; returns the address. */
  connect(id: string): Promise<string>;
  /** The wallet's network passphrase, or null when the wallet cannot say. */
  network(): Promise<string | null>;
}

export type ChainPort = Pick<Chain, 'isApproved' | 'approvalRecord' | 'prepareSubmit' | 'signAndSend' | 'txLink'>;

export interface FlowDeps {
  loadDeployment(): Promise<Deployment>;
  chain(dep: Deployment): ChainPort;
  wallet: WalletPort;
  fund(address: string): Promise<void>;
}

export type StepId = 'setup' | 'read' | 'check' | 'wallet' | 'prepare' | 'sign' | 'send' | 'confirm' | 'hash' | 'lookup';
const ORDER: StepId[] = ['setup', 'read', 'check', 'wallet', 'prepare', 'sign', 'send', 'confirm', 'hash', 'lookup'];

export interface Step {
  id: StepId;
  label: string;
  status: 'active' | 'done' | 'error';
  note?: string;
}

export interface FlowError {
  step: StepId;
  /** The ChainError kind, so the view can mark the wrong row (wrong-account, invalid-proof, bad-hash). */
  kind?: string;
  message: string;
  action: Action;
  detail?: string;
  txHash?: string;
  /** Stellar Expert link for txHash. */
  txLink?: string;
}

export interface Result {
  artifact: string;
  approved: boolean;
  record: ApprovalRecord | null;
  /** True when the file's release was approved before this visit: nothing was sent. */
  already?: boolean;
  txLink?: string;
}

export type View = 'loading' | 'unavailable' | 'start' | 'proof' | 'status';

export interface State {
  view: View;
  projectId?: string;
  /** From the deployment: who approves (the "Approved by" row). */
  senderDomain?: string;
  /** The loaded file: its name always, its fields once read. */
  file?: { name: string; fields?: { projectId: string; artifactSha256: string; wallet: string } };
  steps: Step[];
  error?: FlowError;
  /** Set while the page waits for the user to pick a wallet. */
  wallets?: WalletInfo[];
  /** Set while the page waits for the Approve click that starts the wallet's signature: the fee. */
  approve?: { fee: string };
  progress?: { done: number; total: number };
  result?: Result;
  /** A transaction to look up, carried into the status view from a send whose outcome is unknown. */
  txLink?: string;
  /** The account the wallet connected with (also when it is the wrong one). */
  address?: string;
  /** The status view: the release being looked up (known before its answer). */
  lookup?: string;
}

const LABELS: Record<StepId, string> = {
  setup: 'Load the page settings',
  read: 'Read the approval file',
  check: 'Check the project and whether this release is already approved',
  wallet: 'Connect the wallet this approval names',
  prepare: 'Try the approval',
  sign: 'Sign in your wallet',
  send: 'Send the approval',
  confirm: 'Wait for the network to confirm',
  hash: 'Compute the release hash on this device',
  lookup: 'Look up the release',
};

export const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

/** A dropped email is refused by name and type, before anything reads it. */
export const isEmail = (f: { name: string; type: string }) => /\.eml$/i.test(f.name) || f.type === 'message/rfc822';
/** A small .json goes to the proof flow; anything else is a release file to hash. */
export const isProofFile = (f: { name: string; size: number }) => /\.json$/i.test(f.name) && f.size <= MAX_FILE_BYTES;
/** A pasted hash: spaces and line breaks from copying dropped, upper case accepted. */
export const normalizeHash = (text: string) => text.replace(/\s+/g, '').toLowerCase();

const EMAIL_REFUSED = 'That is the email itself. It stays on your computer. Drop the proof made from it: approval-proof.json.';
/** In the status view every file is a release to hash, so the proof is not what to drop there. */
const EMAIL_REFUSED_STATUS = 'That is the email itself. It stays on your computer. Drop the release file to check it.';

/** The shared reader's message as a plain sentence; the reader's own text goes to Details. */
export function proofError(e: ApprovalProofError): Omit<FlowError, 'step'> {
  const m = e.message;
  let message: string;
  if (/^This file is (not an approval proof|too large)|^The approval proof (must be|is missing|has an unexpected)/.test(m)) {
    message = 'This isn’t a proof file. Drop approval-proof.json.';
  } else if (/format version/.test(m)) {
    message = 'This proof was made by a different version of the tool. Make it again with the current version.';
  } else if (/is for network/.test(m)) {
    message = 'This proof is for another network. Make it again for Testnet.';
  } else {
    message = 'This proof is incomplete. Make it again from the original email.';
  }
  return { message, action: 'pick-file', detail: m };
}

export function toFlowError(step: StepId, e: unknown): FlowError {
  if (e instanceof ChainError) return { step, kind: e.kind, message: e.message, action: e.action, detail: e.detail, txHash: e.txHash };
  if (e instanceof ApprovalProofError) return { step, ...proofError(e) };
  return { step, message: 'Something went wrong on this step. Try again.', action: 'retry', detail: String((e as Error)?.message ?? e) };
}

/** Thrown inside a run that a newer file, hash or view replaced: its results are dropped. */
class Stale extends Error {}

export class Flow {
  state: State = { view: 'loading', steps: [] };
  private readonly deps: FlowDeps;
  private readonly listeners = new Set<(s: State) => void>();
  private dep: Deployment | undefined;
  private chain: ChainPort | undefined;
  private run = 0;
  private file: File | undefined;
  private args: SubmitArgs | undefined;
  private walletId: string | undefined;
  private address: string | undefined;
  /** The simulated transaction waiting for the Approve click. */
  private prepared: Transaction | undefined;
  private active: StepId = 'setup';
  /** Until when (ms) the transaction of a lost send can still land: its time bound. */
  private txUntil = 0;

  constructor(deps: FlowDeps) {
    this.deps = deps;
  }

  subscribe(fn: (s: State) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }

  private set(run: number, patch: Partial<State>): void {
    if (run !== this.run) throw new Stale();
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Starts `id`, dropping it and every later step (a retry runs them again). */
  private begin(run: number, id: StepId, label = LABELS[id]): void {
    this.active = id;
    const keep = this.state.steps.filter((s) => ORDER.indexOf(s.id) < ORDER.indexOf(id));
    this.set(run, { steps: [...keep, { id, label, status: 'active' }], error: undefined });
  }

  private done(run: number, id: StepId, note?: string): void {
    this.set(run, { steps: this.state.steps.map((s) => (s.id === id ? { ...s, label: LABELS[id], status: 'done', note } : s)) });
  }

  /** Runs one stretch of the flow; any error lands on the step that was active, with the file kept. */
  private async guard(run: number, f: () => Promise<void>): Promise<void> {
    try {
      await f();
    } catch (e) {
      if (e instanceof Stale || run !== this.run) return;
      const err = toFlowError(this.active, e);
      if (err.txHash && this.chain) err.txLink = this.chain.txLink(err.txHash);
      this.set(run, {
        error: err,
        wallets: undefined,
        approve: undefined,
        progress: undefined,
        steps: this.state.steps.map((s) => (s.id === err.step ? { ...s, status: 'error' } : s)),
      });
    }
  }

  private fresh(view: View, patch: Partial<State> = {}): number {
    const run = ++this.run;
    this.set(run, { view, steps: [], error: undefined, wallets: undefined, approve: undefined, progress: undefined, result: undefined, txLink: undefined, file: undefined, address: undefined, lookup: undefined, ...patch });
    return run;
  }

  async start(): Promise<void> {
    const run = this.fresh('loading');
    await this.guard(run, async () => {
      this.active = 'setup';
      this.dep = await this.deps.loadDeployment();
      this.chain = this.deps.chain(this.dep);
      this.set(run, { view: 'start', projectId: this.dep.projectId, senderDomain: this.dep.senderDomain });
    });
    if (this.state.error) this.set(run, { view: 'unavailable' });
  }

  /** A file dropped anywhere or picked. Routed by kind; in the status view every file is a release to hash. */
  async drop(file: File): Promise<void> {
    const v = this.state.view;
    if (v === 'loading' || v === 'unavailable') return;
    const toStatus = v === 'status' || !isProofFile(file);
    if (isEmail(file)) {
      const run = this.fresh(v === 'status' ? 'status' : 'start', { file: { name: file.name } });
      const step = v === 'status' ? 'hash' : 'read';
      this.set(run, { steps: [{ id: step, label: LABELS[step], status: 'error' }], error: { step, message: v === 'status' ? EMAIL_REFUSED_STATUS : EMAIL_REFUSED, action: 'pick-file' } });
      return;
    }
    this.file = file;
    if (toStatus) return this.hashFile(this.fresh('status', { file: { name: file.name } }));
    this.walletId = undefined;
    return this.readProof(this.fresh('proof', { file: { name: file.name } }));
  }

  private readProof(run: number): Promise<void> {
    const file = this.file!;
    return this.guard(run, async () => {
      this.begin(run, 'read');
      const args = toSorobanArgs(parseApprovalProof(await file.text()));
      // The shared args belong to the newest run only: a file that finishes reading after a newer one was dropped must
      // not replace them, or the screen would show one proof and the transaction carry the other.
      if (run !== this.run) throw new Stale();
      this.args = args;
      const fields = { projectId: args.projectId, artifactSha256: args.artifactHash, wallet: args.wallet };
      this.set(run, { file: { name: file.name, fields } });
      this.done(run, 'read');
      await this.check(run);
    });
  }

  /** On load, before any wallet: a wrong-project or already-approved file ends here. */
  private async check(run: number): Promise<void> {
    const a = this.args!;
    this.begin(run, 'check');
    checkProject(a.projectId, this.dep!);
    if (await this.chain!.isApproved(a.projectId, a.artifactHash)) {
      const record = await this.chain!.approvalRecord(a.artifactHash).catch(() => null);
      this.done(run, 'check', 'This release is already approved.');
      this.set(run, { result: { artifact: a.artifactHash, approved: true, record, already: true } });
      return;
    }
    this.done(run, 'check', 'Right project, not approved yet.');
    await this.walletStep(run);
  }

  private async walletStep(run: number): Promise<void> {
    this.begin(run, 'wallet');
    if (this.walletId) return this.connect(run);
    this.set(run, { wallets: await this.deps.wallet.list() });
  }

  /** The user picked a wallet from the list. */
  chooseWallet(id: string): Promise<void> {
    const run = this.run;
    this.walletId = id;
    return this.guard(run, async () => {
      this.set(run, { wallets: undefined });
      await this.connect(run);
    });
  }

  private async connect(run: number): Promise<void> {
    const w = this.deps.wallet;
    let address: string;
    try {
      address = await w.connect(this.walletId!);
    } catch (e) {
      // Forget the choice so "try again" shows the list: the wallet may be locked, missing or the wrong one.
      this.walletId = undefined;
      throw new ChainError('wallet-connect', 'The wallet did not connect. Unlock it or choose another wallet, then try again.', 'retry', String((e as Error)?.message ?? JSON.stringify(e)));
    }
    this.set(run, { address }); // throws Stale for an older run, so its late answer never replaces this.address
    this.address = address;
    checkWallet(address, this.args!.wallet);
    const net = await w.network();
    if (net !== null && net !== TESTNET) {
      throw new ChainError('wrong-network', WRONG_NETWORK, 'switch-network', `Wallet network: ${net}\nThis page: ${TESTNET}`);
    }
    this.done(run, 'wallet', `Connected ${short(address)}.`);
    await this.submit(run);
  }

  /** Simulate and check, then wait for the Approve click. */
  private async submit(run: number, again = false): Promise<void> {
    this.begin(run, 'prepare');
    const { tx, fee } = await this.chain!.prepareSubmit(this.args!);
    this.done(run, 'prepare', `${again ? 'Ran again because the first one passed its time limit. ' : ''}It works. Network fee: ${xlm(fee)}.`);
    this.prepared = tx;
    this.set(run, { approve: { fee: xlm(fee) } });
  }

  /**
   * The Approve click: sign, send and confirm, then read the approval back. Nothing is awaited before the wallet's
   * signTransaction, so a wallet that signs in a popup (Albedo, xBull) opens it inside the click's user activation.
   */
  approve(): Promise<void> {
    const run = this.run;
    const tx = this.prepared;
    if (!this.state.approve || !tx) return Promise.resolve();
    this.prepared = undefined;
    const a = this.args!;
    const chain = this.chain!;
    return this.guard(run, async () => {
      this.set(run, { approve: undefined });
      // A transaction left waiting until its time limit would only fail on send: simulate a fresh one instead.
      const max = Number(tx.timeBounds?.maxTime || 0);
      if (max && max * 1000 < Date.now() + 30_000) return this.submit(run, true);
      this.txUntil = max ? max * 1000 : Infinity;
      this.begin(run, 'sign');
      const { hash } = await chain.signAndSend(tx, this.deps.wallet, a, (stage) => {
        this.done(run, this.active);
        this.begin(run, stage);
      });
      await this.readBack(run, hash);
    });
  }

  private async readBack(run: number, hash: string): Promise<void> {
    const a = this.args!;
    const chain = this.chain!;
    const txLink = chain.txLink(hash);
    let approved: boolean, record: ApprovalRecord | null;
    try {
      approved = await chain.isApproved(a.projectId, a.artifactHash);
      record = await chain.approvalRecord(a.artifactHash).catch(() => null);
    } catch (e) {
      throw new ChainError('read-back', 'The approval was sent and confirmed, but reading it back failed. Check the status in a minute.', 'check-status', String(e), hash);
    }
    this.done(run, 'confirm', record ? `Recorded in ledger ${record.ledger}.` : 'Confirmed.');
    this.set(run, { result: { artifact: a.artifactHash, approved, record, txLink } });
  }

  /** The button on an error: re-runs what failed, or does the one thing that fixes it. `pick-file` is the view's. */
  act(): Promise<void> {
    const err = this.state.error;
    const run = this.run;
    if (!err) return Promise.resolve();
    if (err.step === 'setup') return this.start();
    switch (err.action) {
      case 'check-status':
        return this.showStatus(this.args?.artifactHash, err.txHash);
      case 'fund':
        return this.guard(run, async () => {
          this.begin(run, 'prepare', 'Fund the account with free Test XLM');
          await this.deps.fund(this.address!);
          await this.submit(run);
        });
      case 'switch-account':
      case 'switch-network':
        // Try Again asks the same wallet again; Other Wallet (otherWallet) shows the list.
        return this.guard(run, () => this.walletStep(run));
      case 'retry':
      case 'rebuild':
      case 'add-xlm':
        return this.guard(run, () => this.resume(run, err.step));
      default:
        return Promise.resolve();
    }
  }

  private resume(run: number, step: StepId): Promise<void> {
    switch (step) {
      case 'read':
        return this.readProof(run);
      case 'check':
        return this.check(run);
      case 'wallet':
        return this.walletStep(run);
      case 'hash':
        return this.hashFile(run);
      case 'lookup':
        return this.lookup(run, this.lastHash!);
      default:
        // A signature belongs to one built transaction: anything after simulation starts again from there,
        // back to the Approve click.
        return this.submit(run);
    }
  }

  /** Other Wallet: the list again, from any point after the checks. Whatever was in hand is dropped. */
  otherWallet(): Promise<void> {
    if (this.state.view !== 'proof' || !this.args || this.state.result) return Promise.resolve();
    const run = ++this.run;
    this.walletId = undefined;
    this.prepared = undefined;
    return this.guard(run, async () => {
      this.set(run, { approve: undefined, address: undefined });
      await this.walletStep(run);
    });
  }

  private lastHash: string | undefined;
  /** A lost send's transaction can still land only until its time bound; after that its link is dropped. */
  private live = () => Date.now() < this.txUntil;

  /** The status view: empty, or looking up a known release (and the transaction whose outcome was unknown). */
  showStatus(artifact?: string, txHash?: string): Promise<void> {
    if (this.state.view === 'loading' || this.state.view === 'unavailable') return Promise.resolve();
    const run = this.fresh('status', { txLink: txHash && this.live() ? this.chain!.txLink(txHash) : undefined });
    return artifact ? this.guard(run, () => this.lookup(run, artifact)) : Promise.resolve();
  }

  /** Back to the start (the proof flow). */
  home(): void {
    if (this.state.view === 'loading' || this.state.view === 'unavailable') return;
    this.fresh('start');
  }

  pasteHash(text: string): Promise<void> {
    if (this.state.view === 'loading' || this.state.view === 'unavailable') return Promise.resolve();
    // Checking the same release again keeps the link to the transaction whose outcome was unknown.
    const run = this.fresh('status', { txLink: this.state.result?.artifact === normalizeHash(text) && this.live() ? this.state.txLink : undefined });
    return this.guard(run, async () => {
      this.active = 'lookup';
      await this.lookup(run, checkHash(normalizeHash(text)));
    });
  }

  private hashFile(run: number): Promise<void> {
    const file = this.file!;
    return this.guard(run, async () => {
      this.begin(run, 'hash');
      this.set(run, { progress: { done: 0, total: file.size } });
      let pct = 0;
      const hash = await sha256File(file, (done, total) => {
        const p = total ? Math.floor((done * 100) / total) : 100;
        if (p !== pct) {
          pct = p;
          this.set(run, { progress: { done, total } });
        }
      });
      this.set(run, { progress: undefined });
      this.done(run, 'hash', `SHA-256 ${hash}`);
      await this.lookup(run, hash);
    });
  }

  private async lookup(run: number, hash: string): Promise<void> {
    this.lastHash = hash;
    this.begin(run, 'lookup');
    this.set(run, { lookup: hash });
    const approved = await this.chain!.isApproved(this.dep!.projectId, hash);
    const record = approved ? await this.chain!.approvalRecord(hash).catch(() => null) : null;
    this.done(run, 'lookup', approved ? 'Approved.' : 'Not approved.');
    this.set(run, { result: { artifact: hash, approved, record }, txLink: this.live() ? this.state.txLink : undefined });
  }
}
