/**
 * The cosmic web: gas filaments threading the galaxies, with dwarf knots where
 * smaller threads meet. Pure geometry, shared by the Big Bang cinematic (where
 * the web gathers the first galaxies) and the universe view (where it stays as
 * the large-scale structure the galaxies sit on).
 *
 * Nodes are the real galaxies plus a seeded scatter of dwarf knots; edges join
 * each node to its nearest neighbours. Everything is seeded from the galaxies
 * themselves, so a universe keeps the same web for its whole life.
 */

import type { Galaxy } from '../simulation/BigBangEngine';

export interface WebNode { x: number; y: number; real: Galaxy | null; }
/** [from node, to node, bend in -0.5..0.5]. */
export type WebEdge = [number, number, number];
export interface CosmicWeb { key: string; nodes: WebNode[]; edges: WebEdge[]; spread: number; }

export function webHash(n: number): number {
  let x = (n | 0) * 374761393;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Build (or reuse, when the live galaxies are unchanged) the web around centre C. */
export function buildCosmicWeb(galaxies: Galaxy[], C: number, prev: CosmicWeb | null = null, extra = 26): CosmicWeb {
  // Simulated galaxies with systems, and dormant ones (other sectors) by size.
  const live = galaxies.filter(gl => gl.starIds.length > 0 || ((gl as { systems?: number }).systems ?? 0) > 0);
  const key = live.map(gl => gl.id).join(',');
  if (prev && prev.key === key) {
    // Galaxies drift a little as their systems orbit: keep the knots on them.
    for (const nd of prev.nodes) if (nd.real) { nd.x = nd.real.cx; nd.y = nd.real.cy; }
    return prev;
  }
  // Knots scatter around the galaxies' own middle (home can be a corner of
  // the universe); C is the fallback when there are none.
  let mx = C, my = C;
  if (live.length) { mx = live.reduce((a, g) => a + g.cx, 0) / live.length; my = live.reduce((a, g) => a + g.cy, 0) / live.length; }
  let spread = 600;
  for (const gl of live) spread = Math.max(spread, Math.hypot(gl.cx - mx, gl.cy - my));
  const nodes: WebNode[] = live.map(gl => ({ x: gl.cx, y: gl.cy, real: gl }));
  // 32-bit: with dozens of galaxies a plain s*31 runs past float precision
  // and every knot hashed to the same spot.
  const seed = live.reduce((s, gl) => (Math.imul(s, 31) + gl.id) | 0, 7);
  for (let i = 0; i < extra; i++) {
    const a = webHash(seed + i * 11) * Math.PI * 2;
    const r = Math.sqrt(webHash(seed + i * 11 + 5)) * spread * 1.45;
    nodes.push({ x: mx + Math.cos(a) * r, y: my + Math.sin(a) * r, real: null });
  }
  const edges: WebEdge[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const near = nodes.map((nd, j) => ({ j, d: Math.hypot(nd.x - nodes[i].x, nd.y - nodes[i].y) }))
      .filter(o => o.j !== i).sort((p, q) => p.d - q.d).slice(0, nodes[i].real ? 4 : 3);
    for (const o of near) {
      const k = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
      if (seen.has(k) || o.d > spread * 1.3) continue;
      seen.add(k);
      edges.push([i, o.j, webHash(seed + edges.length * 13) - 0.5]);
    }
  }
  return { key, nodes, edges, spread };
}

/**
 * Points along a thread in world space: a bent curve with a slow wobble, so it
 * reads as gas rather than wire. `flow` (seconds) animates the wobble.
 */
export function threadPoints(web: CosmicWeb, edge: WebEdge, flow: number, seg = 22): Array<[number, number]> {
  const [i, j, bend] = edge;
  const A = web.nodes[i], B = web.nodes[j];
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const dx = B.x - A.x, dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 1;
  const qx = mx - dy * bend * 0.45, qy = my + dx * bend * 0.45;
  const pts: Array<[number, number]> = [];
  for (let s = 0; s <= seg; s++) {
    const u = s / seg, iu = 1 - u;
    const wob = Math.sin(u * Math.PI) * Math.sin(u * 9.4 + bend * 20 + flow * 0.35) * len * 0.035;
    pts.push([
      iu * iu * A.x + 2 * iu * u * qx + u * u * B.x - dy / len * wob,
      iu * iu * A.y + 2 * iu * u * qy + u * u * B.y + dx / len * wob,
    ]);
  }
  return pts;
}

/** Which way matter streams along a thread: toward the galaxy it feeds. */
export function flowsToB(web: CosmicWeb, edge: WebEdge): boolean {
  const A = web.nodes[edge[0]], B = web.nodes[edge[1]];
  if (B.real && !A.real) return true;
  if (A.real && !B.real) return false;
  return webHash(edge[0] * 31 + edge[1]) < 0.5;
}
