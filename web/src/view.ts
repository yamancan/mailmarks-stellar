// Plain DOM render of the flow state into the static markup in index.html.
// One column: the card (or the empty slot) on top, at most one receipt or line under it, and the dock at the bottom whose
// round shutter is always the next step. Elements are filled in place, not rebuilt, so focus and the live regions
// survive updates; focus moves only to what the user must act on next. Record's click reaches the wallet with no await
// in between.
import { LOST, type Action } from './chain.ts';
import { normalizeHash, short, type Flow, type FlowError, type State, type StepId, type WalletInfo } from './flow.ts';
import { cardPng, makeCard, play, repaintOnResize, setCard, shortHash, type CardData } from './card.ts';
import varial from './wallets/varial.png';
import xbull from './wallets/xbull.png';
import albedo from './wallets/albedo.png';
import hana from './wallets/hana.png';
import rabet from './wallets/rabet.png';

const ICONS: Record<string, string> = { varial, xbull, albedo, hana, rabet };
/** Wallets that run in a web page rather than an extension. */
const WEB = new Set(['albedo']);

const ic = (d: string, s = 24, w = 2) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>';
const MAIL = '<rect x="3" y="5.5" width="18" height="13" rx="3"/><path d="M4 7.5l8 5.5 8-5.5"/>';
const I = {
  tick: ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 12, 3.2),
  bang: ic('<path d="M12 6v8M12 18.5v.01"/>', 12, 3.2),
  search: ic(SEARCH, 22),
  searchBig: ic(SEARCH, 30),
  mail: ic(MAIL, 32),
  file: ic('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', 30),
  save: ic('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>', 22),
  out: ic('<path d="M7 17L17 7M9 7h8v8"/>', 20),
  again: ic('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>', 30, 2.3),
  wallet: ic('<rect x="3" y="6" width="18" height="13" rx="3.5"/><path d="M16 12.5h2"/><path d="M6 6l9-3 1 3"/>', 30),
  drop: ic('<path d="M12 3c3.5 4.2 6 7.5 6 10.5a6 6 0 0 1-12 0C6 10.5 8.5 7.2 12 3z"/>', 26),
  check: ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 34, 3),
};
/** The shutter's ring, filled to `p`. */
const ring = (p: number) => {
  const c = 2 * Math.PI * 39;
  return `<svg class="ring" width="84" height="84" aria-hidden="true"><circle cx="42" cy="42" r="39" fill="none" stroke="currentColor" stroke-width="6" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" stroke-linecap="round"/></svg>`;
};

/** The card develops as the flow advances: the share of its dot columns drawn at each step. */
const REVEAL: Partial<Record<StepId, number>> = { read: 0.62, check: 0.75, wallet: 0.75, prepare: 0.9 };
const BUSY: Partial<Record<StepId, string>> = { read: 'Reading', wallet: 'Connecting', send: 'Recording', confirm: 'Recording' };
/** Errors that are a wait or a top-up, not a fault: their note has no red dot. */
const CALM = new Set<Action>(['fund', 'check-status', 'add-xlm']);
const HEX64 = /^[0-9a-f]{64}$/;

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The page behind an open layer (wallet sheet, first-visit intro) takes no focus or clicks. */
export function syncInert(): void {
  $('app').inert = !$('wallets').hidden || !!document.querySelector('.story');
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** A dock item's words: its label and an optional second line. */
function setLabel(el: HTMLElement, label: string, sub = ''): void {
  const l = el.querySelector<HTMLElement>('.lbl')!;
  if (l.dataset.key === `${label}|${sub}`) return;
  l.dataset.key = `${label}|${sub}`;
  l.replaceChildren(label);
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    l.append(s);
  }
}

/** The middle of the dock: a round shutter with its label under it. A div while it only shows progress. */
function mid(id: string, cls: string, inner: string, label: string, o: { div?: boolean; aria?: string; sub?: string } = {}): HTMLElement {
  const el = document.createElement(o.div ? 'div' : 'button');
  el.id = id;
  el.className = 'mid';
  el.hidden = true;
  if (el instanceof HTMLButtonElement) el.type = 'button';
  if (o.aria) el.setAttribute('aria-label', o.aria);
  el.innerHTML = `<span class="shut ${cls}">${inner}</span><span class="lbl"></span>`;
  setLabel(el, label, o.sub);
  return el;
}

/** A helper beside the shutter: a small orb and a word. */
function side(id: string, tag: 'button' | 'a', icon: string, label: string, aria?: string): HTMLElement {
  const el = document.createElement(tag);
  el.id = id;
  el.className = 'side';
  el.hidden = true;
  if (el instanceof HTMLButtonElement) el.type = 'button';
  else Object.assign(el, { target: '_blank', rel: 'noopener noreferrer' });
  if (aria) el.setAttribute('aria-label', aria);
  el.innerHTML = `<span class="orb">${icon}</span><span class="lbl"></span>`;
  setLabel(el, label);
  return el;
}

const walletImg = (id: string) => {
  const img = document.createElement('img');
  img.src = ICONS[id] ?? '';
  img.alt = '';
  return img;
};

/** A note: its first sentence on one line (with a red dot unless it is calm), the rest under it. */
function fillNote(el: HTMLElement, message: string, dot: boolean): void {
  const [, first = message, rest = ''] = /^(.+?[.!?])\s+(.+)$/s.exec(message) ?? [];
  const t = document.createElement('p');
  if (dot) {
    const d = document.createElement('span');
    d.className = 'dot';
    d.setAttribute('aria-hidden', 'true');
    t.append(d);
  }
  t.append(first);
  el.replaceChildren(t);
  if (rest) {
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = rest;
    el.append(' ', sub); // the space keeps the note's text the message itself
  }
}

type Mark = 'ok' | 'no' | 'spin' | 'todo' | '';
type Row = [key: string, value: string, mark: Mark, o?: { mono?: boolean; small?: string; id?: string; bad?: boolean }];
const MARK_WORD: Record<Exclude<Mark, ''>, string> = { ok: 'Done', no: 'Failed', spin: 'In progress', todo: 'To do' };

/** Receipt rows: hairlines, the key on the left, its mark on the right. Rebuilt only when they change. */
function fillRows(el: HTMLElement, rows: Row[]): void {
  const key = JSON.stringify(rows);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(
    ...rows.map(([k, v, mark, o = {}]) => {
      const tr = document.createElement('div');
      tr.className = `tr${o.bad ? ' bad' : ''}${o.small ? ' tall' : ''}${mark === 'spin' ? ' new' : ''}`;
      const ks = document.createElement('span');
      ks.className = 'k';
      ks.textContent = k;
      const vs = document.createElement('span');
      vs.className = 'v2';
      const val = document.createElement('span');
      val.textContent = v;
      if (o.id) val.id = o.id;
      if (o.mono) val.className = 'mono';
      vs.append(val);
      if (o.small) {
        const sm = document.createElement('small');
        sm.textContent = o.small;
        vs.append(sm);
      }
      const m = document.createElement('span');
      if (mark) {
        m.className = mark;
        m.setAttribute('role', 'img');
        m.setAttribute('aria-label', MARK_WORD[mark]);
        m.innerHTML = mark === 'ok' ? I.tick : mark === 'no' ? I.bang : '';
      }
      tr.append(ks, vs, m);
      return tr;
    }),
  );
}

const size = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

const card = makeCard();
/** The wallet chosen last: focused first when the list comes back, and shown while it is in use. */
let lastWallet: WalletInfo | undefined;
/** The user closed the sheet; Connect Wallet opens it again. */
let sheetClosed = false;
/** A file is being dragged over the page. */
let hot = false;
let current: State | undefined;

export function mount(flow: Flow): void {
  const file = $<HTMLInputElement>('file');
  const hash = $<HTMLInputElement>('hash');
  $('card-slot').append(card);
  for (const mx of document.querySelectorAll('.mx')) mx.innerHTML = '<s></s>'.repeat(64);
  repaintOnResize();

  // The dock's items, one cell each side of the shutter; render shows one per cell.
  const progress = mid('progress-row', 'track', '', 'Reading File', { div: true, sub: 'On this computer' });
  progress.querySelector('.shut')!.innerHTML = `${ring(0)}<span class="n" id="progress-text"></span>`;
  const bar = document.createElement('progress');
  Object.assign(bar, { id: 'progress', className: 'sr', max: 100, value: 0 });
  bar.setAttribute('aria-label', 'Hashing the release file');
  progress.append(bar);
  const sign = mid('sign', 'wait', '<span class="wlogo"></span>', 'Confirm', { div: true });
  sign.setAttribute('role', 'status');
  const check = mid('check', '', I.searchBig, 'Check');
  Object.assign(check, { type: 'submit' });
  check.setAttribute('form', 'paste');
  $('dock-l').append(side('r-tx', 'a', I.out, 'View', 'View on Stellar Expert'));
  $('dock-m').append(
    mid('choose', '', I.file, 'Choose Proof'),
    mid('open-wallets', '', I.wallet, 'Connect Wallet'),
    mid('busy', 'track indet', ring(0.28), 'Checking', { div: true }),
    progress,
    sign,
    mid('approve-button', 'go', I.check, 'Record'),
    mid('error-action', 'go', I.again, 'Try Again'),
    mid('r-done', 'go', I.check, 'Done'),
    check,
    mid('r-another', 'go', I.searchBig, 'Check Another'),
    mid('r-again', 'go', I.mail, 'Record It'),
  );
  $('dock-r').append(
    side('go-status', 'button', I.search, 'Check', 'Check a release'),
    side('r-save', 'button', I.save, 'Save Card'),
    side('wallet-orb', 'button', I.wallet, ''),
    side('r-another-side', 'button', I.search, 'Check Another'),
  );

  // Drop anywhere. The browser's default (opening the file in the tab) is always prevented.
  let depth = 0;
  const setHot = (on: boolean) => {
    hot = on;
    if (current) renderSlot(current);
  };
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++depth === 1) setHot(true);
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) (depth = 0), setHot(false);
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setHot(false);
    const f = e.dataTransfer?.files[0];
    if (f) void flow.drop(f);
  });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = ''; // the same file can be picked again after a fix
    if (f) void flow.drop(f);
  });
  $('drop').addEventListener('click', () => file.click());
  $('choose').addEventListener('click', () => file.click());
  const goHome = () => {
    flow.home();
    $('drop').focus();
  };
  $('back').addEventListener('click', goHome);
  $('go-status').addEventListener('click', () => {
    void flow.showStatus();
    hash.focus();
  });
  for (const id of ['r-another', 'r-another-side']) {
    $(id).addEventListener('click', () => {
      void flow.showStatus();
      hash.value = '';
      renderField();
      hash.focus();
    });
  }
  hash.addEventListener('input', () => {
    $('field').classList.remove('err');
    setText($('ferr'), '');
    renderField();
  });
  $('paste').addEventListener('submit', (e) => {
    e.preventDefault();
    void flow.pasteHash(hash.value);
  });
  // Called straight from the click: the wallet's signature popup needs the click's user activation.
  $('approve-button').addEventListener('click', () => void flow.approve());
  $('error-action').addEventListener('click', () => {
    const err = flow.state.error;
    // Start Again goes back to the start (screen 20); Choose Another opens the file chooser.
    if (err?.action === 'pick-file') errorAction(err, flow.state)[0] === 'Start Again' ? goHome() : file.click();
    else void flow.act();
  });
  $('wallet-orb').addEventListener('click', () => void flow.otherWallet());
  $('open-wallets').addEventListener('click', () => {
    sheetClosed = false;
    renderSheet(flow.state, flow);
  });
  const closeSheet = () => {
    if ($('wallets').hidden) return;
    sheetClosed = true;
    renderSheet(flow.state, flow);
    $('open-wallets').focus();
  };
  $('wallets-close').addEventListener('click', closeSheet);
  $('sheet-bg').addEventListener('click', closeSheet);
  $('wallets').addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());
  for (const id of ['r-done', 'r-again']) $(id).addEventListener('click', goHome);
  // Recorded, or already recorded: Escape is Done.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current?.view === 'proof' && current.result && $('wallets').hidden && !document.querySelector('.story')) goHome();
  });
  $('r-save').addEventListener('click', async () => {
    const d = cardData(flow.state);
    if (!d) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await cardPng(d));
    a.download = `mailmark-${d.project}-${d.sha.slice(0, 8)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });

  let prev: State | undefined;
  flow.subscribe((s) => {
    current = s;
    render(s, prev, flow);
    prev = s;
  });
}

/** What the card shows: the proof's release, or the release looked up. */
function cardData(s: State): CardData | undefined {
  const f = s.file?.fields;
  if (s.view === 'proof' && f) return { project: f.projectId, sha: f.artifactSha256, wallet: f.wallet };
  if (s.view === 'status' && s.lookup && !s.progress) return { project: s.projectId ?? '', sha: s.lookup, wallet: s.result?.record?.wallet ?? '' };
  return undefined;
}

/** The empty card: the proof's slot on the start, the release file's in the status view. Its dots fill while hashing. */
function renderSlot(s: State): void {
  const status = s.view === 'status';
  setText($('drop-title'), hot ? 'Let go' : status ? 'Drop the release file' : 'Drop your email proof');
  setText($('file-name'), hot ? '' : status ? 'hashed here; only\nthe hash is sent' : (s.error && s.file?.name) || 'approval-proof.json, made on your computer from the email');
  $('drop').classList.toggle('hot', hot);
  const p = s.progress;
  const lit = p ? Math.round(16 * (p.total ? p.done / p.total : 1)) : 0;
  $('mx').querySelectorAll('s').forEach((d, i) => d.classList.toggle('on', i % 16 < lit));
}

/** The checksum field's counter, and the shutter that stays dim until it holds 64 hex characters. */
function renderField(): void {
  const v = normalizeHash($<HTMLInputElement>('hash').value);
  setText($('count'), `${v.length} / 64`);
  const lost = current?.view === 'status' && !!current.txLink && !!current.result;
  $('check').querySelector('.shut')!.classList.toggle('off', !HEX64.test(v) && !lost);
}

function render(s: State, prev: State | undefined, flow: Flow): void {
  const err = s.error, r = s.result, f = s.file?.fields;
  const proof = s.view === 'proof', status = s.view === 'status', start = s.view === 'start';
  const last = s.steps.at(-1);
  const active = last?.status === 'active' ? last.id : undefined;
  const badHash = err?.kind === 'bad-hash';
  const hashing = status && !!s.progress;
  /** Status view, after a send whose outcome is unknown: no answer yet, so no verdict, and Check Again. */
  const lost = status && !!r && !r.approved && !!s.txLink;
  const done = proof && !!r;

  // Top: brand on the start, a way back everywhere else (none on Recorded: Done is the way).
  const back = $('back');
  back.hidden = !(status || (proof && !(r && !r.already)));
  back.setAttribute('aria-label', status ? 'Back' : r?.already ? 'Close' : 'Start over');
  $('brand').hidden = proof || status;
  const title = $('title');
  setText(title, status ? 'Is it approved?' : 'Record an email approval');
  title.classList.toggle('sr', !status || !!r);
  $('main').className = `stage${status ? ' look' : done ? ' sealed' : ''}`;

  // The slot (empty card) or the card.
  const d = cardData(s);
  $('pick').hidden = !(start || (proof && !f) || (status && !s.lookup));
  $('dead').hidden = !(s.view === 'loading' || s.view === 'unavailable');
  $('paste').hidden = !status || hashing;
  // A hint only: a dropped file of any kind is routed by flow.drop.
  $<HTMLInputElement>('file').accept = status ? '' : '.json,application/json';
  renderSlot(s);
  $('card-slot').hidden = !d;
  if (d) {
    const reveal = !proof || s.approve || r ? 1 : err ? (err.kind === 'invalid-proof' ? 0.62 : err.step === 'read' || err.step === 'check' ? 0.75 : 1) : (REVEAL[last?.id ?? 'read'] ?? 1);
    const chip = status && !r?.approved ? (lost || (!r && err) ? undefined : r ? 'Not approved' : 'Checking') : undefined;
    setCard(card, d, { sealed: !!r?.approved, reveal, chip });
    card.classList.toggle('shim', (proof && !err && (active === 'send' || active === 'confirm')) || (proof && (err?.kind === 'send-unknown' || err?.kind === 'timeout')) || (status && ((!r && !err) || lost)));
    if (r?.approved && r !== prev?.result && !r.already) play(card);
  }

  // The one line under the card.
  let line = '';
  if (start && !err) line = 'Your email stays on this computer.';
  else if (proof && !err && active === 'sign') line = 'Confirm in your wallet.';
  else if (proof && !err && (active === 'send' || active === 'confirm')) line = 'Recording on Stellar.\nThis takes a few seconds.';
  else if (hashing) line = `${s.file?.name ?? ''} · ${size(s.progress!.total)}`;
  else if (status && !r && s.lookup && !err) line = 'Checking Stellar…';
  setText($('line'), line);

  renderFlow(s, proof, active);
  renderSheet(s, flow, prev);
  renderError(s, prev);
  renderDock(s, active, lost);
  renderField();
  renderResult(s, prev, lost);
  if (badHash && err !== prev?.error) {
    $('field').classList.add('err');
    setText($('ferr'), err.message);
  } else if (!badHash) {
    $('field').classList.remove('err');
    setText($('ferr'), '');
  }
}

function renderFlow(s: State, proof: boolean, active: StepId | undefined): void {
  const f = s.file?.fields;
  $('flow').hidden = !proof;
  if (!proof) return;
  $('fields').hidden = !f || !!s.result;
  if (f) {
    setText($('f-project'), f.projectId);
    setText($('f-artifact'), f.artifactSha256);
    setText($('f-wallet'), f.wallet);
  }
  fillRows($('rows'), proofRows(s, active));
  renderSteps(s);
}

function proofRows(s: State, active: StepId | undefined): Row[] {
  const f = s.file?.fields, err = s.error, name = s.file?.name ?? '';
  if (err) {
    if (err.kind === 'wrong-account' && s.address) return [['Wallet', `${short(s.address)} connected`, 'no', { mono: true, bad: true }]];
    if (err.kind === 'invalid-proof') return [['Email', 'Doesn’t match', 'no', { bad: true }]];
    return [];
  }
  if (s.result) return [];
  if (s.approve) return [['Ready', 'Everything checks out', 'ok'], ['Fee', `≈ ${s.approve.fee}`, '', { mono: true, small: 'Keeps the record on Stellar', id: 'approve-fee' }]];
  switch (active) {
    case 'read':
      return [['Proof', name, 'spin', { mono: true }]];
    case 'check':
      return [['Proof', name, 'ok', { mono: true }], ['Project', f?.projectId ?? '', 'ok', { mono: true }], ['Release', 'Checking…', 'spin']];
    case 'wallet':
      return [['Proof', name, 'ok', { mono: true }], ['Release', 'Not approved yet', 'ok'], ['Wallet', `Use ${short(f?.wallet ?? '')}`, s.wallets ? 'todo' : 'spin']];
    case 'prepare':
      return [['Wallet', short(s.address ?? f?.wallet ?? ''), 'ok', { mono: true }], ['Ready', 'Making sure it will go through', 'spin']];
    default:
      return [];
  }
}

/** The step list, for screen readers only (aria-live): "Label: Done. note". */
function renderSteps(s: State): void {
  const ol = $('steps');
  const items = [...ol.children] as HTMLLIElement[];
  s.steps.forEach((st, i) => {
    // While the Fee row is on screen it carries the fee; the dry-run note does not repeat it.
    const note = s.approve && st.id === 'prepare' ? st.note?.replace(` Network fee: ${s.approve.fee}.`, '') : st.note;
    let li = items[i];
    if (!li || li.dataset.id !== st.id) {
      li = document.createElement('li');
      li.dataset.id = st.id;
      if (items[i]) ol.replaceChild(li, items[i]!);
      else ol.append(li);
      items[i] = li;
    }
    li.dataset.status = st.status;
    const word = st.status === 'done' ? 'Done' : st.status === 'error' ? 'Failed' : 'In progress';
    setText(li, `${st.label}: ${word}.${note ? ' ' + note : ''}`);
  });
  for (const extra of items.slice(s.steps.length)) extra.remove();
}

/** The error's one button: its words and icon. */
function errorAction(err: FlowError, s: State): [label: string, icon: string, go: boolean] {
  if (err.step === 'setup') return err.action === 'none' ? ['', '', false] : ['Try Again', I.again, true];
  switch (err.action) {
    case 'pick-file':
      return s.view === 'proof' && s.file?.fields ? ['Start Again', I.mail, true] : ['Choose Another', I.file, false];
    case 'fund':
      return ['Get Free XLM', I.drop, true];
    case 'add-xlm':
    case 'check-status':
      return ['Check Again', I.again, true];
    case 'none':
      return ['', '', false];
    default:
      return ['Try Again', I.again, true];
  }
}

/** One item per dock cell; the rest hidden. */
function renderDock(s: State, active: StepId | undefined, lost: boolean): void {
  const err = s.error, r = s.result;
  const proof = s.view === 'proof', status = s.view === 'status';
  const [label, icon, go] = err ? errorAction(err, s) : ['', '', false];
  let m: string | undefined;
  if (s.view === 'loading') m = undefined;
  else if (err && err.kind !== 'bad-hash') m = label ? 'error-action' : undefined;
  else if (s.view === 'start') m = 'choose';
  else if (proof) m = r ? 'r-done' : s.approve ? 'approve-button' : s.wallets ? 'open-wallets' : active === 'sign' ? 'sign' : 'busy';
  else if (status) m = s.progress ? 'progress-row' : !r && s.lookup ? 'busy' : r?.approved ? 'r-another' : r && !s.txLink ? 'r-again' : 'check';

  const link = r?.txLink ?? s.txLink ?? err?.txLink;
  const l = link && (proof || status) ? 'r-tx' : undefined;

  const wrongAccount = err?.kind === 'wrong-account';
  const orb = proof && !r && !!s.address && (err ? wrongAccount || err.action === 'fund' : !!s.approve || active === 'prepare');
  const rt = s.view === 'start' ? 'go-status' : r?.approved ? 'r-save' : status && r && !s.txLink ? 'r-another-side' : orb ? 'wallet-orb' : undefined;

  for (const [cell, want] of [['dock-l', l], ['dock-m', m], ['dock-r', rt]] as const) {
    for (const el of $(cell).children as HTMLCollectionOf<HTMLElement>) el.hidden = el.id !== want;
  }

  if (m === 'error-action') {
    const btn = $('error-action');
    const shut = btn.querySelector<HTMLElement>('.shut')!;
    shut.className = `shut${go ? ' go' : ''}`;
    if (shut.dataset.icon !== label) (shut.dataset.icon = label), (shut.innerHTML = icon);
    setLabel(btn, label);
  }
  if (m === 'busy') setLabel($('busy'), status ? 'Checking' : (BUSY[active ?? 'read'] ?? 'Checking'));
  if (m === 'progress-row' && s.progress) {
    const p = s.progress.total ? s.progress.done / s.progress.total : 1;
    const pct = Math.floor(p * 100);
    $('progress-row').querySelector('svg.ring')!.outerHTML = ring(p);
    $('progress-text').innerHTML = `${pct}<small>%</small>`;
    $<HTMLProgressElement>('progress').value = pct;
  }
  if (m === 'sign') {
    const logo = $('sign').querySelector<HTMLElement>('.wlogo')!;
    if (logo.dataset.id !== (lastWallet?.id ?? '')) {
      logo.dataset.id = lastWallet?.id ?? '';
      if (lastWallet) logo.replaceChildren(walletImg(lastWallet.id));
      else logo.innerHTML = I.wallet;
    }
    setLabel($('sign'), `Confirm in ${lastWallet?.name ?? 'your wallet'}`);
  }
  if (m === 'check') setLabel($('check'), lost ? 'Check Again' : 'Check');
  if (rt === 'wallet-orb') {
    const el = $('wallet-orb');
    const word = wrongAccount ? 'Other Wallet' : active === 'prepare' && lastWallet ? lastWallet.name : short(s.address!);
    setLabel(el, word);
    el.setAttribute('aria-label', wrongAccount ? 'Other Wallet' : `${word}: use another wallet`);
    const orbEl = el.querySelector<HTMLElement>('.orb')!;
    if (orbEl.dataset.id !== (lastWallet?.id ?? '-')) {
      orbEl.dataset.id = lastWallet?.id ?? '-';
      if (lastWallet) orbEl.replaceChildren(walletImg(lastWallet.id));
      else orbEl.innerHTML = I.wallet;
    }
  }
  if (l) $<HTMLAnchorElement>('r-tx').href = link!;
}

/** Our own sheet with the wallets' own icons, bundled with the page; the kit's modal is never used. */
function renderSheet(s: State, flow: Flow, prev?: State): void {
  if (prev && s.wallets !== prev.wallets) {
    sheetClosed = false;
    fillWallets(s, flow);
  }
  const open = !!s.wallets && !sheetClosed;
  const was = !$('wallets').hidden;
  $('wallets').hidden = $('sheet-bg').hidden = !open;
  syncInert();
  if (open && (!was || s.wallets !== prev?.wallets)) {
    const btns = [...$('wallet-list').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    (btns.find((b) => b.dataset.id === lastWallet?.id) ?? btns[0] ?? $('wallets-close')).focus();
  }
}

function fillWallets(s: State, flow: Flow): void {
  const ul = $('wallet-list');
  ul.replaceChildren();
  if (!s.wallets) return;
  const wanted = s.file?.fields?.wallet;
  setText($('wallets-text'), wanted ? `Use the one with ${short(wanted)}.` : '');
  for (const w of s.wallets) {
    const li = document.createElement('li');
    const i = document.createElement('i');
    i.append(walletImg(w.id));
    const tag = document.createElement('span');
    let el: HTMLElement;
    if (w.available) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = w.id;
      b.addEventListener('click', () => {
        lastWallet = w;
        void flow.chooseWallet(w.id);
      });
      tag.textContent = WEB.has(w.id) ? 'Web wallet' : 'Installed';
      if (!WEB.has(w.id)) tag.className = 'in';
      el = b;
    } else if (w.url) {
      const a = document.createElement('a');
      a.href = w.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      tag.textContent = 'Get it';
      el = a;
    } else {
      const b = document.createElement('button');
      b.type = 'button';
      b.disabled = true;
      tag.textContent = 'Not installed';
      el = b;
    }
    el.className = 'wl';
    el.append(i, w.name, ' ', tag); // read as "Rabet Installed"
    li.append(el);
    ul.append(li);
  }
}

function renderError(s: State, prev: State | undefined): void {
  const err = s.error;
  $('error').hidden = !err || err.kind === 'bad-hash';
  if (!err || err === prev?.error) return;
  fillNote($('error-message'), err.message, !CALM.has(err.action));
  $('error-details').hidden = !err.detail;
  setText($('error-detail'), err.detail ?? '');
  ($('error-details') as HTMLDetailsElement).open = false;
  // The dock is filled after this; focus once it is.
  queueMicrotask(() => {
    const btn = $('error-action');
    if (err.kind === 'bad-hash') $('hash').focus();
    else if (!btn.hidden) btn.focus();
    else if (err.step === 'lookup') $('hash').focus();
  });
}

/** The answer: recorded, already recorded, approved or not yet; the receipt and Details under it. */
function renderResult(s: State, prev: State | undefined, lost: boolean): void {
  const r = s.result;
  $('result').hidden = !r;
  if (s.approve && !prev?.approve) $('approve-button').focus();
  if (!r || (r === prev?.result && s.txLink === prev?.txLink)) return;
  const proof = s.view === 'proof';

  const title = $('result-title');
  setText(title, lost ? '' : proof ? (r.already ? 'Already recorded.' : r.approved ? 'Recorded.' : 'Not yet.') : r.approved ? 'Approved.' : 'Not yet.');
  title.className = `big${proof ? (r.already ? ' s40' : '') : ' s44'}`;
  title.hidden = lost;
  const text = proof
    ? r.already
      ? 'This release is on Stellar. Nothing more to do.'
      : r.approved
        ? 'Any app can now check this release.'
        : ''
    : !r.approved && !lost
      ? 'No approval for this file on Stellar.'
      : '';
  setText($('r-text'), text);
  $('r-note').hidden = !lost;
  if (lost) fillNote($('r-note'), LOST, false);
  fillRows(
    $('r-rows'),
    !proof && r.approved
      ? [
          ...(s.senderDomain ? [['Approved by', s.senderDomain, '', { mono: true }] as Row] : []),
          ...(r.record ? [['Recorded by', short(r.record.wallet), '', { mono: true }] as Row] : []),
          ['Project', s.projectId ?? '', '', { mono: true }],
          ['Release', shortHash(r.artifact), '', { mono: true }],
        ]
      : [],
  );
  // The release just looked up stays in the field, so Check looks it up again.
  if (!proof) $<HTMLInputElement>('hash').value = r.artifact;
  $('r-details').hidden = lost;
  ($('r-details') as HTMLDetailsElement).open = false;
  setText($('r-artifact'), r.artifact);
  $('record').hidden = !r.record;
  if (r.record) {
    setText($('r-wallet'), r.record.wallet);
    setText($('r-ledger'), String(r.record.ledger));
  }
  if (lost) $('check').focus();
  else title.focus();
}
