// The first-visit intro: three short stories (screens 01–03 of the design). Shown once; Skip, Escape or Start end it, and the
// browser remembers that (localStorage 'mm.intro'). Each story moves on by itself after 6 s unless the user asks for
// less motion, in which case it waits for Next.
import { glyph, makeCard, play, setCard } from './card.ts';
import { syncInert } from './view.ts';

const KEY = 'mm.intro';
const SAMPLE = { project: 'mailmarks', sha: 'bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac', wallet: 'GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN' };
const svg = (d: string, w: number) =>
  `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const NEXT = svg('<path d="M5 12h13M13 6l6 6-6 6"/>', 2.6);
const START = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 3);

const STORIES = [
  { h: 'Got the go-ahead\nby email?', p: 'Put it on Stellar, where any app can check it.', look: { sealed: true } },
  { h: 'Your email\nstays here.', p: 'Your computer turns it into a proof. Only the proof goes online.', look: { reveal: 0.5 } },
  { h: 'One tap\nto record it.', p: 'Then any app can ask: is this release approved?', look: { sealed: true }, play: true },
];

function seen(): boolean {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false; // storage blocked: show it, it is closable
  }
}

export function intro(onEnd: () => void): void {
  if (seen()) return;
  const el = document.createElement('div');
  el.className = 'story';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'How Mailmarks works');
  el.tabIndex = -1;
  document.body.append(el);
  syncInert();
  let i = 0;

  const end = () => {
    el.remove();
    syncInert();
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* not remembered: it shows again next time */
    }
    onEnd();
  };
  const go = (d: number) => {
    const n = i + d;
    if (n < 0 || n >= STORIES.length) return;
    i = n;
    show();
  };

  // One shell for every story: the buttons keep focus and the live region stays the same element, so a screen reader
  // hears each new story. show() only changes the parts that differ.
  el.innerHTML = `<div class="story-in">
      <div class="st-bars" aria-hidden="true"></div>
      <div class="st-top"><span class="brand"></span><button type="button" class="pill skip">Skip</button></div>
      <div class="tap l" aria-hidden="true"></div><div class="tap r" aria-hidden="true"></div>
      <div class="st-stage" aria-hidden="true"></div>
      <div class="st-text" aria-live="polite"><h2 class="hl c"></h2><p class="line c"></p></div>
      <div class="dock"><div class="cell"></div><div class="cell"><button type="button" class="mid st-next"><span class="shut go"></span><span class="lbl"></span></button></div><div class="cell"></div></div></div>`;
  const part = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  part('.brand').append(glyph(24), 'Mailmarks');
  const card = makeCard();
  part('.st-stage').append(card);
  part('.skip').addEventListener('click', end);
  part('.st-next').addEventListener('click', () => (i === STORIES.length - 1 ? end() : go(1)));
  part('.tap.l').addEventListener('click', () => go(-1));
  part('.tap.r').addEventListener('click', () => go(1));
  // The bar's own animation is the story's clock: no animation (reduced motion), no auto-advance.
  part('.st-bars').addEventListener('animationend', () => go(1));

  const show = () => {
    const s = STORIES[i]!;
    const lastOne = i === STORIES.length - 1;
    part('.st-bars').innerHTML = STORIES.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'now' : ''}"><b></b></i>`).join('');
    setCard(card, SAMPLE, s.look);
    card.removeAttribute('tabindex'); // a picture here: the stories' words say it all
    if (s.play) play(card);
    part('.st-text h2').textContent = s.h;
    part('.st-text p').textContent = s.p;
    const skip = part('.skip');
    // Skip goes on the last story; focus, if it was there, moves to the button that ends the intro.
    if (lastOne && document.activeElement === skip) part('.st-next').focus();
    skip.hidden = lastOne;
    part('.st-next .shut').innerHTML = lastOne ? START : NEXT;
    part('.st-next .lbl').textContent = lastOne ? 'Start' : 'Next';
  };

  el.addEventListener('pointerdown', (e) => !(e.target as Element).closest('button') && el.classList.add('paused'));
  el.addEventListener('pointerup', () => el.classList.remove('paused'));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Escape') end();
  });
  show();
  el.focus();
}
