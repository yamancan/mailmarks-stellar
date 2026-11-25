// The Mark card: every colour on the page is drawn from the release's own SHA-256.
// Plain functions, no page state, so the contrast test can run `draw` on its own. The card is the page's progress: its
// dot columns appear left to right as the flow advances (`reveal`), and colour floods in only when it is sealed.

const SVG = 'http://www.w3.org/2000/svg';
const SCRIM = 'rgba(0,0,0,.84)';
/** The text bands, as fractions of the card's height: above TOP and below BOTTOM. */
export const TOP = 0.17, BOTTOM = 0.68;

/** Three hues from the first three bytes. */
export function hues(hex: string): [number, number, number] {
  const [b0, b1, b2] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const h1 = (b0 / 256) * 360;
  return [h1, (h1 + 40 + (b1 % 70)) % 360, (h1 + 180 + (b2 % 70)) % 360];
}

/** Paints the card for `hex` at the canvas's laid-out size (or `size`). The text bands get their dark scrim here,
 * inside the picture, so white text keeps AA contrast whatever the hash (e2e/contrast.spec.ts samples it). Dot columns
 * at or past `reveal` (a share of the 16) are drawn faint. */
export function draw(cv: HTMLCanvasElement, hex: string, reveal = 1, size?: { w: number; h: number }): void {
  const r = size ? { width: size.w, height: size.h } : cv.getBoundingClientRect();
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  const dpr = size ? 2 : Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const b: number[] = [];
  for (let i = 0; i < 64; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
  const [h1, h2, h3] = hues(hex);
  g.fillStyle = `hsl(${h1},60%,13%)`;
  g.fillRect(0, 0, w, h);
  const blob = (x: number, y: number, rad: number, hue: number, l: number, a: number) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `hsla(${hue},92%,${l}%,${a})`);
    gr.addColorStop(1, `hsla(${hue},92%,${l}%,0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  };
  blob((b[3]! / 255) * w, (b[4]! / 255) * h, w * (0.55 + b[5]! / 700), h1, 55, 0.95);
  blob((b[6]! / 255) * w, (b[7]! / 255) * h, w * (0.5 + b[8]! / 700), h2, 62, 0.85);
  blob((b[9]! / 255) * w, (b[10]! / 255) * h, w * (0.4 + b[11]! / 800), h3, 60, 0.7);
  // Scrims behind the top and bottom text: solid where the text sits, fading towards the middle.
  const fade = (from: number, to: number) => {
    const gr = g.createLinearGradient(0, from, 0, to);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, SCRIM);
    g.fillStyle = gr;
    g.fillRect(0, Math.min(from, to), w, Math.abs(to - from));
  };
  g.fillStyle = SCRIM;
  g.fillRect(0, 0, w, h * TOP);
  g.fillRect(0, h * BOTTOM, w, h * (1 - BOTTOM));
  fade(h * (TOP + 0.09), h * TOP);
  fade(h * (BOTTOM - 0.08), h * BOTTOM);
  // The fingerprint: 64 hex characters as a 16 × 4 field of dots, one per character, its size the value.
  const pad = w * 0.055, cell = (w - pad * 2) / 16, top = h * 0.42 - cell * 2;
  const on = Math.round(16 * reveal);
  for (let i = 0; i < 64; i++) {
    const v = parseInt(hex[i]!, 16);
    g.fillStyle = i % 16 < on ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.06)';
    g.beginPath();
    g.arc(pad + cell * ((i % 16) + 0.5), top + cell * (Math.floor(i / 16) + 0.5), Math.max(0.8, ((v + 1) / 16) * cell * 0.4), 0, Math.PI * 2);
    g.fill();
  }
}

/** The brand glyph: an envelope with a tick. */
export function glyph(size: number, env = 'var(--ink)', ink = 'var(--bg)'): SVGSVGElement {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<rect x="3" y="9" width="26" height="18" rx="5" fill="${env}"/><path d="M7 14.5l8.2 6L29 6" fill="none" stroke="${env}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 14.5l8.2 6L29 6" fill="none" stroke="${ink}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  return s;
}

export const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
export const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

export interface CardData {
  project: string;
  sha: string;
  wallet: string;
}

export interface CardLook {
  sealed?: boolean;
  /** Share of the dot columns drawn (the progress); 1 when left out. */
  reveal?: number;
  /** The chip's word; Approved when sealed, else Pending. */
  chip?: string;
}

const SEAL = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="9" width="26" height="18" rx="5" fill="#111"/><path d="M7 14.5l8.2 6L29 6" fill="none" stroke="#fff" stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 14.5l8.2 6L29 6" fill="none" stroke="#111" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** A card element. Its words are in its label (role img); a sealed card is a button that plays the seal again. */
export function makeCard(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'mark';
  el.innerHTML = `<div class="face"><canvas class="bw" aria-hidden="true"></canvas><canvas class="col" aria-hidden="true"></canvas>
    <div class="m-top" aria-hidden="true"><span class="m-brand"></span><span class="m-chip"></span></div>
    <div class="seal" aria-hidden="true">${SEAL}</div>
    <div class="m-bot" aria-hidden="true"><div><div class="m-proj"></div><div class="m-hash"></div></div><div class="m-wal"></div></div></div>
    <div class="burst" aria-hidden="true">${'<i></i>'.repeat(14)}</div><span class="sr m-label"></span>`;
  el.querySelector('.m-brand')!.append(glyph(18, '#fff', '#16131f'), 'MAILMARK');
  const replay = () => el.classList.contains('sealed') && play(el);
  el.addEventListener('click', replay);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    replay();
  });
  return el;
}

/** Fills a card and repaints it when the release or its progress changes. */
export function setCard(el: HTMLElement, d: CardData, o: CardLook = {}): void {
  const sealed = !!o.sealed;
  el.classList.toggle('sealed', sealed);
  if (!sealed) el.classList.remove('play');
  const chip = o.chip ?? (sealed ? 'Approved' : 'Pending');
  el.querySelector('.m-chip')!.textContent = chip;
  el.querySelector('.m-proj')!.textContent = d.project;
  el.querySelector('.m-hash')!.textContent = shortHash(d.sha);
  el.querySelector('.m-wal')!.textContent = d.wallet ? shortWallet(d.wallet) : '';
  const label = `Mailmark card for ${d.project} ${shortHash(d.sha)}, ${chip.toLowerCase()}`;
  el.setAttribute('role', sealed ? 'button' : 'img');
  // A button is named by its content (the card's words are data, not a visible label to match, WCAG 2.5.3); an img
  // has no name from content.
  el.querySelector('.m-label')!.textContent = sealed ? `${label}. Play the seal again` : '';
  if (sealed) el.removeAttribute('aria-label');
  else el.setAttribute('aria-label', label);
  if (sealed) el.tabIndex = 0;
  else el.removeAttribute('tabindex');
  if (el.dataset.sha !== d.sha) {
    // The burst's dots take the card's own hues.
    const hs = hues(d.sha);
    el.querySelectorAll<HTMLElement>('.burst i').forEach((dot, i) => {
      const a = (i / 14) * Math.PI * 2, r = 70 + (i % 3) * 26;
      dot.style.cssText = `--x:${(Math.cos(a) * r).toFixed(0)}px;--y:${(Math.sin(a) * r).toFixed(0)}px;background:hsl(${hs[i % 3]},92%,64%)`;
    });
  }
  el.dataset.sha = d.sha;
  el.dataset.reveal = String(o.reveal ?? 1);
  paint(el);
}

/** The seal moment: colour floods from the seal, the seal stamps, the dots burst out. Off with reduced motion. */
export function play(el: HTMLElement): void {
  el.classList.remove('play');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  void el.offsetWidth;
  el.classList.add('play');
}

/** Draws the card if it is laid out and was not drawn at this size for this release and progress yet. */
export function paint(el: HTMLElement): void {
  const width = el.querySelector('canvas')?.getBoundingClientRect().width;
  const key = `${el.dataset.sha}@${width}@${el.dataset.reveal}@${el.classList.contains('sealed')}`;
  if (!el.dataset.sha || !width || el.dataset.painted === key) return;
  el.dataset.painted = key;
  el.querySelectorAll('canvas').forEach((cv) => cv.checkVisibility?.() !== false && draw(cv, el.dataset.sha!, +el.dataset.reveal!));
}

/** Repaints every visible card when the layout changes size. */
export function repaintOnResize(): void {
  let t: ReturnType<typeof setTimeout> | undefined;
  addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => document.querySelectorAll<HTMLElement>('.mark').forEach(paint), 150);
  });
}

/** The card as a picture to keep or share (Save Card): 856 × 540 px, drawn the same way, with its words and seal. */
export function cardPng(d: CardData): Promise<Blob> {
  const w = 428, h = 270;
  const cv = document.createElement('canvas');
  draw(cv, d.sha, 1, { w, h });
  const g = cv.getContext('2d')!;
  const sans = getComputedStyle(document.body).fontFamily, mono = getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace';
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  const mark = (x: number, y: number, s: number, env: string, ink: string) => {
    g.save();
    g.translate(x, y);
    g.scale(s / 32, s / 32);
    g.fillStyle = env;
    g.beginPath();
    g.roundRect(3, 9, 26, 18, 5);
    g.fill();
    const tick = new Path2D('M7 14.5l8.2 6L29 6');
    g.lineCap = g.lineJoin = 'round';
    g.strokeStyle = env;
    g.lineWidth = 6;
    g.stroke(tick);
    g.strokeStyle = ink;
    g.lineWidth = 2.8;
    g.stroke(tick);
    g.restore();
  };
  mark(18, 12, 20, '#fff', '#16131f');
  g.font = `600 12px ${sans}`;
  g.fillText('MAILMARK', 44, 27);
  g.font = `600 13px ${sans}`;
  const chip = 'Approved', cw = g.measureText(chip).width + 20;
  g.fillStyle = 'rgba(255,255,255,.16)';
  g.beginPath();
  g.roundRect(w - 18 - cw, 12, cw, 24, 12);
  g.fill();
  g.fillStyle = '#fff';
  g.fillText(chip, w - 18 - cw + 10, 28.5);
  g.font = `700 28px ${sans}`;
  g.fillText(d.project, 18, h - 38);
  g.font = `13px ${mono}`;
  g.globalAlpha = 0.82;
  g.fillText(shortHash(d.sha), 18, h - 17);
  g.textAlign = 'right';
  if (d.wallet) g.fillText(shortWallet(d.wallet), w - 18, h - 17);
  g.globalAlpha = 1;
  // The seal, as on the sealed card.
  g.save();
  g.translate(w - 16 - 34, h / 2 - 8);
  g.rotate((-8 * Math.PI) / 180);
  g.fillStyle = 'rgba(255,255,255,.95)';
  g.beginPath();
  g.arc(0, 0, 34, 0, Math.PI * 2);
  g.fill();
  mark(-19, -19, 38, '#111', '#fff');
  g.restore();
  // Rounded corners.
  g.globalCompositeOperation = 'destination-in';
  g.beginPath();
  g.roundRect(0, 0, w, h, 22);
  g.fill();
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('no picture'))), 'image/png'));
}
