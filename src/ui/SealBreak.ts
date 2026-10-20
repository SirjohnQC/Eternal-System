/**
 * Breaking the golden card's seal (the Forge's whisper; playtest Oct 20: the
 * card looked better, the animation should too). About 1.6 s:
 *
 *  1. TREMBLE (0-650 ms): the card shakes, its glow swells, a crack runs
 *     across the wax.
 *  2. BREAK (650 ms): a flash; the card turns to its opened face; the two
 *     halves of the seal (cut from the sealed art, so they match it exactly)
 *     fly apart and spin away; gold sparks burst outward.
 *  3. REVEAL (650-1600 ms): the card settles, green light rises from the seed.
 *
 * UI only: it touches nothing in the simulation, so plain Math.random for
 * where sparks fly is fine. Reduced-motion users get the swap and a short fade.
 */

/** Where the seal sits on the sealed art, as fractions of the card (measured on golden_card.png). */
const SEAL = { cx: 0.5, cy: 0.497, r: 0.27 };
const SEALED_ART = '/assets/pixel/divine/cards/golden_card.png';

const TREMBLE_MS = 650;
const DONE_MS = 1600;

/**
 * Play the break on `card` (an element whose background is the sealed art).
 * `swap` turns it to the opened face; it is called at the moment of the flash.
 * `done` runs when the sequence has finished.
 */
export function playSealBreak(card: HTMLElement, swap: () => void, done?: () => void): void {
  ensureStyles();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    card.classList.add('sb-fade');
    window.setTimeout(() => { swap(); card.classList.remove('sb-fade'); done?.(); }, 250);
    return;
  }
  const W = card.offsetWidth, H = card.offsetHeight;
  const layer = document.createElement('div');
  layer.className = 'sb-layer';
  card.appendChild(layer);

  // 1. Tremble, and a crack across the wax.
  card.classList.add('sb-tremble');
  const crackPts = crackLine(W, H);
  layer.innerHTML = `<svg class="sb-crack" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <polyline points="${crackPts.map(p => p.join(',')).join(' ')}" /></svg>`;

  window.setTimeout(() => {
    card.classList.remove('sb-tremble');
    // 2. The break.
    const flash = document.createElement('div');
    flash.className = 'sb-flash';
    flash.style.setProperty('--sx', `${SEAL.cx * 100}%`);
    flash.style.setProperty('--sy', `${SEAL.cy * 100}%`);
    layer.querySelector('.sb-crack')?.remove();
    // The face changes first (swap may rewrite the card's contents), then the
    // layer goes back on top. The halves are cut from the sealed art, so they
    // still match the seal that was there.
    swap();
    card.appendChild(layer);
    // The opened art may be another size: keep the layer the sealed card's
    // size, centred on the card, so the halves sit where the seal was.
    layer.style.inset = 'auto';
    layer.style.width = `${W}px`;
    layer.style.height = `${H}px`;
    layer.style.left = `${(card.offsetWidth - W) / 2}px`;
    layer.style.top = `${(card.offsetHeight - H) / 2}px`;
    layer.appendChild(flash);
    layer.appendChild(half(W, H, crackPts, 'left'));
    layer.appendChild(half(W, H, crackPts, 'right'));
    for (let i = 0; i < 30; i++) layer.appendChild(spark(W, H, i));
    card.classList.add('sb-reveal');
    const rise = document.createElement('div');
    rise.className = 'sb-rise';
    layer.appendChild(rise);
  }, TREMBLE_MS);

  window.setTimeout(() => {
    card.classList.remove('sb-reveal');
    layer.remove();
    done?.();
  }, DONE_MS);
}

/** A jagged crack down through the seal, in card pixels (top to bottom). */
function crackLine(W: number, H: number): Array<[number, number]> {
  const cx = SEAL.cx * W, cy = SEAL.cy * H, r = SEAL.r * W;
  const pts: Array<[number, number]> = [];
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const y = cy - r + (2 * r * i) / steps;
    const jag = i === 0 || i === steps ? 0 : (i % 2 ? 1 : -1) * r * (0.12 + Math.random() * 0.1);
    pts.push([Math.round(cx + jag), Math.round(y)]);
  }
  return pts;
}

/** One half of the seal: the sealed art clipped to a half-disc on one side of the crack. */
function half(W: number, H: number, crack: Array<[number, number]>, side: 'left' | 'right'): HTMLElement {
  const cx = SEAL.cx * W, cy = SEAL.cy * H, r = SEAL.r * W;
  const arc: Array<[number, number]> = [];
  // From the bottom of the crack, round the outside of the disc to its top.
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI / 2 + (side === 'left' ? 1 : -1) * (Math.PI * i) / 16;
    arc.push([cx + Math.cos(a) * r * 1.04, cy + Math.sin(a) * r * 1.04]);
  }
  const poly = [...arc, ...crack].map(([x, y]) => `${((x / W) * 100).toFixed(2)}% ${((y / H) * 100).toFixed(2)}%`).join(',');
  const el = document.createElement('div');
  el.className = `sb-half ${side}`;
  el.style.backgroundImage = `url(${SEALED_ART})`;
  el.style.clipPath = `polygon(${poly})`;
  el.style.transformOrigin = `${SEAL.cx * 100}% ${SEAL.cy * 100}%`;
  return el;
}

/** A gold or green spark flying out from the seal. */
function spark(W: number, H: number, i: number): HTMLElement {
  const a = (i / 30) * Math.PI * 2 + Math.random() * 0.4;
  const d = W * (0.35 + Math.random() * 0.55);
  const el = document.createElement('span');
  el.className = `sb-spark${i % 4 === 0 ? ' green' : ''}`;
  el.style.left = `${SEAL.cx * W}px`;
  el.style.top = `${SEAL.cy * H}px`;
  el.style.setProperty('--dx', `${Math.cos(a) * d}px`);
  el.style.setProperty('--dy', `${Math.sin(a) * d - H * 0.08}px`);
  el.style.setProperty('--t', `${600 + Math.random() * 500}ms`);
  el.style.setProperty('--s', `${3 + Math.floor(Math.random() * 3)}px`);
  return el;
}

const SB_CSS = `
.sb-layer{position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:3}
.sb-tremble{animation:sbTremble ${TREMBLE_MS}ms linear both !important}
@keyframes sbTremble{
  0%{transform:translate(0,0) rotate(0);filter:drop-shadow(0 0 14px rgba(255,200,70,.45))}
  15%{transform:translate(-2px,1px) rotate(-.6deg)}
  30%{transform:translate(2px,-1px) rotate(.7deg)}
  45%{transform:translate(-3px,0) rotate(-.9deg)}
  60%{transform:translate(3px,1px) rotate(1deg);filter:drop-shadow(0 0 30px rgba(255,220,110,.9))}
  75%{transform:translate(-4px,-1px) rotate(-1.2deg)}
  90%{transform:translate(4px,1px) rotate(1.3deg)}
  100%{transform:translate(0,0) scale(1.04);filter:drop-shadow(0 0 46px rgba(255,235,150,1))}}
.sb-crack{position:absolute;left:0;top:0;overflow:visible}
.sb-crack polyline{fill:none;stroke:#fff6d0;stroke-width:2.5;stroke-linejoin:miter;
  filter:drop-shadow(0 0 4px #ffe08a);stroke-dasharray:400;stroke-dashoffset:400;animation:sbCrack ${TREMBLE_MS}ms ease-in forwards}
@keyframes sbCrack{to{stroke-dashoffset:0}}
.sb-flash{position:absolute;inset:-30%;background:radial-gradient(circle at var(--sx) var(--sy),rgba(255,255,240,1) 0%,rgba(255,236,160,.85) 18%,rgba(255,200,80,.25) 40%,transparent 62%);
  animation:sbFlash 520ms ease-out forwards}
@keyframes sbFlash{0%{opacity:1;transform:scale(.6)}100%{opacity:0;transform:scale(1.3)}}
.sb-half{position:absolute;inset:0;background-size:100% 100%;image-rendering:pixelated}
.sb-half.left{animation:sbHalfL 950ms cubic-bezier(.2,.7,.4,1) forwards}
.sb-half.right{animation:sbHalfR 950ms cubic-bezier(.2,.7,.4,1) forwards}
@keyframes sbHalfL{0%{transform:translate(0,0) rotate(0);opacity:1}65%{opacity:1}100%{transform:translate(-70%,34%) rotate(-48deg);opacity:0}}
@keyframes sbHalfR{0%{transform:translate(0,0) rotate(0);opacity:1}65%{opacity:1}100%{transform:translate(70%,38%) rotate(52deg);opacity:0}}
.sb-spark{position:absolute;width:var(--s);height:var(--s);margin:-1px 0 0 -1px;background:#ffe08a;box-shadow:0 0 6px #ffc94a;
  animation:sbSpark var(--t) cubic-bezier(.15,.7,.3,1) forwards}
.sb-spark.green{background:#b6ff9a;box-shadow:0 0 6px #6edc98}
@keyframes sbSpark{0%{transform:translate(0,0);opacity:1}80%{opacity:1}100%{transform:translate(var(--dx),var(--dy));opacity:0}}
.sb-reveal{animation:sbReveal 950ms cubic-bezier(.2,.8,.3,1) both !important}
@keyframes sbReveal{0%{transform:scale(1.08);filter:brightness(1.8) drop-shadow(0 0 40px rgba(180,255,170,.9))}
  100%{transform:scale(1);filter:brightness(1) drop-shadow(0 0 18px rgba(255,210,90,.6))}}
.sb-rise{position:absolute;left:30%;right:30%;top:20%;bottom:30%;
  background:radial-gradient(ellipse at 50% 70%,rgba(160,255,150,.55),transparent 65%);animation:sbRise 950ms ease-out forwards}
@keyframes sbRise{0%{opacity:0;transform:translateY(10%) scaleY(.6)}40%{opacity:1}100%{opacity:0;transform:translateY(-14%) scaleY(1.3)}}
.sb-fade{transition:opacity .25s;opacity:.2}
`;
function ensureStyles(): void {
  if (document.getElementById('seal-break-css')) return;
  const st = document.createElement('style');
  st.id = 'seal-break-css';
  st.textContent = SB_CSS;
  document.head.appendChild(st);
}
