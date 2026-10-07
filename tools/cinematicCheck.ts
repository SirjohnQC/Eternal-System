/**
 * The Big Bang cinematic (BigBangCinematic + the engine's director).
 *
 * Checks that the opening tour is only a camera and a clock:
 *   - the timeline is sane and the Big Bang's ticks fit inside it, settling
 *     before the dive;
 *   - a universe born under the cinematic is IDENTICAL, tick for tick, to one
 *     born without it (same seed);
 *   - it ends exactly once, by running out or by Skip, handing play the home
 *     world at planet zoom;
 *   - every reveal factor stays in 0..1 and keeps its beat;
 *   - once the dive zooms past the galaxy tier the camera is on the home star
 *     (the old settle zoom crossed fog and showed a black screen).
 *
 * Build + run:
 *   node_modules/.bin/esbuild tools/cinematicCheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/cine.mjs --log-level=error && node /tmp/cine.mjs
 *
 * Exits non-zero if any check fails.
 */
const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData' || prop === 'createImageData') {
      return (a: number, b: number, w = 1, h = 1) =>
        ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});

function makeCanvas(): any {
  return {
    width: 1200, height: 800, style: {},
    getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  };
}

const g = globalThis as any;
g.document = {
  createElement: () => makeCanvas(),
  getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {},
};
g.window = g;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.eternalSpeed = 60;

const { BigBangEngine } = await import('../src/simulation/BigBangEngine');
const { BigBangCinematic, CINE_BEATS, CINE_TOTAL, CINE_RELEASE, CINE_BANG_TICKS, beatStart } =
  await import('../src/simulation/BigBangCinematic');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const STATS = { life: 15, evolution: 13, hostility: 12, entropy: 11, divine: 10 };
const SEED = 'cinematic_check';
function makeEngine(): any {
  const e: any = new BigBangEngine(makeCanvas());
  e.init(STATS, SEED);
  return e;
}
function snapshot(e: any): string {
  return JSON.stringify({
    tick: e.tick, phase: e.phase,
    stars: e.stars.map((s: any) => [s.id, +s.x.toFixed(6), +s.y.toFixed(6), s.planets.length, s.hasLife, s.galaxyId, s.isDead]),
    galaxies: e.currentGalaxies.map((g: any) => [g.id, +g.cx.toFixed(4), +g.cy.toFixed(4), g.starIds.length]),
  });
}

// ── 1. Timeline ─────────────────────────────────────────────────────────────
check('total length is ~40 s', CINE_TOTAL >= 38 && CINE_TOTAL <= 48, `${CINE_TOTAL}s`);
check('beats in story order', CINE_BEATS.map(b => b.stage).join() ===
  'singularity,bang,plasma,cooling,firstStars,web,galaxies,dive,ignition,world');
check('simulation released before the first stars', CINE_RELEASE < beatStart('firstStars') && CINE_RELEASE > beatStart('cooling'));
{
  const c = new BigBangCinematic();
  let prev = -1, mono = true, zeroBefore = true;
  for (let t = 0; t <= CINE_TOTAL; t += 0.05) {
    c.t = t;
    const k = c.targetTicks;
    if (k < prev) mono = false;
    if (t < CINE_RELEASE && k !== 0) zeroBefore = false;
    prev = k;
  }
  c.t = beatStart('dive');
  check('Big Bang ticks never run backwards', mono);
  check('no ticks before release', zeroBefore);
  check('Big Bang settled before the dive', c.targetTicks === CINE_BANG_TICKS, `${c.targetTicks}/${CINE_BANG_TICKS}`);
}

// ── 2. Same universe with or without the cinematic ─────────────────────────
const plain = makeEngine();
let guard = 0;
while (plain.tick < CINE_BANG_TICKS && guard++ < 10_000) plain.update();
const toured = makeEngine();
toured.cinematic = new BigBangCinematic();
let ends = 0;
toured.onCinematicEnd = () => { ends++; };
guard = 0;
while (toured.tick < CINE_BANG_TICKS && guard++ < 10_000) toured.update();
check('both reach the settle tick', plain.tick === CINE_BANG_TICKS && toured.tick === CINE_BANG_TICKS, `${plain.tick} / ${toured.tick}`);
check('cinematic universe identical to the plain one', snapshot(plain) === snapshot(toured));
check('settled while the tour is still playing', toured.phase === 'settled' && toured.cinematicActive);

// ── 3. Natural end ─────────────────────────────────────────────────────────
guard = 0;
while (toured.cinematicActive && guard++ < 10_000) toured.update();
for (let i = 0; i < 30; i++) toured.update();
const cam = toured.currentCamera;
check('runs out and ends exactly once', !toured.cinematicActive && ends === 1, `ends=${ends}`);
check('hands over at planet zoom on the home world', Math.abs(cam.scale - 8.5) < 0.2, `scale ${cam.scale.toFixed(2)}`);
check('all layers fully shown after', toured.galaxyReveal === 1 && toured.homeStarLight === 1 && toured.planetsReveal === 1);

// ── 4. Skip ────────────────────────────────────────────────────────────────
const skipped = makeEngine();
skipped.cinematic = new BigBangCinematic();
let skipEnds = 0;
skipped.onCinematicEnd = () => { skipEnds++; };
for (let i = 0; i < 90; i++) skipped.update();
skipped.skipCinematic();
skipped.skipCinematic();
for (let i = 0; i < 5; i++) skipped.update();
check('skip settles the universe at once', skipped.phase === 'settled' && skipped.tick >= CINE_BANG_TICKS, `${skipped.phase} @${skipped.tick}`);
check('skip ends exactly once', skipEnds === 1 && !skipped.cinematicActive, `ends=${skipEnds}`);
check('skip lands on the home world at planet zoom', Math.abs(skipped.currentCamera.scale - 8.5) < 0.2, `scale ${skipped.currentCamera.scale.toFixed(2)}`);

// ── 5. Reveal factors ─────────────────────────────────────────────────────
{
  const c = new BigBangCinematic();
  let inRange = true, galEarly = 0, sunEarly = 1, planetsEarly = 0;
  for (let t = 0; t < CINE_TOTAL; t += 0.05) {
    c.t = t;
    for (const v of [c.galaxyReveal, c.homeStarLight, c.planetsReveal, c.fog]) if (!(v >= 0 && v <= 1)) inRange = false;
    if (t < beatStart('web')) galEarly = Math.max(galEarly, c.galaxyReveal);
    if (t < beatStart('ignition')) sunEarly = Math.min(sunEarly, 1 - c.homeStarLight);
    if (t < beatStart('world') - 0.6) planetsEarly = Math.max(planetsEarly, c.planetsReveal);
  }
  check('reveal factors stay in 0..1', inRange);
  check('no galaxy art before the web', galEarly === 0, `${galEarly}`);
  check('home sun dim until it ignites', sunEarly > 0.8, `${(1 - sunEarly).toFixed(2)}`);
  check('home worlds hidden until they condense', planetsEarly === 0);
}

// ── 6. Camera: on the home star once the dive passes the galaxy tier ───────
{
  const e = makeEngine();
  e.cinematic = new BigBangCinematic();
  let worst = 0, nan = false;
  for (let t = 0; t < CINE_TOTAL - 0.01; t += 0.1) {
    e.seekCinematic(t);
    const c = e.currentCamera;
    if (![c.x, c.y, c.scale].every(Number.isFinite)) nan = true;
    if (t >= beatStart('dive') && c.scale >= 1.8) {
      const ps = e.getPlayerStar();
      // Distance in screen pixels between the view centre and the home star,
      // allowing for the world beat's glide onto the home planet.
      const hw = e.homeWorld(ps);
      const reach = (hw ? hw.orbitalRadius : 0) * 1.1 + 2;
      const d = Math.max(0, Math.hypot(c.x - ps.x, c.y - ps.y) - reach) * c.scale;
      worst = Math.max(worst, d);
    }
  }
  check('camera always finite', !nan);
  check('past the galaxy tier the home system is centred', worst < 40, `${worst.toFixed(1)}px off`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall cinematic checks passed');
process.exit(failures ? 1 : 0);
