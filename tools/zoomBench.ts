/**
 * Browser frame-budget bench for the zoom camera (spec 5b): headless Microsoft
 * Edge over the Chrome DevTools Protocol, no npm dependencies (Node's global
 * WebSocket and fetch).
 *
 * Usage:
 *   1. Start a dev server on a free port (3000 may be taken):
 *        node_modules/.bin/vite --port 3017 --strictPort
 *   2. Build and run this driver; it launches Edge itself and kills it after:
 *        node_modules/.bin/esbuild tools/zoomBench.ts --bundle --platform=node --format=esm \
 *          --outfile="$TEMP/zoomBench.mjs" --log-level=error
 *        node "$TEMP/zoomBench.mjs" --url http://localhost:3017/diorama-preview.html?type=ocean&seed=3 \
 *          [--runs 3] [--dragMs 3000] [--tailMs 1500] [--ampX 260] [--ampY 120] [--port 9333]
 *          [--edge "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"] [--size 1280,800]
 * The page must install `window.__zoomBench` (src/dev/zoomBench.ts; the diorama
 * preview does). Prints one JSON result per run and a summary line; exits 1
 * when any run has a frame over 33 ms (`--budget` changes the bar).
 * `--eval "<js>"` evaluates one expression (awaited) instead and prints it.
 * Headless frame times are indicative, not a real display's.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const url = args.get('url') ?? 'http://localhost:3017/diorama-preview.html';
const port = Number(args.get('port') ?? 9333);
const runs = Number(args.get('runs') ?? 3);
const budget = Number(args.get('budget') ?? 33);
const edge = args.get('edge') ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const size = args.get('size') ?? '1280,800';
const benchOpts = {
  dragMs: Number(args.get('dragMs') ?? 3000), tailMs: Number(args.get('tailMs') ?? 1500),
  ampX: Number(args.get('ampX') ?? 260), ampY: Number(args.get('ampY') ?? 120),
};

const profile = mkdtempSync(join(tmpdir(), 'edge-zoom-'));
const proc = spawn(edge, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${size}`, '--no-first-run', '--disable-extensions', url,
], { stdio: 'ignore' });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function pageWs(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const p = list.find(t => t.type === 'page' && t.url.includes('diorama'));
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('no page target');
}

let ws: WebSocket | null = null;
try {
  ws = new WebSocket(await pageWs());
  await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = e => rej(e); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
  const send = (method: string, params: object) => new Promise<any>(res => { const i = ++id; pending.set(i, res); ws!.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression: string) => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 600));
    return m.result?.result?.value;
  };
  // Wait for the page and the hook.
  for (let i = 0; i < 150; i++) {
    if (await evaluate('typeof window.__zoomBench === "function" && !!window.__diorama')) break;
    await sleep(200);
  }
  await sleep(1500);   // first bake, decal atlas
  const expr = args.get('eval');
  if (expr) { console.log(JSON.stringify(await evaluate(expr))); process.exitCode = 0; }
  let worst = 0;
  for (let k = 0; expr ? false : k < runs; k++) {
    const res = await evaluate(`window.__zoomBench(${JSON.stringify(benchOpts)})`);
    console.log(JSON.stringify(res));
    worst = Math.max(worst, res?.max ?? Infinity);
  }
  if (!expr) console.log(`worst frame over ${runs} runs: ${worst.toFixed(1)} ms (budget ${budget} ms)`);
  if (!expr) process.exitCode = worst > budget ? 1 : 0;
} finally {
  try { ws?.close(); } catch { /* closed */ }
  proc.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold it */ }
}
