// src/simulation/BiosphereRenderer.ts
import { SeedRNG } from '../utils/SeedRNG';
import { SpeciesGenome, PlanetBiosphere } from './SpeciesGenome';

// ── Color + size maps ─────────────────────────────────────────────────────────

const ENV_COLORS: Record<string, [number, number, number]> = {
  ocean:    [26,  74, 110],
  deep_sea: [10,  32,  48],
  coastal:  [42, 122,  78],
  land:     [74, 110,  42],
  aerial:   [110, 138, 170],
};

const SIZE_RADIUS: Record<string, number> = {
  microscopic: 3,
  tiny:        5,
  small:       7,
  medium:      9,
  large:       12,
  massive:     16,
};

function envRgb(env: string): string {
  const c = ENV_COLORS[env] ?? [68, 102, 68];
  return `${c[0]},${c[1]},${c[2]}`;
}

// ── Trait → pattern resolver ───────────────────────────────────────────────────

type TerrainPattern =
  | 'branching_network'   // fungal / root-like (stationary land, decomposer)
  | 'plant_canopy'        // photosynthetic land
  | 'crawl_trails'        // crawling land
  | 'walk_territory'      // walking land
  | 'aerial_arcs'         // flying
  | 'ocean_blooms'        // photosynthetic ocean (cyanobacteria)
  | 'swim_currents'       // swimming ocean
  | 'bioluminescence'     // deep sea
  | 'coastal_algae'       // photosynthetic coastal
  | 'none';               // too simple / microscopic / unclassified

function getTerrainPattern(sp: SpeciesGenome): TerrainPattern {
  const { environment, locomotion, diet, metabolism } = sp.dna;

  if (locomotion === 'flying') return 'aerial_arcs';

  switch (environment) {
    case 'land':
      if (locomotion === 'stationary' || diet === 'decomposer') return 'branching_network';
      if (metabolism === 'photosynthetic')                       return 'plant_canopy';
      if (locomotion === 'crawling')                             return 'crawl_trails';
      if (locomotion === 'walking')                              return 'walk_territory';
      return 'none';

    case 'ocean':
      if (metabolism === 'photosynthetic') return 'ocean_blooms';
      if (locomotion === 'swimming')       return 'swim_currents';
      return 'none';

    case 'coastal':
      if (metabolism === 'photosynthetic') return 'coastal_algae';
      return 'none';

    case 'deep_sea':
      return 'bioluminescence';

    default:
      return 'none';
  }
}

// ── World-space terrain layer (1200×600 coords) ───────────────────────────────

export function drawBiosphereTerrainLayer(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  tick:    number,
  species: SpeciesGenome[],
  bio:     PlanetBiosphere,
  seedId:  number,
): void {
  const active = species.filter(s => !s.isExtinct);

  ctx.save();

  // 1. Biome zone blobs (background color zones per species — always drawn)
  drawBiomeBlobs(ctx, W, H, active, new SeedRNG(`bio_blobs_${seedId}`));

  // 2. Per-species terrain pattern (derived from actual traits)
  for (const sp of active) {
    const pattern = getTerrainPattern(sp);
    if (pattern === 'none') continue;
    const spRng = new SeedRNG(`bio_pat_${seedId}_${sp.id}`);
    drawTerrainPattern(ctx, W, H, tick, sp, pattern, spRng);
  }

  // 3. Species sprites (on top of patterns — trait-driven creature silhouettes)
  drawSpeciesSprites(ctx, W, H, active, new SeedRNG(`bio_markers_${seedId}`), tick);

  // Suppress unused warning for bio parameter
  void bio;

  ctx.restore();
}

function drawTerrainPattern(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  tick:    number,
  sp:      SpeciesGenome,
  pattern: TerrainPattern,
  rng:     SeedRNG,
): void {
  const col = ENV_COLORS[sp.dna.environment] ?? [68, 102, 68];
  const alpha = Math.min(0.30, sp.population * 0.32);
  const count = Math.floor(sp.population * 14) + 3;

  switch (pattern) {

    case 'branching_network': {
      ctx.strokeStyle = `rgba(${col[0]+60},${col[1]+60},${col[2]+40},${alpha + 0.05})`;
      ctx.lineWidth   = 0.8;
      for (let i = 0; i < count; i++) {
        const sx = rng.nextFloat(W * 0.35, W * 0.95);
        const sy = rng.nextFloat(H * 0.08, H * 0.92);
        drawBranch(ctx, sx, sy, rng.nextFloat(-90, 90), 50, 4, rng);
      }
      break;
    }

    case 'plant_canopy': {
      for (let i = 0; i < count; i++) {
        const cx = rng.nextFloat(W * 0.35, W * 0.95);
        const cy = rng.nextFloat(H * 0.08, H * 0.92);
        const r  = rng.nextFloat(8, 22) * sp.population;
        ctx.fillStyle   = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
        ctx.strokeStyle = `rgba(${col[0]+40},${col[1]+60},${col[2]},${alpha * 0.6})`;
        ctx.lineWidth   = 0.7;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        for (let s = 0; s < 6; s++) {
          const a = (s / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          ctx.lineTo(cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10));
          ctx.stroke();
        }
      }
      break;
    }

    case 'crawl_trails': {
      ctx.fillStyle = `rgba(${col[0]+30},${col[1]+20},${col[2]},${alpha + 0.08})`;
      for (let i = 0; i < count * 4; i++) {
        const x = rng.nextFloat(W * 0.30, W * 0.95);
        const y = rng.nextFloat(H * 0.08, H * 0.92);
        ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }

    case 'walk_territory': {
      ctx.strokeStyle = `rgba(${col[0]+50},${col[1]+40},${col[2]},${alpha + 0.06})`;
      ctx.lineWidth   = 1.2;
      for (let i = 0; i < count; i++) {
        const sx = rng.nextFloat(W * 0.30, W * 0.95);
        const sy = rng.nextFloat(H * 0.08, H * 0.92);
        const ex = sx + rng.nextFloat(-60, 60);
        const ey = sy + rng.nextFloat(-40, 40);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      }
      break;
    }

    case 'aerial_arcs': {
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha * 0.7})`;
      ctx.lineWidth   = 0.8;
      for (let i = 0; i < count; i++) {
        const sx  = rng.nextFloat(0, W);
        const sy  = rng.nextFloat(0, H);
        const cpx = rng.nextFloat(0, W);
        const cpy = rng.nextFloat(0, H * 0.5);
        const ex  = rng.nextFloat(0, W);
        const ey  = rng.nextFloat(0, H);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cpx, cpy, ex, ey); ctx.stroke();
      }
      break;
    }

    case 'ocean_blooms': {
      for (let i = 0; i < count; i++) {
        const cx    = rng.nextFloat(0, W * 0.50);
        const cy    = rng.nextFloat(H * 0.05, H * 0.95);
        const r     = rng.nextFloat(18, 55);
        const pulse = 0.5 + 0.5 * Math.sin(tick * 0.05 + i + sp.id.length);
        const grad  = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `rgba(${col[0]+20},${col[1]+80},${col[2]+60},${0.35 * pulse})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }

    case 'swim_currents': {
      ctx.strokeStyle = `rgba(${col[0]+30},${col[1]+50},${col[2]+80},${alpha * 0.8})`;
      ctx.lineWidth   = 0.7;
      for (let i = 0; i < count; i++) {
        const cx = rng.nextFloat(0, W * 0.55);
        const cy = rng.nextFloat(H * 0.05, H * 0.95);
        const r  = rng.nextFloat(15, 45);
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 3; a += 0.2) {
          const spiral = r * (1 - a / (Math.PI * 3));
          const x = cx + Math.cos(a) * spiral;
          const y = cy + Math.sin(a) * spiral;
          a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }

    case 'bioluminescence': {
      for (let i = 0; i < count * 5; i++) {
        const x     = rng.nextFloat(0, W * 0.45);
        const y     = rng.nextFloat(0, H);
        const pulse = 0.4 + 0.6 * Math.sin(tick * 0.04 + i * 0.7);
        ctx.fillStyle = `rgba(${col[0]+40},${col[1]+100},${col[2]+120},${pulse * 0.55})`;
        ctx.beginPath(); ctx.arc(x, y, rng.nextFloat(1, 3), 0, Math.PI * 2); ctx.fill();
      }
      break;
    }

    case 'coastal_algae': {
      for (let i = 0; i < count; i++) {
        const cx = rng.nextFloat(W * 0.35, W * 0.55);
        const cy = rng.nextFloat(H * 0.05, H * 0.95);
        const rx = rng.nextFloat(12, 40);
        const ry = rng.nextFloat(8, 24);
        ctx.fillStyle = `rgba(${col[0]},${col[1]+40},${col[2]},${alpha + 0.05})`;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, rng.nextFloat(0, Math.PI), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
}

function drawBranch(
  ctx:    CanvasRenderingContext2D,
  x:      number,
  y:      number,
  angle:  number,
  length: number,
  depth:  number,
  rng:    SeedRNG,
): void {
  if (depth <= 0 || length < 5) return;
  const rad  = (angle * Math.PI) / 180;
  const endX = x + Math.cos(rad) * length;
  const endY = y + Math.sin(rad) * length;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  drawBranch(ctx, endX, endY, angle + rng.nextFloat(20, 50), length * 0.6, depth - 1, rng);
  drawBranch(ctx, endX, endY, angle - rng.nextFloat(20, 50), length * 0.6, depth - 1, rng);
}

function drawBiomeBlobs(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  rng:     SeedRNG,
): void {
  for (const sp of species) {
    const alpha = Math.min(0.30, sp.population * 0.35);
    if (alpha < 0.02) continue;

    ctx.fillStyle = `rgba(${envRgb(sp.dna.environment)},${alpha})`;
    const cx = rng.nextFloat(W * 0.05, W * 0.95);
    const cy = rng.nextFloat(H * 0.10, H * 0.90);
    const rx = rng.nextFloat(40, 120) * sp.population;
    const ry = rng.nextFloat(30,  80) * sp.population;

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rng.nextFloat(0, Math.PI), 0, Math.PI * 2);
    ctx.fill();

    if (sp.population > 0.45) {
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.font      = '9px Cinzel, serif';
      ctx.textAlign = 'center';
      ctx.fillText(sp.name.slice(0, 14), cx, cy + 4);
    }
  }
}

function drawSpeciesSprites(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  rng:     SeedRNG,
  tick:    number,
): void {
  if (species.length === 0) return;
  const maxPop = Math.max(...species.map(s => s.population));

  for (const sp of species) {
    const cx = rng.nextFloat(W * 0.05, W * 0.95);
    const cy = rng.nextFloat(H * 0.10, H * 0.90);
    const baseR = SIZE_RADIUS[sp.physicalTraits.size] ?? 6;

    if (sp.population === maxPop) {
      const pulse = 0.5 + 0.5 * Math.sin(tick * 0.06 + sp.id.length);
      const col   = ENV_COLORS[sp.dna.environment] ?? [68, 102, 68];
      const grad  = ctx.createRadialGradient(cx, cy, baseR, cx, cy, baseR * 3);
      grad.addColorStop(0, `rgba(${col[0]+60},${col[1]+80},${col[2]+40},${0.25 * pulse})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    drawSpeciesSprite(ctx, sp, cx, cy, baseR, tick);
  }
}

function drawSpeciesSprite(
  ctx:   CanvasRenderingContext2D,
  sp:    SpeciesGenome,
  cx:    number,
  cy:    number,
  baseR: number,
  tick:  number,
): void {
  const col   = ENV_COLORS[sp.dna.environment] ?? [68, 102, 68];
  const pulse = 0.92 + 0.08 * Math.sin(tick * 0.08 + sp.id.length);
  const r     = baseR * pulse;
  const { bodyStructure, mobilityType, sensorySystem } = sp.physicalTraits;

  ctx.fillStyle   = `rgb(${col[0]},${col[1]},${col[2]})`;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth   = 0.8;

  // ── Body ──────────────────────────────────────────────────────────────────
  if (bodyStructure === 'single-celled') {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  } else if (bodyStructure === 'segmented') {
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(cx + (i - 1) * r * 0.9, cy, r * 0.6, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }

  } else {
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.2, r * 0.7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + r * 1.3, cy, r * 0.42, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  // ── Mobility appendages ───────────────────────────────────────────────────
  ctx.strokeStyle = `rgba(${col[0]+50},${col[1]+50},${col[2]+50},0.6)`;
  ctx.lineWidth   = 0.6;

  if (mobilityType === 'flagella') {
    for (let i = 0; i < 3; i++) {
      const a = Math.PI + (i - 1) * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r,       cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * r * 2.4, cy + Math.sin(a) * r * 1.5);
      ctx.stroke();
    }

  } else if (mobilityType === 'fins') {
    ctx.fillStyle = `rgba(${col[0]+30},${col[1]+30},${col[2]+30},0.45)`;
    ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.4); ctx.lineTo(cx - r * 0.7, cy - r * 1.4); ctx.lineTo(cx + r * 0.4, cy - r * 0.4); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx, cy + r * 0.4); ctx.lineTo(cx - r * 0.7, cy + r * 1.4); ctx.lineTo(cx + r * 0.4, cy + r * 0.4); ctx.closePath(); ctx.fill();

  } else if (mobilityType === 'legs' || mobilityType === 'undulation') {
    const legCount = mobilityType === 'undulation' ? 6 : (sp.dna.social > 5 ? 4 : 6);
    for (let i = 0; i < legCount; i++) {
      const a = ((i / legCount) * Math.PI) + Math.PI * 0.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
      ctx.lineTo(cx + Math.cos(a) * r * 1.9, cy + Math.sin(a) * r * 1.6);
      ctx.stroke();
    }

  } else if (mobilityType === 'wings') {
    ctx.fillStyle   = `rgba(${col[0]+30},${col[1]+50},${col[2]+30},0.20)`;
    ctx.strokeStyle = `rgba(${col[0]+60},${col[1]+80},${col[2]+60},0.5)`;
    ctx.lineWidth   = 0.7;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx - r * 2, cy - r * 1.5, cx - r * 3, cy + r * 0.5); ctx.lineTo(cx, cy); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx + r * 2, cy - r * 1.5, cx + r * 3, cy + r * 0.5); ctx.lineTo(cx, cy); ctx.fill(); ctx.stroke();
  }

  // ── Sensory organs ────────────────────────────────────────────────────────
  const headX = bodyStructure === 'vertebrate' ? cx + r * 1.3
              : bodyStructure === 'segmented'  ? cx + r
              : cx;

  if (sensorySystem === 'vision') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(headX, cy - r * 0.22, r * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(headX, cy + r * 0.22, r * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.beginPath(); ctx.arc(headX + r * 0.05, cy - r * 0.22, r * 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(headX + r * 0.05, cy + r * 0.22, r * 0.08, 0, Math.PI * 2); ctx.fill();

  } else if (sensorySystem === 'chemoreception') {
    ctx.strokeStyle = `rgba(${col[0]+80},${col[1]+80},${col[2]+80},0.65)`;
    ctx.lineWidth   = 0.5;
    ctx.beginPath(); ctx.moveTo(headX, cy - r * 0.25); ctx.lineTo(headX + r * 0.5, cy - r * 1.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(headX, cy - r * 0.05); ctx.lineTo(headX + r * 0.7, cy - r * 1.0); ctx.stroke();
  }
}

// ── Screen-space HUD layer (canvas width×height coords) ──────────────────────

export function drawBiosphereHUDLayer(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  bio:     PlanetBiosphere,
): void {
  drawBiosphereHUD(ctx, W, H, species, bio);
  drawLegend(ctx, W, H, species);
}

function drawBiosphereHUD(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
  bio:     PlanetBiosphere,
): void {
  void species;
  const panelW = 260, panelH = 180;
  const px = W - panelW - 10, py = 56;

  ctx.fillStyle   = 'rgba(4,2,12,0.88)';
  ctx.strokeStyle = 'rgba(0,200,160,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.fillRect  (px, py, panelW, panelH);
  ctx.strokeRect(px, py, panelW, panelH);

  ctx.fillStyle = '#44ccaa';
  ctx.font      = '11px Cinzel Decorative, serif';
  ctx.textAlign = 'left';
  ctx.fillText('BIOSPHERE ANALYSIS', px + 10, py + 20);

  const rows: [string, string][] = [
    ['O₂ Level',        `${Math.round(bio.oxygenLevel * 100)}%`],
    ['Biodiversity',    `${bio.biodiversity} species`],
    ['Ocean Life',      `${Math.round(bio.oceanLife * 100)}%`],
    ['Land Life',       `${Math.round(bio.landLife * 100)}%`],
    ['Ext. Pressure',   `${Math.round(bio.extinctionPressure * 100)}%`],
    ['Bio Density',     `${Math.round(bio.biosphereDensity * 100)}%`],
  ];

  rows.forEach(([label, value], i) => {
    const ry = py + 40 + i * 20;
    ctx.fillStyle = '#7b8aaa';
    ctx.font      = '10px Cinzel, serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, px + 10, ry);
    ctx.fillStyle = '#d4c5e8';
    ctx.textAlign = 'right';
    ctx.fillText(value, px + panelW - 10, ry);
  });

  const barY = py + panelH - 16;
  const barW = panelW - 20;
  ctx.fillStyle = 'rgba(68,204,136,0.18)';
  ctx.fillRect(px + 10, barY, barW, 8);
  ctx.fillStyle = '#44cc88';
  ctx.fillRect(px + 10, barY, barW * bio.biosphereDensity, 8);
}

function drawLegend(
  ctx:     CanvasRenderingContext2D,
  W:       number,
  H:       number,
  species: SpeciesGenome[],
): void {
  void W;
  const active = species.filter(s => !s.isExtinct);
  if (active.length === 0) return;

  const rows    = active.slice(0, 5);
  const panelW  = 220;
  const panelH  = 22 + rows.length * 22;
  const px = 10, py = H - panelH - 58;

  ctx.fillStyle   = 'rgba(4,2,12,0.82)';
  ctx.strokeStyle = 'rgba(123,94,167,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.fillRect  (px, py, panelW, panelH);
  ctx.strokeRect(px, py, panelW, panelH);

  ctx.fillStyle = '#7b5ea7';
  ctx.font      = '10px Cinzel, serif';
  ctx.textAlign = 'left';
  ctx.fillText('ACTIVE LIFE FORMS', px + 10, py + 15);

  rows.forEach((sp, i) => {
    const ry = py + 28 + i * 22;
    drawSpeciesSprite(ctx, sp, px + 14, ry - 4, 6, 0);
    ctx.fillStyle = '#c8c8d8';
    ctx.font      = '10px Cinzel, serif';
    ctx.textAlign = 'left';
    ctx.fillText(sp.name.slice(0, 20), px + 28, ry);
    ctx.fillStyle = '#7b8aaa';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(sp.population * 100)}%`, px + panelW - 8, ry);
    ctx.textAlign = 'left';
  });
}
