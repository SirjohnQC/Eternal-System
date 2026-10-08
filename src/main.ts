import { BigBangEngine, StarBody, Planet, EngineSnapshot, type ZoomTier } from './simulation/BigBangEngine';
import { initFaithHand, refresh as refreshFaithHand } from './ui/FaithHand';
import type { DivineHost } from './simulation/FaithCards';
import { openChronicle } from './ui/ChronicleUI';
import { nationArch } from './rendering/Architecture';
import { PlanetRenderer, bakePlanetTexture } from './simulation/PlanetRenderer';
import { wrapEquirectToGlobe } from './rendering/CosmicPixelSprites';
import { paintMoon, type MoonKindArt } from './rendering/MoonArt';
import { moonSizeClass, moonSizeLabel, moonIsIrregular } from './simulation/MoonSize';
import {
  UniverseStats, PlanetDNA, DEFAULT_PLANET_DNA, GameStateData, gameState, TECH_LEVELS, CIV_COLORS,
  BiologyPhase, BIO_PHASE_LABELS, BIO_PHASE_SEQUENCE, CIV_PHASE_LABELS, civLevelToPhase,
  DNABranch, DEFAULT_DNA_BRANCH, CodexEntry, CODEX_MILESTONES,
} from './simulation/GameState';
import { SeedRNG } from './utils/SeedRNG';
import { uuid } from './utils/uuid';
import { FallbackNarrator } from './ai/FallbackNarrator';
import { logger } from './utils/logger';
import { gzip, ungzip } from 'pako';
import { AudioManager } from './audio/AudioManager';
import { generateLeaderDialogue, generateMemoryEntry } from './ai/LeaderDialogue';
import { drawFactionFlag } from './simulation/FactionFlag';
import { shiftLeaderAttitude, type Leader } from './simulation/Leader';
import { GeminiService } from './ai/GeminiService';
import type { EvolutionEvent } from './simulation/EvolutionEngine';
import type { Civilization } from './simulation/Civilization';
import { PixiBigBangRenderer } from './rendering/PixiBigBangRenderer';
import { BigBangCinematic } from './simulation/BigBangCinematic';
import { newForge } from './simulation/Forge';
import { subEraOf, SUB_ERA_NAMES } from './simulation/Technology';
import { runForge, forgeActive, forgeAwaitingDescent, forgeDescend } from './ui/ForgeUI';
import { initUniverseMap, showDormantGalaxyCard, currentOverlay } from './ui/UniverseMapUI';
import { IsoDioramaRenderer, type DivineEffectKind } from './rendering/IsoDioramaRenderer';
import {
  generatePlanetGrid, classifyBiome, isWater, isHabitable,
  SEA_LEVEL, GRID_SIZE, BIOME_COLORS, tintRiver,
  type BiomeType, type GridCell,
} from './simulation/PlanetGrid';
import { ARCHETYPES } from './simulation/LifeSystem';
import type { SpeciesGenome } from './simulation/SpeciesGenome';
import type { GenomeSummary } from './simulation/Civilization';
import { sapientFormOf } from './rendering/CreatureForge';
import { speciesRGB, clearSpeciesPalette } from './ui/speciesPalette';
import {
  generateBranchSet, emptyInvestment, branchesFromIds, dnaPointCost, type BranchDef,
} from './simulation/DnaBranches';
import { assignDominantSpecies } from './simulation/SpeciesDistribution';
import { initPlayerSpecies, stepEvolution } from './simulation/EvolutionEngine';
import { clearSpriteCaches, bakeCreatureSprite, bakeCreaturePortrait } from './rendering/SpeciesSprite';
import {
  cardStates, MUTATION_BY_ID, previewGenome, queueReady, EVOLVE_THRESHOLD,
} from './simulation/Mutations';
import { runtimeState } from './simulation/GameState';
import { DP_CAP, DP_REGEN_BASE, DP_DEVOTION_THRESHOLD_MID, DP_DEVOTION_THRESHOLD_HIGH } from './constants';
import { NORMAL_PACE, isDestinyType, type DestinyType } from './simulation/Formation';
import { symptomsOf } from './simulation/Nations';
import { TECH_BY_ID } from './simulation/Technology';
import { flagCanvas } from './rendering/NationFlagArt';

// ─── API Key (live-updatable — reads localStorage first, then .env) ───────────
const ENV_geminiKey = (import.meta as unknown as { env: Record<string, string> }).env['VITE_GEMINI_API_KEY'] ?? '';
let geminiKey: string = localStorage.getItem('eternal_gemini_key') ?? ENV_geminiKey;

// ─── Engine Instances ─────────────────────────────────────────────────────────
let engine: BigBangEngine | null = null;
let planetRenderer: PlanetRenderer | null = null;
let _dioramaRenderer: IsoDioramaRenderer | null = null;
let _pixiRenderer: PixiBigBangRenderer | null = null;
let dpInterval: ReturnType<typeof setInterval> | null = null;
let fallbackNarrator: FallbackNarrator | null = null;
let chatHandler: ((msg: string) => Promise<string>) | null = null;
let namingMode: 'species' | 'religion' | null = null;
let _warDiceWarId = -1;
let _warDiceAttackerDice: number[] = [];
let _warDiceDismissTimeout: ReturnType<typeof setTimeout> | null = null;
let currentDialogueLeader: Leader | null = null;
let _leaderDialogueOpen = false;
let _geminiService: GeminiService | null = null;

// ─── Event Log ────────────────────────────────────────────────────────────────
interface EventLogEntry {
  tick: number;
  type: 'milestone' | 'war' | 'cosmic' | 'discovery';
  text: string;
}
const eventLogEntries: EventLogEntry[] = [];
let eventLogFilter: string = 'all';
let eventLogSearch: string = '';

// ─── Screen Management ────────────────────────────────────────────────────────
function showScreen(name: string): void {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${name}`);
  if (el) el.classList.add('active');
  gameState.screen = name as typeof gameState.screen;
  document.body.classList.toggle('hud-on', name === 'game' || name === 'bigbang');

  // Music transitions
  void AudioManager.init().then(() => {
    if (name === 'menu') void AudioManager.playMusic('ambient_menu');
    if (name === 'bigbang') void AudioManager.playMusic('ambient_bigbang', false);
    if (name === 'game')    void AudioManager.playCosmosPlaylist();
  });
}

// ─── D20 Stat Rolling ─────────────────────────────────────────────────────────
// Player rolls 4 stats. The God auto-rolls 'divine' independently.
const STAT_KEYS: Array<keyof UniverseStats> = ['life', 'evolution', 'hostility', 'entropy'];
const STAT_LABELS: Record<keyof UniverseStats, string> = {
  life: 'LIFE', evolution: 'EVOLUTION', hostility: 'HOSTILITY',
  entropy: 'ENTROPY', divine: 'DIVINE INFLUENCE',
};
const STAT_DESC: Record<keyof UniverseStats, string> = {
  life: 'Star count · Panspermia · Life emergence',
  evolution: 'Civilization tech progression speed',
  hostility: 'War frequency · Conquest aggression',
  entropy: 'Asteroid belts · Cosmic event severity',
  divine: 'AI God intervention power + frequency',
};

const lockedStats: Partial<UniverseStats> = {};
const answeredQuestions: Partial<PlanetDNA> = {};
let currentStatIndex = 0;
let rollingInterval: ReturnType<typeof setInterval> | null = null;
let godDivineRoll = 10;
let godRollTriggered = false;

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

function setSimBootStatus(state: 'standby' | 'calibrating' | 'configuring' | 'ready', label: string): void {
  const el = document.getElementById('sim-boot-status');
  const text = document.getElementById('sim-boot-status-text');
  if (el) el.setAttribute('data-state', state);
  if (text) text.textContent = label;
}

function initRollingScreen(): void {
  const container = document.getElementById('stat-cards')!;
  container.innerHTML = '';
  currentStatIndex = 0;
  godDivineRoll = 10;
  godRollTriggered = false;
  delete answeredQuestions.climate;
  delete answeredQuestions.oceans;
  delete answeredQuestions.chaos;
  setSimBootStatus('standby', 'STANDBY');

  // Hide planet questions section + reset choice buttons
  const pqSection = document.getElementById('planet-questions-section');
  if (pqSection) pqSection.style.display = 'none';
  document.querySelectorAll('.pq-choice').forEach(el => el.classList.remove('selected'));
  document.querySelectorAll('.pq-card').forEach(el => el.classList.remove('answered'));
  document.querySelectorAll('.pq-reveal').forEach(el => { el.textContent = ''; el.classList.remove('visible'); });

  // Reset God roll card
  const godNumEl = document.getElementById('god-roll-num');
  const godLabelEl = document.getElementById('god-roll-label');
  if (godNumEl) { godNumEl.textContent = '—'; godNumEl.className = 'god-roll-num'; }
  if (godLabelEl) godLabelEl.textContent = '';
  const godSection = document.getElementById('god-roll-section');
  if (godSection) godSection.style.display = 'none';

  // Clear planet name input
  const planetInput = document.getElementById('planet-name-input') as HTMLInputElement | null;
  if (planetInput) planetInput.value = '';

  STAT_KEYS.forEach((key, i) => {
    const card = document.createElement('div');
    card.className = 'stat-card' + (i === 0 ? ' active' : '');
    card.id = `stat-card-${key}`;
    card.innerHTML = `
      <div class="stat-name">${STAT_LABELS[key]}</div>
      <div class="stat-desc">${STAT_DESC[key]}</div>
      <div class="stat-number" id="stat-num-${key}">—</div>
      <div class="stat-bar-wrap"><div class="stat-bar-fill" id="stat-bar-${key}"></div></div>
      <div class="stat-lock-badge" id="stat-lock-${key}">LOCKED</div>
    `;
    container.appendChild(card);
  });

  showRollButton();
  highlightCard(STAT_KEYS[0]);
}

function getHomeWorldName(): string {
  return (document.getElementById('planet-name-input') as HTMLInputElement | null)?.value.trim() ?? '';
}

const PLANET_NAME_POOL = [
  'Terra Nova', 'Aurelia', 'Kepleris', 'Nyxara', 'Velorum', 'Solara', 'Obsidia',
  'Lunara', 'Elyndor', 'Vespera', 'Astraea', 'Thalassa', 'Caelora', 'Miridian',
  'Zephyria', 'Nocturne', 'Helion', 'Arcturus Prime', 'Seraphel', 'Duskfall',
  'Ivory Reach', 'Crimson Vale', 'Pale Harbor', 'Starfall', 'Emberholt',
  'Whisperdeep', 'Glassmere', 'Ironwake', 'Skyreach', 'Umbravale',
];

function randomizePlanetName(): void {
  const input = document.getElementById('planet-name-input') as HTMLInputElement | null;
  if (!input) return;
  const current = input.value.trim();
  let pick = PLANET_NAME_POOL[Math.floor(Math.random() * PLANET_NAME_POOL.length)];
  // Avoid repeating the same name on consecutive clicks when possible.
  if (PLANET_NAME_POOL.length > 1) {
    let guard = 0;
    while (pick === current && guard++ < 8) {
      pick = PLANET_NAME_POOL[Math.floor(Math.random() * PLANET_NAME_POOL.length)];
    }
  }
  input.value = pick;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function highlightCard(key: keyof UniverseStats): void {
  STAT_KEYS.forEach(k => {
    document.getElementById(`stat-card-${k}`)?.classList.toggle('active', k === key);
  });
}

function showRollButton(): void {
  const btn = document.getElementById('roll-btn') as HTMLButtonElement;
  const genBtn = document.getElementById('genesis-btn') as HTMLButtonElement;
  const hintEl = document.getElementById('roll-hint');
  const named = getHomeWorldName().length > 0;

  if (currentStatIndex < STAT_KEYS.length) {
    btn.textContent = `⬡ ROLL: ${STAT_LABELS[STAT_KEYS[currentStatIndex]]}`;
    btn.style.display = '';
    btn.disabled = !named;
    genBtn.style.display = 'none';
    if (!named) {
      if (hintEl) hintEl.textContent = 'Enter HOME_WORLD name to arm calibration.';
      setSimBootStatus('standby', 'STANDBY');
    } else {
      if (hintEl) {
        hintEl.textContent = currentStatIndex === 0
          ? 'Calibrate each parameter in order. Higher is stronger. Fate is unforgiving.'
          : `Next parameter: ${STAT_LABELS[STAT_KEYS[currentStatIndex]]}.`;
      }
      if (currentStatIndex > 0) setSimBootStatus('calibrating', 'CALIBRATING');
      else setSimBootStatus('standby', 'STANDBY');
    }
  } else {
    // All player stats locked — God rolls next, then naming
    btn.style.display = 'none';
    btn.disabled = true;
    genBtn.style.display = 'none';
    if (hintEl) hintEl.textContent = 'Divine dominion parameter resolving…';
    setSimBootStatus('configuring', 'CONFIGURING');
    if (!godRollTriggered) {
      godRollTriggered = true;
      setTimeout(() => triggerGodRoll(), 800);
    }
  }
}

function triggerGodRoll(): void {
  const section = document.getElementById('god-roll-section');
  const numEl = document.getElementById('god-roll-num')!;
  const labelEl = document.getElementById('god-roll-label')!;
  if (section) section.style.display = 'flex';

  AudioManager.playSfx('dice_roll');

  numEl.className = 'god-roll-num rolling';
  let count = 0;
  const maxCount = 28;
  const interval = setInterval(() => {
    numEl.textContent = String(Math.floor(Math.random() * 20) + 1).padStart(2, '0');
    count++;
    if (count >= maxCount) {
      clearInterval(interval);
      const rng = new SeedRNG(Date.now() + 99991);
      godDivineRoll = rng.nextInt(1, 20);
      numEl.textContent = String(godDivineRoll).padStart(2, '0');
      numEl.className = `god-roll-num settled ${getStatTier(godDivineRoll)}`;
      labelEl.textContent = godDivineRoll >= 17 ? 'OMNIPRESENT' :
                            godDivineRoll >= 13 ? 'INTERVENING' :
                            godDivineRoll >=  8 ? 'WATCHFUL' : 'DISTANT';
      // The world's DNA is forged in play now (the Forge), not asked here:
      // the old climate / oceans / chaos probe stays hidden and neutral.
      setTimeout(() => {
        answeredQuestions.climate ??= DEFAULT_PLANET_DNA.climate;
        answeredQuestions.oceans ??= DEFAULT_PLANET_DNA.oceans;
        answeredQuestions.chaos ??= DEFAULT_PLANET_DNA.chaos;
        checkGenesisReady();
      }, 700);
    }
  }, 55);
}

function checkGenesisReady(): void {
  const hintEl = document.getElementById('roll-hint');
  const planet = getHomeWorldName();
  const genBtn = document.getElementById('genesis-btn') as HTMLButtonElement | null;

  // While still rolling stats, name field only gates the roll button.
  if (currentStatIndex < STAT_KEYS.length) {
    showRollButton();
    return;
  }

  if (!genBtn) return;
  if (!godRollTriggered) return;

  const allQuestionsAnswered = !!(answeredQuestions.climate && answeredQuestions.oceans && answeredQuestions.chaos);

  if (planet && allQuestionsAnswered) {
    genBtn.style.display = '';
    if (hintEl) hintEl.textContent = 'Seed locked. Press to initialize cosmos.';
    setSimBootStatus('ready', 'READY');
  } else {
    genBtn.style.display = 'none';
    setSimBootStatus('configuring', 'CONFIGURING');
    if (!planet) {
      if (hintEl) hintEl.textContent = 'Enter HOME_WORLD name to arm launch.';
    } else {
      if (hintEl) hintEl.textContent = 'Complete world DNA probe channels above.';
    }
  }
}

function rollCurrentStat(): void {
  if (currentStatIndex >= STAT_KEYS.length) return;
  if (!getHomeWorldName()) {
    showRollButton();
    return;
  }
  const key = STAT_KEYS[currentStatIndex];

  setSimBootStatus('calibrating', 'CALIBRATING');
  AudioManager.playSfx('dice_roll');

  const numEl = document.getElementById(`stat-num-${key}`)!;
  numEl.className = 'stat-number rolling';

  let count = 0;
  const maxCount = 28;
  if (rollingInterval) clearInterval(rollingInterval);

  rollingInterval = setInterval(() => {
    numEl.textContent = String(Math.floor(Math.random() * 20) + 1).padStart(2, '0');
    count++;
    if (count >= maxCount) {
      clearInterval(rollingInterval!);
      const rng = new SeedRNG(Date.now() + currentStatIndex * 7331);
      const finalVal = rng.nextInt(1, 20);
      lockedStats[key] = finalVal;

      numEl.textContent = String(finalVal).padStart(2, '0');
      numEl.className = `stat-number settled ${getStatTier(finalVal)}`;

      const bar = document.getElementById(`stat-bar-${key}`) as HTMLElement;
      bar.style.width = `${(finalVal / 20) * 100}%`;
      bar.style.background = getBarColor(finalVal);

      document.getElementById(`stat-card-${key}`)!.classList.add('locked');
      const lockBadge = document.getElementById(`stat-lock-${key}`)!;
      lockBadge.style.display = 'block';
      lockBadge.textContent = `${finalVal} / 20`;

      currentStatIndex++;
      if (currentStatIndex < STAT_KEYS.length) {
        setTimeout(() => highlightCard(STAT_KEYS[currentStatIndex]), 250);
      }
      showRollButton();
    }
  }, 55);
}

function getStatTier(v: number): string {
  if (v >= 17) return 'tier-legendary';
  if (v >= 13) return 'tier-high';
  if (v >= 8)  return 'tier-mid';
  return 'tier-low';
}

function getBarColor(v: number): string {
  if (v >= 17) return 'linear-gradient(90deg,#ffdd00,#ffaa00)';
  if (v >= 13) return 'linear-gradient(90deg,#44ccff,#0088cc)';
  if (v >= 8)  return 'linear-gradient(90deg,#44aa44,#226622)';
  return 'linear-gradient(90deg,#aa4422,#661111)';
}

// ─── Big Bang ─────────────────────────────────────────────────────────────────
function setBigBangLoadProgress(pct: number, status: string): void {
  const fill = document.getElementById('bb-load-fill');
  const label = document.getElementById('bb-load-status');
  const panel = document.getElementById('bigbang-loading');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (label) label.textContent = status;
  if (panel) {
    panel.classList.remove('bb-load-done');
    panel.setAttribute('aria-busy', 'true');
  }
}

function hideBigBangLoading(): void {
  const panel = document.getElementById('bigbang-loading');
  if (!panel) return;
  panel.classList.add('bb-load-done');
  panel.setAttribute('aria-busy', 'false');
}

function launchBigBang(): void {
  void launchBigBangAsync();
}

async function launchBigBangAsync(): Promise<void> {
  applyPlayModeControls();
  const planetName = (document.getElementById('planet-name-input') as HTMLInputElement)?.value.trim() || 'Terra';

  // Store planet name + DNA now; species + religion emerge as in-game events
  gameState.playerPlanetName = planetName;
  gameState.playerSpeciesName = '';
  gameState.playerReligionName = '';
  gameState.dnaPoints = 0;
  gameState.techPoints = 0;
  // A new universe gets a fresh branch set. The engine rolls it from the
  // master seed during init(), so clearing these is enough to trigger it.
  gameState.branchIds = [];
  gameState.playerDNA = {};
  runtimeState.branchDefs = [];
  gameState.codexEntries = [];
  clearSpriteCaches();
  // Species ids are per-universe, so the surface map's colour and selection
  // caches must go with them. Leaking state across games in one session is the
  // most repeated bug in this codebase — see ROADMAP M20b.
  clearSpeciesPalette();
  // Civilisation culture is keyed by starId, same leak risk as above — a
  // second game in one session must not inherit the previous universe's
  // civilisations. (BigBangEngine.init() clears this too; belt and suspenders.)
  gameState.civilizations = {};
  gameState.forge = null;
  gameState.forgeMods = null;
  gameState.sectorsCharted = [];
  gameState.dnaFocusBranch = null;
  _pmSelected = null;
  _pmLayer = 'biome';
  gameState.playerPlanetDNA = {
    climate: answeredQuestions.climate ?? DEFAULT_PLANET_DNA.climate,
    oceans:  answeredQuestions.oceans  ?? DEFAULT_PLANET_DNA.oceans,
    chaos:   answeredQuestions.chaos   ?? DEFAULT_PLANET_DNA.chaos,
  };

  const stats: UniverseStats = {
    life: lockedStats.life ?? 10,
    evolution: lockedStats.evolution ?? 10,
    hostility: lockedStats.hostility ?? 10,
    entropy: lockedStats.entropy ?? 10,
    divine: godDivineRoll,   // God's own roll, not the player's
  };
  gameState.stats = stats;

  // Planet name is hashed into the seed — "Terra" and "Gaia" produce different universes
  const nameHash = hashStr(planetName);
  const seed = `eternal_${Object.values(stats).join('_')}_${nameHash}`;
  gameState.masterSeed = seed;

  fallbackNarrator = new FallbackNarrator(seed);
  _geminiService = geminiKey ? new GeminiService(geminiKey, seed) : null;
  const godName = fallbackNarrator.generateGodName();
  gameState.godName = godName;

  document.getElementById('god-name-display')!.textContent = godName;
  document.getElementById('god-name-top')!.textContent = godName;

  // Build chat handler with Gemini fallback
  chatHandler = async (msg: string) => {
    if (!geminiKey) return fallbackNarrator!.generateGodGreeting(godName);
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `You are ${godName}, ancient AI deity. The player says: "${msg}". Respond in 2 sentences, oracular tone.` }] }],
            generationConfig: { maxOutputTokens: 150 },
          }),
        }
      );
      const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? fallbackNarrator!.generateGodGreeting(godName);
    } catch {
      return fallbackNarrator!.generateGodGreeting(godName);
    }
  };

  showScreen('bigbang');
  setBigBangLoadProgress(4, 'Seeding the void');

  const canvas = document.getElementById('bigbang-canvas') as HTMLCanvasElement;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  runtimeState.playerPlanetGrid = null; // reset on new game
  engine = new BigBangEngine(canvas);
  // Must be set BEFORE init(): init()'s pre-seed loop can roll a star straight
  // to 'intelligent' at tick 0 and calls ensureCivilization() synchronously —
  // if geminiService were assigned after init(), that civilisation would be
  // permanently locked to its procedural culture even with a valid API key.
  engine.geminiService = _geminiService;

  setBigBangLoadProgress(18, 'Rolling the master seed');
  await new Promise<void>(r => setTimeout(r, 0));
  engine.init(stats, seed);

  wireEngineEvents(engine);

  setBigBangLoadProgress(40, 'Igniting the observatory');
  await attachPixiRenderer(engine, canvas);
  _pixiRenderer?.warmStarTextures();

  setBigBangLoadProgress(62, 'Charting the galaxies');
  // The galaxies are drawn by the Pixi renderer (GalaxyArt); without it, the
  // engine's own pixel envelopes.
  const chart = (done: number, total: number, label: string) => setBigBangLoadProgress(62 + Math.round((done / total) * 30), label);
  if (_pixiRenderer) await _pixiRenderer.warmGalaxyArt(engine.currentGalaxies, chart);
  else await engine.warmVisualCaches(chart);

  setBigBangLoadProgress(100, 'Let there be light');
  await new Promise<void>(r => setTimeout(r, 180));
  hideBigBangLoading();

  applyFrameRateCap(pendingFrameRateCap);

  // Initial god greeting — after the opening cinematic, when there is one.
  const greet = () => setTimeout(() => {
    addChatMessage(fallbackNarrator!.generateGodGreeting(godName), 'god');
    if (!geminiKey) {
      // Point at the Settings menu, not at the env var. `.env` is gitignored and
      // is NOT distributed with the public repo, so telling a fresh clone to set
      // VITE_GEMINI_API_KEY sends them to a file they do not have. The settings
      // dialog writes the key to localStorage and works without touching the repo.
      addChatMessage('[ Offline mode — procedural AI active. Add a Gemini API key in Settings (⚙) for full AI integration. ]', 'system');
    }
  }, 1800);

  // After the opening: the Forge (the home world forged from Fate Cards).
  // Out of the cinematic the view stays on the home system; the Forge waits
  // there until the player descends to the molten world.
  const afterOpening = (fromCinematic = false) => { greet(); startForgeIfDue(fromCinematic); };
  // ?cine=0 (dev) skips the opening cinematic.
  if (new URLSearchParams(location.search).get('cine') !== '0') startCinematic(engine, () => afterOpening(true));
  else afterOpening();
  engine.start();
}

// ─── The Forge (Forge.ts / ForgeUI.ts) ────────────────────────────────────────

/**
 * Start (or resume) the Forge when the home world is still molten and no
 * forge has finished. Lab runs (`skipFormation`) and `?forge=0` keep the old
 * timed formation.
 */
function startForgeIfDue(holdInSystem = false): void {
  if (!engine || gameState.skipFormation) return;
  if (new URLSearchParams(location.search).get('forge') === '0') return;
  if (gameState.forge?.phase === 'done' || !engine.isHomeForming()) return;
  const ps = engine.beginForge();
  if (!ps || !gameState.stats) return;
  if (!gameState.forge) {
    // The whisperer: a god who is not yours. Seeded, so a universe keeps it.
    const whisperer = new FallbackNarrator(`${gameState.masterSeed}_whisper`).generateGodName();
    gameState.forge = newForge(gameState.masterSeed, gameState.stats, ps.temperature, whisperer);
  }
  const stageLabels: Record<string, string> = {
    magma: 'Magma Ocean', cooling: 'Cooling Crust', volcanic: 'Volcanic Era',
    atmosphere: 'Atmosphere Forming', ice_age: 'Ice Age', primordial: 'Primordial Ocean',
  };
  runForge({
    shape: (destiny, stage, dna) => engine?.shapeForgedWorld(destiny, stage, dna),
    refreshWorld: () => refreshHomeWorldSurface(),
    openWorld: () => { void openPlanetView(); },
    stageChanged: (stage) => {
      const el = document.getElementById('civ-bar');
      if (el) el.textContent = stageLabels[stage] ?? stage;
      addFeedEntry(`Forging: ${stageLabels[stage] ?? stage}`, 'milestone');
      const ps2 = engine?.getPlayerStar();
      if (ps2) updateBottomBar(ps2);
    },
    spark: (tempo) => engine?.sparkForgedLife(tempo),
    chat: (text, who) => addChatMessage(text, who),
    godName: () => gameState.godName || 'the god',
    planetName: () => gameState.playerPlanetName || 'Your world',
  }, { holdInSystem });
  if (holdInSystem && forgeAwaitingDescent()) engine.setZoomTier('system');
}

// ─── Opening cinematic (BigBangCinematic) ─────────────────────────────────────
let _cineUiRaf = 0;

/** Play the Big Bang cinematic on `eng`: HUD hidden, letterboxed, captioned, skippable. */
function startCinematic(eng: BigBangEngine, onDone: () => void): void {
  const overlay = document.getElementById('cine-overlay');
  const caption = document.getElementById('cine-caption');
  const cine = new BigBangCinematic();
  eng.cinematic = cine;
  document.body.classList.add('cinematic');
  overlay?.classList.remove('leaving');
  overlay?.classList.add('on');

  const fill = (text: string): string => {
    const ps = eng.getPlayerStar();
    const gal = ps ? eng.currentGalaxies.find(g => g.id === ps.galaxyId) : undefined;
    return text
      .replace('{galaxy}', gal?.name ?? 'a quiet galaxy')
      .replace('{planet}', gameState.playerPlanetName || 'Your world')
      .replace('{god}', gameState.godName || 'the god');
  };
  let shown = -1;
  let swapTimer = 0;
  const tickUi = () => {
    if (cine.finished) return;
    const i = cine.beatIndex;
    if (i !== shown && caption) {
      shown = i;
      const text = fill(cine.beat.caption);
      // Fade out, swap, fade in; an empty caption just clears the line.
      caption.classList.remove('show');
      window.clearTimeout(swapTimer);
      if (text) swapTimer = window.setTimeout(() => { caption.textContent = text; caption.classList.add('show'); }, caption.textContent ? 650 : 0);
    }
    _cineUiRaf = requestAnimationFrame(tickUi);
  };
  _cineUiRaf = requestAnimationFrame(tickUi);

  const skip = () => eng.skipCinematic();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); skip(); }
  };
  document.addEventListener('keydown', onKey);
  const skipBtn = document.getElementById('cine-skip');
  skipBtn?.addEventListener('click', skip);
  // The overlay swallows clicks and wheel so the tour's camera is not fought.
  const swallow = (e: Event) => { e.stopPropagation(); if (e.type === 'wheel') e.preventDefault(); };
  overlay?.addEventListener('wheel', swallow, { passive: false });

  eng.onCinematicEnd = () => {
    cancelAnimationFrame(_cineUiRaf);
    window.clearTimeout(swapTimer);
    document.removeEventListener('keydown', onKey);
    skipBtn?.removeEventListener('click', skip);
    overlay?.removeEventListener('wheel', swallow);
    caption?.classList.remove('show');
    overlay?.classList.add('leaving');
    // Fade the HUD back in over the world.
    document.body.classList.add('hud-reveal');
    requestAnimationFrame(() => { document.body.classList.remove('cinematic'); updateViewInsets(); });
    window.setTimeout(() => {
      overlay?.classList.remove('on', 'leaving');
      if (caption) caption.textContent = '';
      document.body.classList.remove('hud-reveal');
    }, 1600);
    onDone();
  };
}

/**
 * Tell the engine how much of each screen edge the HUD covers, so it centres
 * what it frames in the visible play area rather than behind the chat panel.
 */
function updateViewInsets(): void {
  if (!engine) return;
  const W = window.innerWidth, H = window.innerHeight;
  const rect = (sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el || !el.offsetParent && getComputedStyle(el).position !== 'fixed') return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const hudOn = document.body.classList.contains('hud-on') && !document.body.classList.contains('cinematic');
  if (!hudOn) { engine.viewInsets = { l: 0, r: 0, t: 0, b: 0, deck: 0 }; return; }
  const rail = rect('.nav-rail'), right = rect('.right-panel'), top = rect('.top-bar'), bottom = rect('.bottom-bar');
  const deck = rect('.faith-deck-label');
  engine.viewInsets = {
    l: rail ? Math.max(0, rail.right) : 0,
    r: right && right.left > W * 0.5 ? Math.max(0, W - right.left) : 0,
    t: top ? Math.max(0, top.bottom) : 0,
    b: bottom ? Math.max(0, H - bottom.top) : 0,
    deck: deck ? Math.max(0, H - deck.top + 6) : 0,
  };
}
setInterval(updateViewInsets, 500);
window.addEventListener('resize', updateViewInsets);

/** "Late Medieval": a star's era with its sub-era (Early / Middle / Late). */
function eraName(star: StarBody): string {
  return engine?.eraNameOf(star) ?? TECH_LEVELS[Math.min(star.civLevel, TECH_LEVELS.length - 1)] ?? 'Primitive';
}

/** Attach a PixiBigBangRenderer to the given engine + canvas pair. */
async function attachPixiRenderer(eng: BigBangEngine, engineCanvas: HTMLCanvasElement): Promise<void> {
  // Tear down any existing Pixi instance
  if (_pixiRenderer) {
    const old = _pixiRenderer.canvas;
    old.parentElement?.removeChild(old);
    _pixiRenderer = null;
  }

  const pixi = new PixiBigBangRenderer();
  await pixi.init(engineCanvas.width, engineCanvas.height);

  // Style the Pixi canvas to sit behind the engine canvas
  const pc = pixi.canvas;
  pc.style.position = 'fixed';
  pc.style.inset = '0';
  pc.style.width = '100%';
  pc.style.height = '100%';
  pc.style.zIndex = '0';
  pc.style.pointerEvents = 'none';

  // Insert before the engine canvas so it renders behind it
  engineCanvas.parentElement?.insertBefore(pc, engineCanvas);

  // Engine canvas becomes transparent — fog + screen effects only
  engineCanvas.style.background = 'transparent';
  engineCanvas.style.zIndex = '1';

  eng.pixiMode = true;
  eng.onPixiFrame = (e) => pixi.renderFrame(e);
  pixi.setMapOverlay(currentOverlay());
  _pixiRenderer = pixi;

  // Keep Pixi canvas sized on window resize
  window.addEventListener('resize', () => {
    pixi.resize(window.innerWidth, window.innerHeight);
  }, { once: false });
}

function wireEngineEvents(eng: BigBangEngine): void {
  eng.onCivEvent = (msg) => {
    addFeedEntry(msg, 'milestone');
    // Only pipe player-relevant civ events to the God chat
    if (msg.includes('Your civilization')) {
      addChatMessage(msg, 'god');
    }
  };
  eng.onWarEvent = (a, b) => {
    // Legacy: fires when a fleet is launched (pre-war) — keep for feed entry
    addFeedEntry(`${a} launches a war fleet toward ${b}`, 'war');
  };
  function syncPlanetRendererWarState(): void {
    if (!planetRenderer) return;
    const warStateRaw = engine?.getPlayerWarState();
    if (!warStateRaw) { planetRenderer.warState = null; return; }
    const { war, attacker } = warStateRaw;
    planetRenderer.warState = {
      warId: war.id,
      attackerName: attacker.civName,
      attackerColor: CIV_COLORS[attacker.civLevel] ?? '#ff4444',
      phase: war.phase,
      progress: Math.min(1, (engine!['tick'] - war.startTick) / war.duration),
      attackerStrength: war.attackerStrength,
      defenderStrength: war.defenderStrength,
    };
  }

  eng.onWarStart = (war, attacker, defender) => {
    const ps = engine?.getPlayerStar();
    const playerInvolved = !!(ps && (attacker.id === ps.id || defender.id === ps.id));
    const warPrefix = playerInvolved ? 'UNDER ATTACK — ' : 'INTERGALACTIC WAR — ';
    const msg = `${warPrefix}${attacker.civName} declares war on ${defender.civName}. The conflict begins.`;
    addFeedEntry(msg, 'war');
    showToast('war_start', msg, 7000);
    AudioManager.playSfx('war_declared');
    // Record in Codex if player is involved
    if (playerInvolved) {
      addCodexEntry(`War: ${attacker.civName} vs ${defender.civName}`, 'war');
    }
    // Rate-limit God chat
    const now = Date.now();
    if (now - _lastWarChatTime > 25_000) {
      _lastWarChatTime = now;
      const narrative = fallbackNarrator?.generateWarNarrative(attacker.civName, defender.civName)
        ?? msg;
      addChatMessage(narrative, 'god');
    }
    syncPlanetRendererWarState();
    void war; // used for type check only here
  };
  eng.onWarProgress = (_war, attacker, defender, msg) => {
    const _ps = engine?.getPlayerStar();
    const _playerInvolved = !!((_ps) && (attacker.id === _ps.id || defender.id === _ps.id));
    const progressPrefix = _playerInvolved ? 'HOMELAND DEFENSE — ' : 'INTERGALACTIC WAR — ';
    const prefixedMsg = `${progressPrefix}${msg}`;
    addFeedEntry(prefixedMsg, 'war');
    if (_war.phase === 'siege') showToast('war_siege', prefixedMsg, 6000);
    syncPlanetRendererWarState();
  };
  eng.onWarEnd = (war, attacker, defender, attackerWon) => {
    const winner = attackerWon ? attacker.civName : defender.civName;
    const loser  = attackerWon ? defender.civName : attacker.civName;
    const endMsg = attackerWon
      ? `${winner} conquers ${loser} — the war ends in occupation.`
      : `${loser} repels the ${winner} invasion — the war ends in defeat for the aggressor.`;
    addFeedEntry(endMsg, 'war');
    showToast('war_end', endMsg, 8000);
    if (attackerWon) addCodexEntry(`Fall of ${loser}`, 'extinction');
    syncPlanetRendererWarState();
    const now = Date.now();
    if (now - _lastWarChatTime > 15_000) {
      _lastWarChatTime = now;
      addChatMessage(endMsg, 'god');
    }
    // DP bonus when the player's civilization wins a war
    const playerStar = engine?.getPlayerStar();
    const playerWon = playerStar && (
      (attackerWon && attacker.id === playerStar.id) ||
      (!attackerWon && defender.id === playerStar.id)
    );
    if (playerWon) awardDP(20, `war victory over ${loser}`);
    void war;
    // Update leader memory for war outcome
    const winnerStar = attackerWon ? attacker : defender;
    const loserStar  = attackerWon ? defender : attacker;
    const winnerLeader = gameState.leaders.find(l => l.starId === winnerStar.id);
    const loserLeader  = gameState.leaders.find(l => l.starId === loserStar.id);
    if (winnerLeader) {
      winnerLeader.ambitionLevel = Math.min(10, winnerLeader.ambitionLevel + 1);
      appendLeaderMemory(
        winnerLeader.id,
        attackerWon
          ? `We conquered ${loserStar.civName} under my command.`
          : `We defended our homeland against ${attacker.civName}.`
      );
    }
    if (loserLeader) {
      loserLeader.fearLevel = Math.min(10, loserLeader.fearLevel + 2);
      appendLeaderMemory(loserLeader.id, `We suffered defeat at the hands of ${winnerStar.civName}.`);
    }
  };
  eng.onCosmicEvent = (type, sys) => {
    addFeedEntry(`${type.replace(/_/g, ' ')} — ${sys}`, 'cosmic');
  };
  eng.onReligionEvent = (msg) => {
    addFeedEntry(msg, 'milestone');
  };

  // ── Biology / Phase callbacks ────────────────────────────────────────────
  eng.onBioPhaseAdvance = (phase) => {
    const label = BIO_PHASE_LABELS[phase];
    addFeedEntry(`Evolution: ${label} on ${gameState.playerPlanetName}`, 'milestone');
    updatePhaseBar();
    eng.clearPlanetTextureCache();
    _dioramaRenderer?.setLiveData(gameState.playerSpecies, gameState.playerBiosphere);
    // A phase advance is the moment creatures first appear (buildInhabitants
    // early-returns before 'multicellular'/'complex' etc.) and settlements can
    // change too — surfaceDirty drives those, not just decals, and
    // decalRebakeNeeded's (lush, biodiversity) tuple does not cover them. Mark
    // unconditionally; SURFACE_REBAKE_INTERVAL already throttles the repaint.
    _dioramaRenderer?.markSurfaceDirty();
    if (phase === 'intelligent') {
      // Keep DNA panel open — player now accumulates DNA points via Nudge to trigger species evolution
      document.getElementById('dna-panel')?.classList.add('visible');
    }
    // Phase-specific God messages
    const phaseMessages: Record<string, string> = {
      multicellular: `The single cells of ${gameState.playerPlanetName} have learned to cooperate. Clusters form. Bodies take shape. Life grows complex.`,
      complex:       `Strange creatures now crawl through the shallows of ${gameState.playerPlanetName}. Eyes open for the first time. The world becomes visible.`,
      primitive:     `On ${gameState.playerPlanetName}, something remarkable stirs — creatures that walk upright, that use their hands. They are not yet wise. But they are close.`,
      intelligent:   `It has happened. On ${gameState.playerPlanetName}, a mind looks up at the stars and wonders. The age of thought begins.`,
    };
    const msg = phaseMessages[phase] ?? `Life on ${gameState.playerPlanetName} enters a new stage: ${label}.`;
    addChatMessage(msg, 'god');
  };
  // Great Filter outcomes and biosphere catastrophes. These are the moments that
  // make one playthrough's universe different from another's, so they get feed
  // entries, a Codex record and — on the player's own world — a word from the God.
  eng.onLifeEvent = (msg, kind, isPlayer) => {
    addFeedEntry(msg, kind === 'burst' ? 'milestone' : 'cosmic');
    if (!isPlayer) return;

    AudioManager.playSfx(kind === 'burst' ? 'discovery' : 'cosmic_event');
    const title = kind === 'stall'       ? 'The Long Stasis'
                : kind === 'collapse'    ? 'Mass Extinction'
                : kind === 'burst'       ? 'Explosive Radiation'
                :                          'Catastrophe';
    addCodexEntry(title, kind === 'burst' ? 'biology' : 'extinction');

    const godLines: Record<string, string> = {
      stall:       `Your world has found a shape it is content with, and stopped. Not every biosphere climbs. Nudge it, if you would have it climb anyway.`,
      collapse:    `Much of what lived on ${gameState.playerPlanetName} does not live any more. What remains will begin again. It always does.`,
      burst:       `Something broke open on ${gameState.playerPlanetName}. A thousand forms at once, where yesterday there were ten. Even I did not expect this.`,
      catastrophe: `${gameState.playerPlanetName} has been wounded. Its survivors are fewer, and its future is narrower than it was.`,
    };
    addChatMessage(godLines[kind] ?? msg, 'god');
    updatePhaseBar();
  };

  eng.onCodexMilestone = (entry) => {
    addFeedEntry(`✦ ${entry.title}`, 'milestone');
    AudioManager.playSfx('discovery');
    addCodexEntry(entry.title, entry.category);
  };
  eng.onDNAPointEarned = (total) => {
    updateDNAPanel();
    setResourceChip('dna-display', 'dna-display-val', total);
  };
  eng.onDNAAward = (n, why) => {
    dnaEarnLog.unshift({ n, why });
    if (dnaEarnLog.length > 40) dnaEarnLog.length = 40;
    // The steady trickle goes to the lab's ledger only; events get a toast.
    if (why !== 'Your species thrives') {
      addFeedEntry(`🧬 +${n} DNA — ${why}`, 'milestone');
      showToast('dna', `+${n} DNA · ${why}`, 5000);
    }
    refreshEvolutionUI();
  };
  eng.onSignatureDrift = (evt) => {
    addFeedEntry(`🧬 Natural drift: ${evt.description}`, 'milestone');
    refreshEvolutionUI();
  };
  eng.onSpontaneousMutation = (id) => {
    const def = MUTATION_BY_ID[id];
    if (!def) return;
    addFeedEntry(`🧬 A spontaneous mutation appeared: ${def.label} (added to your queue, free)`, 'milestone');
    showToast('dna', `Spontaneous mutation: ${def.glyph} ${def.label} — queued for free`, 7000);
    refreshEvolutionUI();
  };
  eng.onSignatureSucceeded = (name) => {
    addFeedEntry(`Your lineage carries on through ${name}.`, 'milestone');
    refreshEvolutionUI();
  };
  eng.onTechPointEarned = (total) => {
    setResourceChip('tech-display', 'tech-display-val', total);
    // +5 DP every tech level advance
    awardDP(5, `tech level ${total} reached`);
  };

  wireCosmicCallbacks();
  eng.onPlanetCatastrophe = (mergedWith) => {
    addFeedEntry(`Stellar collision — ${mergedWith} system absorbed. Planet formation begins.`, 'cosmic');
    addChatMessage(
      `The collision is catastrophic. Your world is consumed in the merger. From the molten ruins ` +
      `a new planet begins its long journey through formation. Witness the birth of a world.`,
      'god'
    );
    const el = document.getElementById('civ-bar');
    if (el) el.textContent = 'Molten Surface';
    // Refocus camera on the surviving merged star — player star may have moved
    setTimeout(() => engine?.focusPlayerStar(), 600);
  };
  eng.onPlayerExodus = (fromName, toName) => {
    addFeedEntry(`EXODUS — ${fromName} abandoned. Your people begin again at ${toName}.`, 'cosmic');
    addChatMessage(
      `Their star was dying and they knew it. The fleets of ${fromName} left before the light did, ` +
      `and they have made landfall at ${toName}. Your world is wherever they are. Follow them.`,
      'god'
    );

    // The player's home is a DIFFERENT star now, so everything derived from the
    // old one is stale. The surface grid in particular describes a planet that
    // no longer exists — leaving it in place is exactly the class of bug this
    // codebase keeps producing (ROADMAP M20b).
    runtimeState.playerPlanetGrid = null;
    _pmSelected = null;
    clearSpeciesPalette();
    _dioramaRenderer?.pause();

    const ps = engine?.getPlayerStar();
    if (ps) {
      const home = eng.homePlanetOf(ps);
      if (home) {
        gameState.playerPlanetName = home.name;
        home.name = gameState.playerPlanetName;
      }
    }
    setTimeout(() => engine?.focusPlayerStar(true), 600);
  };

  eng.onPlayerLifeEmerged = () => {
    if (!gameState.playerSpeciesName) {
      setTimeout(() => openNamingModal('species'), 1200);
    }
  };
  eng.onPlayerReligionMoment = () => {
    if (!gameState.playerReligionName) {
      setTimeout(() => openNamingModal('religion'), 1200);
    }
  };
  eng.onWarBattle = (warId, attackerName, defenderName, attackerDice, attackerColor, phase) => {
    const _battlePs = engine?.getPlayerStar();
    const playerIsDefender = !!(_battlePs && defenderName === _battlePs.civName);
    openWarDiceModal(warId, attackerName, defenderName, attackerDice, attackerColor, phase, playerIsDefender);
  };

  eng.onMeteorLifeSeeded = (planetName) => {
    addFeedEntry(`Microbial life has emerged on ${planetName}`, 'milestone');
    addChatMessage(
      `Your meteor has struck true. In the warm shallows of ${planetName}, the first fragile chains of life have taken hold.`,
      'god'
    );
    addCodexEntry(`Panspermia: ${planetName}`, 'biology');
    // Show impact image based on home planet type
    const ps = engine?.getPlayerStar();
    const homePlanet = ps ? engine?.homePlanetOf(ps) : undefined;
    showMeteorImpact(planetName, homePlanet?.type ?? 'rocky');
    updateDivineActions();
  };
  eng.onPlanetFormationProgress = (stage) => {
    const labels: Record<string, string> = {
      cooling: 'Cooling Crust', volcanic: 'Volcanic Era',
      atmosphere: 'Atmosphere Forming', ice_age: 'Ice Age', primordial: 'Primordial Ocean',
    };
    const label = labels[stage] ?? stage;
    addFeedEntry(`Planet formation: ${label}`, 'milestone');
    addChatMessage(FORMATION_STAGE_LINES[stage] ?? `${gameState.playerPlanetName} enters a new age: ${label}.`, 'god');
    const el = document.getElementById('civ-bar');
    if (el) el.textContent = label;
    refreshHomeWorldSurface();
  };
  eng.onPlanetFormationComplete = (destiny) => {
    const name = gameState.playerPlanetName || 'Your world';
    addFeedEntry(`${name} has finished forming — a ${DESTINY_LABELS[destiny]}`, 'milestone');
    addChatMessage(
      gameState.forge
        ? `The forging is over. ${name} is a ${DESTINY_LABELS[destiny]} now, and something on it is alive.`
        : `The long fire is over. ${name} has become what it was always meant to be: a ${DESTINY_LABELS[destiny]}. Life may now climb.`,
      'god',
    );
    addCodexEntry(`${name}: formation complete`, 'biology');
    refreshHomeWorldSurface();
    updateDivineActions();
  };
  eng.onFormationLifeArrived = (source, from) => {
    const name = gameState.playerPlanetName || 'your world';
    const how: Record<string, string> = {
      spontaneous: `Chemistry stirs in the young crust of ${name}. Life has woken on its own.`,
      ejecta: `Debris thrown from ${from || 'a living neighbour'} has fallen on ${name}, carrying life with it.`,
      meteor: `A meteor strike has seeded ${name} with life.`,
      divine: `You have placed life on ${name}.`,
    };
    addFeedEntry(how[source] ?? `Life has reached ${name}.`, 'milestone');
    addChatMessage(`${how[source] ?? ''} It sleeps until the world is finished, but it hurries the forming.`, 'god');
  };
  eng.onTerraformProgress = (stage, targetType) => {
    const labels: Record<string, string> = {
      ice_age: 'Ice Age', atmosphere: 'Atmosphere Formation',
      cooling: 'Cooling', primordial: 'Primordial Ocean', magma: 'Magma', volcanic: 'Volcanic',
    };
    const label = labels[stage] ?? stage;
    addFeedEntry(`Terraforming: ${label} phase (→ ${targetType})`, 'milestone');
    addChatMessage(`The ${label} phase spreads across ${gameState.playerPlanetName}. The path to ${targetType} continues.`, 'god');
    updateDivineActions();
  };
  eng.onTerraformComplete = (fromType, toType, planetName) => {
    addFeedEntry(`Terraforming complete — ${planetName} transformed from ${fromType} to ${toType}`, 'milestone');
    addChatMessage(
      `The divine transformation is complete. ${planetName} has been reshaped from ${fromType} to ${toType}. A new world is born.`,
      'god'
    );
    addCodexEntry(`${planetName} Terraformed`, 'divine');
    updateDivineActions();
  };
  eng.onTickUpdate = (tick) => {
    gameState.tick = tick;
    if (tick % 10 === 0) {
      updateHUDTick(tick);
      updatePhaseBar();
    }
    if (tick % 100 === 0 && gameState.screen === 'game') {
      autoSaveGame();
      showSaveIndicator();
    }
    // Let the home-world diorama pick up life spread and new settlements while
    // the player is watching it. `surfaceDirty` also drives buildCityDots()
    // and buildInhabitants() (settlements and creatures), not just decals, so
    // this must stay an unconditional mark — SURFACE_REBAKE_INTERVAL (4s)
    // already throttles the actual repaint, and decalRebakeNeeded's
    // (lush, biodiversity) tuple saturates (biodiversity caps at 10) so it
    // must never be the sole passive trigger for this path.
    if (tick % 250 === 0) {
      // playerSpecies is reassigned by each evolution step, so the renderer's
      // captured array must be refreshed or every species lookup goes stale.
      _dioramaRenderer?.setLiveData(gameState.playerSpecies, gameState.playerBiosphere);
      _dioramaRenderer?.markSurfaceDirty();
    }
  };

  // DP earns at real-world rate — devotion speeds it up, capped at 150
  if (dpInterval) clearInterval(dpInterval);
  dpInterval = setInterval(() => {
    const ps = engine?.getPlayerStar();
    const devotion = ps?.religionDevotion ?? 0;
    // Devotion tiers: base 1 DP, +1 at >0.4, +1 at >0.7 (max 3 DP per tick)
    const dpGain = DP_REGEN_BASE + (devotion > DP_DEVOTION_THRESHOLD_MID ? 1 : 0) + (devotion > DP_DEVOTION_THRESHOLD_HIGH ? 1 : 0);
    gameState.divinePoints = gameState.playMode === 'creative'
      ? CREATIVE_DP
      : Math.min(DP_CAP, gameState.divinePoints + dpGain);
    updateDivineActions();
    setResourceChip('dp-display', 'dp-display-val', gameState.divinePoints);
  }, 8000); // every 8 real seconds — devotion multiplies gain
  eng.onBigBangComplete = () => {
    const enterBtn = document.getElementById('enter-universe-btn');
    if (enterBtn) enterBtn.style.display = '';
    const ps = eng.getPlayerStar();
    if (ps) {
      gameState.playerStarId = ps.id;
      if (!gameState.playerPlanetName) gameState.playerPlanetName = ps.civName + ' Prime';
      updateBottomBar(ps);
    }
  };
  eng.onLeaderMessage = (leader, eventContext, starId) => {
    const isPlayerStar = starId === gameState.playerStarId;
    if (isPlayerStar && leader.spawnedAtCivLevel === 1) {
      addCodexEntry(`${leader.name} Rises`, 'civilisation');
    }
    setTimeout(() => void showLeaderDialogue(leader, eventContext), 800);
  };
  eng.onDormantGalaxySelected = (gal, x, y) => showDormantGalaxyCard(gal, x, y, gameState.playerPlanetName || 'your world');
  eng.onSectorCharted = (name) => {
    addFeedEntry(`Sector charted: ${name}`, 'discovery');
    addChatMessage(`Your astronomers have charted ${name}. Its galaxies are no longer only light.`, 'god');
  };
  eng.onStarSelected = (star) => {
    openSystemPanel(star);
  };
  eng.onBodySelected = (hit) => showBodyCard(hit.star, hit.planetIndex, hit.moonIndex, hit.screenX, hit.screenY);
  eng.onFirstContact = (npcStar) => {
    setTimeout(() => showFirstContact(npcStar), 600);
  };

  eng.onCosmicSignal = (civName) => {
    const garbled = `⊕ ░▒▓ SIGNAL DETECTED ▓▒░ ${civName.toUpperCase()} ░▒▓ DECODING...`;
    addFeedEntry(garbled, 'discovery');
  };

  eng.onSignalDecoded = (civName, message) => {
    addFeedEntry(`⊕ [DECODED] ${civName}: "${message}"`, 'discovery');
    addChatMessage(`A signal from ${civName} has decoded. "${message}"`, 'god');
  };

  // M17: Evolution events
  eng.onMutationEvent = (evt: EvolutionEvent) => {
    addFeedEntry(`🧬 ${evt.description}`, 'milestone');
    if (planetRenderer?.bioOverlayVisible) {
      planetRenderer.bioData = { species: gameState.playerSpecies, biosphere: gameState.playerBiosphere };
    }
  };

  eng.onSpeciationEvent = (evt: EvolutionEvent) => {
    if (planetRenderer?.bioOverlayVisible) {
      planetRenderer.bioData = { species: gameState.playerSpecies, biosphere: gameState.playerBiosphere };
    }
    // Open interactive modal — player names the new lineage and optionally nudges a trait.
    // Feed entry, Codex entry, and Gemini narration are all handled inside confirmSpeciation().
    // If dismissed, a minimal feed entry is recorded here.
    showSpeciationModal(evt);
  };

  eng.onExtinctionEvent = (evt: EvolutionEvent) => {
    addFeedEntry(`💀 EXTINCTION: ${evt.description}`, 'cosmic');
    addCodexEntry(`Extinction: ${evt.speciesName}`, 'extinction');
    if (planetRenderer?.bioOverlayVisible) {
      planetRenderer.bioData = { species: gameState.playerSpecies, biosphere: gameState.playerBiosphere };
    }
    _geminiService?.sendPlayerMessage(
      `[EXTINCTION EVENT — narrate in 2 sentences as the divine observer]: ${evt.description}`,
      ''
    ).then(res => {
      if (res) addChatMessage(res, 'god');
    }).catch(() => { /* silent */ });
  };

  eng.onCultureGenerated = (starId) => {
    const ps = engine?.getPlayerStar();
    if (ps && ps.id === starId) { renderCultureSection(ps); return; }
    // The panel is just as likely to be open on someone ELSE'''s world. Without
    // this it kept showing the procedural culture, and only a close-and-reopen
    // revealed the Gemini one.
    if (_panelStarId === starId) {
      const s = engine?.getStarById(starId);
      if (s) renderCultureSection(s);
    }
  };
}

function enterUniverse(): void {
  if (!engine) return;
  // Leaving mid-cinematic (dev shortcuts): finish it first so the HUD comes back.
  if (engine.cinematicActive) engine.skipCinematic();
  engine.stop();
  showScreen('game');

  const gameCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  gameCanvas.width = window.innerWidth;
  gameCanvas.height = window.innerHeight;

  // init() below unconditionally resets gameState.civilizations, so anything
  // that emerged during the Big Bang phase (the old engine, still ticking
  // right up to this point) has to be captured before that call and restored
  // after the handoff, the same way stars/nebulae/etc. are transferred below.
  const civilizationsBeforeHandoff = gameState.civilizations;

  const newEngine = new BigBangEngine(gameCanvas);
  // Must be set BEFORE init(): init()'s pre-seed loop can roll a star straight
  // to 'intelligent' at tick 0 and calls ensureCivilization() synchronously —
  // if geminiService were assigned after init(), any such civilisation would
  // be permanently locked to its procedural culture even with a valid API
  // key. This is the production "Enter Universe" path every player takes, so
  // without this the Gemini upgrade could never fire at all.
  newEngine.geminiService = _geminiService;
  if (gameState.stats && gameState.masterSeed) {
    newEngine.init(gameState.stats, gameState.masterSeed);
  }
  // Transfer simulation state
  newEngine.stars = engine.stars;
  newEngine.nebulae = engine.nebulae;
  newEngine.asteroids = engine.asteroids;
  newEngine.fleets = engine.fleets;
  newEngine['tick'] = engine['tick'];
  newEngine['phase'] = engine['phase'];
  newEngine['exploredAreas'] = engine['exploredAreas'];
  newEngine['settledSinceTick'] = engine['settledSinceTick'];
  gameState.civilizations = civilizationsBeforeHandoff;

  engine = newEngine;
  updateViewInsets();
  wireEngineEvents(engine);
  void attachPixiRenderer(engine, gameCanvas);
  applyFrameRateCap(pendingFrameRateCap);
  engine.start();
  engine.focusPlayerStar();
  applyPlayModeControls();
  setSpeed(1);
}

/**
 * @param planetIndex  which orbit to show. Omit to show the system's home world
 *   — defaulting to orbit 0 showed whatever happened to be innermost, which for
 *   the player's own star is often not the world they actually live on.
 */
async function openPlanetView(star?: StarBody, planetIndex?: number): Promise<void> {
  const target = star ?? engine?.getPlayerStar();
  if (!target) return;
  // Opening the home world while the Forge waits on the system view: descend.
  if (target.isPlayerStar && forgeAwaitingDescent()) forgeDescend(false);

  if (planetIndex == null) {
    const home = target.planets.findIndex(p => p.discovery === 'landing' || p.hasLife);
    planetIndex = home >= 0 ? home : 0;
  }

  const overlay = document.getElementById('planet-overlay')!;
  overlay.style.display = 'flex';

  const PANEL_W = 340;

  // Show which planet we're viewing in the overlay header
  const planet = target.planets[planetIndex] ?? target.planets[0];
  const titleEl = document.getElementById('planet-overlay-title');
  if (titleEl) {
    titleEl.textContent = target.isPlayerStar
      ? (gameState.playerPlanetName || planet?.name || target.civName)
      : `${target.civName} — ${planet?.name ?? 'Planet'}`;
  }

  // Lazy-generate the planet grid for the player's home world.
  // Uses the same numeric seed as bakePlanetTexture so terrain is consistent.
  if (target.isPlayerStar && !runtimeState.playerPlanetGrid) {
    const gridSeed = target.id * 7777 + planetIndex * 131;
    // `planet.type` is the face of the current formation stage while the world
    // forms, then its destiny. The setup DNA's ocean answer only shapes the
    // ground in lab runs; a normal run's water comes from its destiny.
    const dna = gameState.playerPlanetDNA;
    // A forged world's water comes from its forging, so its DNA counts in full.
    const labDna = gameState.destinyOverride !== null || gameState.skipFormation || !!gameState.forge;
    runtimeState.playerPlanetGrid = generatePlanetGrid(
      planet?.type ?? 'rocky',
      gridSeed,
      dna && !labDna ? { ...dna, oceans: 'mixed' } : dna,
    );
  }

  if (target.isPlayerStar && runtimeState.playerPlanetGrid) {
    assignDominantSpecies(runtimeState.playerPlanetGrid, gameState.playerSpecies);
  }

  const diMount = document.getElementById('diorama-mount') as HTMLDivElement;
  const canvas  = document.getElementById('planet-canvas') as HTMLCanvasElement;

  if (target.isPlayerStar) {
    // Player's home planet → diorama renderer
    diMount.style.display = 'block';
    canvas.style.display  = 'none';
    planetRenderer?.stop();

    if (!_dioramaRenderer) {
      _dioramaRenderer = new IsoDioramaRenderer();
      await _dioramaRenderer.init(diMount);
      // Live binding: a new game replaces `engine`, and its animTick restarts.
      _dioramaRenderer.setClock(() => engine?.currentAnimTick ?? 0);
      _dioramaRenderer.setNationSource(() => runtimeState.playerNations);
    }

    if (runtimeState.playerPlanetGrid && planet) {
      _dioramaRenderer.refreshData(
        runtimeState.playerPlanetGrid,
        gameState.playerBiosphere,
        gameState.playerSpecies,
        planet,
        target,
        planetIndex,
      );
    }
    attachTileInteraction(diMount);
    showTileInfo(null);          // a selection from a previous visit is stale
    _dioramaRenderer.setTargetFps(pendingFrameRateCap);
    // Galaxy/Pixi draws fight the diorama for the frame budget — pause them.
    if (engine) engine.suspendWorldDraw = true;
    _dioramaRenderer.resume();

  } else {
    // NPC planet → existing PlanetRenderer
    diMount.style.display = 'none';
    canvas.style.display  = 'block';
    canvas.width  = Math.max(400, window.innerWidth - PANEL_W);
    canvas.height = window.innerHeight - 56;

    planetRenderer?.stop();
    planetRenderer = new PlanetRenderer(canvas);
    planetRenderer.init(target, planetIndex);

    // Apply current war state if this star is under attack
    if (engine && target) {
      const warStateRaw = engine.getPlayerWarState();
      if (warStateRaw && (warStateRaw.defender.id === target.id || warStateRaw.attacker.id === target.id)) {
        const { war, attacker } = warStateRaw;
        planetRenderer.warState = {
          warId: war.id,
          attackerName: attacker.civName,
          attackerColor: CIV_COLORS[attacker.civLevel] ?? '#ff4444',
          phase: war.phase,
          progress: Math.min(1, (engine['tick'] - war.startTick) / war.duration),
          attackerStrength: war.attackerStrength,
          defenderStrength: war.defenderStrength,
        };
      }
    }

    planetRenderer.start();
    planetRenderer.bioOverlayVisible = false;
    planetRenderer.bioData = null;
    showTileInfo(null);          // tile actions are for the player's world only
    if (engine) engine.suspendWorldDraw = true;
  }

  // Reset to Overview tab on each open
  document.querySelectorAll('.pi-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.pi-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('.pi-tab[data-tab="overview"]')?.classList.add('active');
  document.getElementById('pi-tab-overview')?.classList.add('active');

  buildPlanetInfoPanel(target, planetIndex);
}

// ─── M20: Interactive Planet Tiles ────────────────────────────────────────────
//
// The diorama is the player's own world, so it should be a surface they act on
// directly rather than only a picture of the simulation. Clicking a tile
// inspects it; the local divine actions edit `runtimeState.playerPlanetGrid`,
// which the renderer re-bakes from.

interface TileRef { row: number; col: number }

let selectedTile: TileRef | null = null;

const BIOME_LABELS: Record<BiomeType, string> = {
  deep_ocean: 'Deep Ocean', ocean: 'Ocean', shallow: 'Shallows', beach: 'Coast',
  plains: 'Plains', grassland: 'Grassland', forest: 'Forest', jungle: 'Jungle',
  desert: 'Desert', savanna: 'Savanna', tundra: 'Tundra', snow: 'Snowfield',
  mountain: 'Mountains', volcanic: 'Volcanic',
};

interface TileAction {
  id: string;
  label: string;
  cost: number;
  radius: number;
  /** Whether the action makes any sense on this tile. */
  enabled: (cell: GridCell) => boolean;
  /** Applied to every cell in radius; `falloff` is 1 at the centre, 0 at the rim. */
  apply: (cell: GridCell, falloff: number) => void;
  /** Line shown in the panel after it runs. */
  report: string;
  /** Animation played on the diorama where it lands. */
  effect: DivineEffectKind;
}

const TILE_ACTIONS: TileAction[] = [
  {
    id: 'bless', label: 'Bless Region', cost: 8, radius: 7,
    enabled: (c) => !isWater(c.biome),
    apply: (c, f) => {
      c.fertility = Math.min(1, c.fertility + 0.35 * f);
      c.moisture  = Math.min(1, c.moisture + 0.12 * f);
      if (isHabitable(c.biome)) c.lifeDensity = Math.min(1, c.lifeDensity + 0.30 * f);
    },
    report: 'The land greens. Fertility and life rise across the region.',
    effect: 'fertility',
  },
  {
    id: 'blight', label: 'Blight Region', cost: 10, radius: 7,
    enabled: (c) => c.lifeDensity > 0.02,
    apply: (c, f) => {
      c.lifeDensity = Math.max(0, c.lifeDensity - 0.6 * f);
      c.fertility   = Math.max(0, c.fertility - 0.30 * f);
      if (f > 0.75) c.civId = null;
    },
    report: 'Life recedes. What grew here will take an age to return.',
    effect: 'sink',
  },
  {
    id: 'raise', label: 'Raise Land', cost: 12, radius: 6,
    enabled: () => true,
    apply: (c, f) => { c.elevation = Math.min(1, c.elevation + 0.16 * f); },
    report: 'The crust buckles upward. New ground breaks the surface.',
    effect: 'raise',
  },
  {
    id: 'sink', label: 'Sink Land', cost: 12, radius: 6,
    enabled: () => true,
    apply: (c, f) => { c.elevation = Math.max(0, c.elevation - 0.16 * f); },
    report: 'The ground gives way, and the sea comes in to fill it.',
    effect: 'water',
  },
];

function applyTileAction(action: TileAction, target: TileRef): void {
  const grid = runtimeState.playerPlanetGrid;
  if (!grid) return;

  const planet = engine?.getPlayerStar()?.planets
    .find(p => p.discovery === 'landing' || p.hasLife);
  const planetType = planet?.type ?? 'rocky';
  const r = action.radius;

  for (let dr = -r; dr <= r; dr++) {
    const row = target.row + dr;
    if (row < 0 || row >= GRID_SIZE) continue;
    for (let dc = -r; dc <= r; dc++) {
      // Columns wrap — the grid is a cylindrical projection.
      const col = (target.col + dc + GRID_SIZE) % GRID_SIZE;
      const dist = Math.hypot(dr, dc);
      if (dist > r) continue;

      const cell = grid[row][col];
      if (!cell) continue;

      action.apply(cell, 1 - dist / r);

      // Elevation edits change what the tile IS, so reclassify and recompute the
      // derived fields the rest of the simulation reads off it.
      cell.biome = classifyBiome(cell.elevation, cell.moisture, cell.temperature, planetType);
      if (!isHabitable(cell.biome)) { cell.fertility = 0; cell.lifeDensity = 0; }
      if (isWater(cell.biome)) cell.civId = null;
    }
  }
}

function buildTileActionButtons(cell: GridCell, target: TileRef): void {
  const wrap = document.getElementById('pi-tile-actions');
  if (!wrap) return;
  wrap.innerHTML = '';

  for (const action of TILE_ACTIONS) {
    const btn = document.createElement('button');
    btn.className = 'pi-tile-btn';
    const cost = document.createElement('span');
    cost.className = 'cost';
    cost.textContent = action.cost + ' DP';
    btn.textContent = action.label;
    btn.appendChild(cost);

    const affordable = gameState.divinePoints >= action.cost;
    const applicable = action.enabled(cell);
    btn.disabled = !affordable || !applicable;
    btn.title = !applicable ? 'No effect here'
              : !affordable ? 'Needs ' + action.cost + ' Divine Power'
              : '';

    btn.addEventListener('click', () => {
      if (gameState.divinePoints < action.cost) return;
      gameState.divinePoints -= action.cost;
      applyTileAction(action, target);
      _dioramaRenderer?.playDivineEffect(action.effect, target);

      _dioramaRenderer?.setLiveData(gameState.playerSpecies, gameState.playerBiosphere);
      _dioramaRenderer?.markSurfaceDirty(true);   // the player must see it land
      updateDivineActions();
      addFeedEntry('-' + action.cost + ' Divine Power — ' + action.label, 'milestone');
      AudioManager.playSfx('ui_confirm');

      const msg = document.getElementById('pi-tile-msg');
      if (msg) msg.textContent = action.report;

      // Re-read the tile so the panel reflects what just happened.
      showTileInfo(target, false);
    });

    wrap.appendChild(btn);
  }
}

/** Populate the Selected Tile panel. Pass null to clear it. */
function showTileInfo(target: TileRef | null, clearMessage = true): void {
  const section = document.getElementById('pi-tile-section');
  if (!section) return;

  const grid = runtimeState.playerPlanetGrid;
  if (!target || !grid) {
    section.style.display = 'none';
    selectedTile = null;
    _dioramaRenderer?.setSelection(null);
    return;
  }

  const cell = grid[target.row]?.[target.col];
  if (!cell) { section.style.display = 'none'; return; }

  selectedTile = target;
  section.style.display = '';
  _dioramaRenderer?.setSelection(target);
  if (clearMessage) setText('pi-tile-msg', '');

  setText('pi-tile-coord', target.row + ', ' + target.col);
  // What the view shows (rim falloff, this world's climate), not the raw grid.
  const shown = _dioramaRenderer?.shownCell(target.row, target.col) ?? null;
  const biome = shown?.biome ?? cell.biome;
  setText('pi-tile-biome', BIOME_LABELS[biome] ?? biome);

  // Shown relative to sea level, which is what the player can actually see.
  const rel = (shown?.elevation ?? cell.elevation) - SEA_LEVEL;
  setText('pi-tile-elev', rel < 0
    ? Math.round(-rel * 8000) + ' m below sea level'
    : Math.round(rel * 8000) + ' m above sea level');

  const tempC = shown?.tempC ?? Math.round(cell.temperature * 60 - 25);
  const humid = shown?.humidity ?? cell.moisture;
  setText('pi-tile-climate', tempC + '°C · ' + Math.round(humid * 100) + '% humidity');
  setText('pi-tile-fert', isHabitable(biome)
    ? Math.round(cell.fertility * 100) + '%' : 'Barren');
  setText('pi-tile-life', cell.lifeDensity > 0.01
    ? Math.round(cell.lifeDensity * 100) + '% coverage' : 'None');
  setText('pi-tile-civ', cell.civId != null
    ? (gameState.playerSpeciesName || engine?.getPlayerStar()?.civName || 'Settled')
    : 'Uninhabited');
  showTileNation(target);

  const occupant = cell.dominantSpeciesId
    ? gameState.playerSpecies.find(sp => sp.id === cell.dominantSpeciesId)
    : null;
  setText('pi-tile-species', occupant ? occupant.name : '—');
  setText('pi-tile-species-detail', occupant
    ? `${occupant.physicalTraits.size} · ${occupant.dna.locomotion} · ${occupant.dna.diet}`
    : '');

  buildTileActionButtons(cell, target);
}

/** The Nation row of the tile panel: flag, name, ways, and what a visitor would notice. */
function showTileNation(target: TileRef): void {
  const val = document.getElementById('pi-tile-nation');
  const ns = runtimeState.playerNations;
  const n = ns?.isFounded ? ns.nationAt(target.row, target.col) : null;
  if (val) {
    val.textContent = n ? n.name : 'None';
    if (n) {
      const f = flagCanvas(n.flag, 2);
      f.style.verticalAlign = 'middle';
      f.style.marginRight = '6px';
      val.prepend(f);
    }
  }
  const chron = document.getElementById('pi-tile-chronicle') as HTMLButtonElement | null;
  if (chron) {
    chron.style.display = n ? '' : 'none';
    const last = n?.history[n.history.length - 1];
    chron.onclick = n ? () => openChronicle({ nation: n.id, entry: last?.id }) : null;
  }
  if (!n) { setText('pi-tile-nation-detail', ''); return; }
  const signs = symptomsOf(n);
  const last = n.history[n.history.length - 1];
  const studying = n.research ? TECH_BY_ID[n.research.id]?.name : null;
  // Its dealings with the others, as a visitor would see them.
  const dealings: string[] = [];
  for (const o of ns!.nations) {
    if (o === n || o.fallen) continue;
    const r = ns!.relation(n.id, o.id);
    if (!r) continue;
    if (r.war) dealings.push(`Soldiers march against ${o.name}`);
    else if (r.trade) dealings.push(`Caravans come and go from ${o.name}`);
    else if (r.border > 0 && r.attitude < -0.4) dealings.push(`Watchtowers face ${o.name}`);
  }
  const builds = nationArch(_dioramaRenderer?.townArch ?? null, { values: n.values, government: n.government, color: n.color, id: n.id }).summary;
  setText('pi-tile-nation-detail', [
    `${n.era > 0 ? SUB_ERA_NAMES[subEraOf(n.techs, n.era)] + ' ' : ''}${TECH_LEVELS[n.era] ?? 'Primitive'} ${n.government.toLowerCase()} · ${n.ideology}`,
    `Builds ${builds}`,
    studying ? `Working on ${studying}` : '',
    dealings.length ? dealings.join('. ') + '.' : '',
    signs.length ? signs.join('. ') + '.' : 'Life is calm.',
    last && n.history.length > 1 ? last.what : '',
  ].filter(Boolean).join(' — '));
}

/** Wire pointer interaction on the diorama. Safe to call more than once. */
function attachTileInteraction(mount: HTMLElement): void {
  if (mount.dataset['tilesWired'] === '1') return;
  mount.dataset['tilesWired'] = '1';

  mount.addEventListener('mousemove', (e) => {
    if (!_dioramaRenderer) return;
    const hit = _dioramaRenderer.pickTile(e.clientX, e.clientY);
    _dioramaRenderer.setHighlight(hit);
    mount.style.cursor = hit ? 'pointer' : 'default';
  });

  mount.addEventListener('mouseleave', () => _dioramaRenderer?.setHighlight(null));

  mount.addEventListener('click', (e) => {
    if (!_dioramaRenderer) return;
    const hit = _dioramaRenderer.pickTile(e.clientX, e.clientY);
    if (!hit) return;
    AudioManager.playSfx('ui_click');
    showTileInfo(hit);
  });

  // Double-click opens the full surface map, centred on what was clicked. The
  // diorama only ever shows one hemisphere; this is the way to the other half.
  mount.addEventListener('dblclick', (e) => {
    e.preventDefault();
    AudioManager.playSfx('ui_click');
    openPlanetMap(_dioramaRenderer?.pickTile(e.clientX, e.clientY) ?? null);
  });
}

// ── Planet Info Panel ──────────────────────────────────────────────────────────

const TECH_DESCRIPTIONS: Record<number, string> = {
  0: 'Stone tools, fire, oral tradition. Survival drives all culture.',
  1: 'Agriculture, city-states, writing. Empires form and fall.',
  2: 'Feudal order, cathedrals, early metallurgy. Faith guides civilization.',
  3: 'Steam engines, factories, global trade. Nature begins to yield.',
  4: 'Nuclear fission, satellites, global communications. Existential risk emerges.',
  5: 'Interplanetary travel, fusion power, post-scarcity economies.',
  6: 'Star travel, megastructures, contact with other civilizations.',
  7: 'Biological transcendence, digital minds, incomprehensible art forms.',
  8: 'Consciousness distributed across light-years. Matter is merely a canvas.',
};

const SPECIES_ICONS: string[] = ['👁','🌿','🔥','❄️','🌊','⚡','🦴','🧠','✨'];

// Matches PlanetRenderer's formula: 10^(civLevel+3)
function calcPop(civLevel: number): number {
  return Math.floor(Math.pow(10, civLevel + 3));
}

function formatPop(n: number): string {
  if (n >= 1e15) return (n / 1e15).toFixed(1) + ' quadrillion';
  if (n >= 1e12) return (n / 1e12).toFixed(1) + ' trillion';
  if (n >= 1e9)  return (n / 1e9).toFixed(1) + ' billion';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + ' million';
  return Math.round(n / 1e3) + ' thousand';
}

// Which star the planet panel is currently showing. `onCultureGenerated` needs
// it to know whether a late Gemini result is worth re-rendering for.
let _panelStarId: number | null = null;

function buildPlanetInfoPanel(star: StarBody, planetIndex: number): void {
  _panelStarId = star.id;
  const planet = star.planets[planetIndex] ?? star.planets[0];
  const isPlayer = star.isPlayerStar;
  const dna = isPlayer ? gameState.playerPlanetDNA : null;
  const civLevel = star.civLevel;

  // ── OVERVIEW ──────────────────────────────────────────────
  const displayName = isPlayer && gameState.playerPlanetName !== '—'
    ? gameState.playerPlanetName
    : (planet?.name ?? star.civName + ' Prime');

  setText('pi-planet-name', displayName);
  setText('pi-type-badge', (planet?.type ?? 'unknown').toUpperCase());
  setText('pi-star-system', star.civName + ' System');
  setText('pi-planet-index', planet ? `Orbit ${planetIndex + 1} of ${star.planets.length}` : '—');

  // Sim age — rough years based on tick (each tick ~100 years by lore)
  const simYears = gameState.tick * 100;
  const ageStr = simYears >= 1e9 ? (simYears / 1e9).toFixed(1) + ' Gyr'
    : simYears >= 1e6 ? (simYears / 1e6).toFixed(0) + ' Myr'
    : simYears.toLocaleString() + ' yr';
  setText('pi-sim-age', ageStr);

  // Civilization / Phase
  if (star.formationStage) {
    const stageNames: Record<string, string> = {
      magma: 'Molten Formation', cooling: 'Cooling Crust', volcanic: 'Volcanic Era',
      atmosphere: 'Atmosphere Forming', ice_age: 'Ice Age', primordial: 'Primordial Ocean',
    };
    setText('pi-era', stageNames[star.formationStage] ?? star.formationStage);
    setText('pi-population', '—');
    setText('pi-biosphere', '0%');
    setStyle('pi-biosphere-bar', 'width', '0%');
  } else if (star.hasLife && star.biologyPhase !== 'intelligent') {
    // Still in biology phase — show phase name
    const phaseIdx = BIO_PHASE_SEQUENCE.indexOf(star.biologyPhase);
    const phasePct = Math.round((phaseIdx / (BIO_PHASE_SEQUENCE.length - 1)) * 100);
    setText('pi-era', BIO_PHASE_LABELS[star.biologyPhase]);
    setText('pi-population', '—');
    const biosphere = planet?.biosphere ?? 0;
    setText('pi-biosphere', Math.round(biosphere * 100) + '%');
    setStyle('pi-biosphere-bar', 'width', Math.round(biosphere * 100) + '%');
    // Show phase progress in biosphere bar color
    const phaseSect = document.getElementById('pi-biosphere-bar');
    if (phaseSect) phaseSect.style.setProperty('background', `hsl(${140 + phasePct},70%,45%)`);
  } else if (star.hasLife && star.biologyPhase === 'intelligent') {
    const civPhase = civLevelToPhase(civLevel);
    setText('pi-era', CIV_PHASE_LABELS[civPhase] + ` — ${eraName(star)}`);
    // How this civilisation builds (its architecture genome), once it does.
    const arch = star.isPlayerStar ? _dioramaRenderer?.townArch : null;
    setStyle('pi-arch-row', 'display', arch ? '' : 'none');
    if (arch) setText('pi-arch', arch.summary.charAt(0).toUpperCase() + arch.summary.slice(1));
    const biosphere = planet?.biosphere ?? 0;
    setText('pi-population', formatPop(calcPop(civLevel)));
    setText('pi-biosphere', Math.round(biosphere * 100) + '%');
    setStyle('pi-biosphere-bar', 'width', Math.round(biosphere * 100) + '%');
  } else {
    setStyle('pi-arch-row', 'display', 'none');
    setText('pi-era', 'No Life Detected');
    setText('pi-population', '—');
    setText('pi-biosphere', '0%');
    setStyle('pi-biosphere-bar', 'width', '0%');
  }

  // ── Habitability + biology (LifeSystem) ───────────────────
  // Only meaningful once the system has actually been surveyed — an uncharted
  // star should not leak its habitability score to the player.
  const surveyed = isPlayer || planet?.discovery === 'probe' || planet?.discovery === 'landing';
  const hab = surveyed ? engine?.habitabilityOf(star) : null;
  if (surveyed && hab != null) {
    const pctH = Math.round(hab * 100);
    const band = hab > 0.7 ? 'Ideal' : hab > 0.45 ? 'Viable'
               : hab > 0.2 ? 'Marginal' : 'Hostile';
    setText('pi-habitability', `${band} (${pctH}%)`);
  } else {
    setText('pi-habitability', surveyed ? '—' : 'Unsurveyed');
  }

  const bioSection = document.getElementById('pi-biology-section');
  if (bioSection) {
    if (surveyed && star.hasLife && star.lifeArchetype) {
      const profile = ARCHETYPES[star.lifeArchetype];
      bioSection.style.display = '';
      setText('pi-biochem', profile.label);

      const tempo = star.bioTempo ?? 1;
      const tempoWord = tempo > 2 ? 'Explosive' : tempo > 1.35 ? 'Rapid'
                      : tempo > 0.75 ? 'Steady' : tempo > 0.4 ? 'Slow' : 'Glacial';
      setText('pi-tempo', `${tempoWord} (${tempo.toFixed(2)}×)`);

      const stalls = star.bioStalls ?? 0;
      const ext = star.extinctions ?? 0;
      const status = stalls >= 3 ? `Stalled — ${stalls} failed transitions`
                   : stalls > 0 ? `Struggling — ${stalls} failed transition${stalls > 1 ? 's' : ''}`
                   : 'Advancing';
      setText('pi-bio-status', ext > 0 ? `${status} · ${ext} prior extinction${ext > 1 ? 's' : ''}` : status);
      setText('pi-biochem-note', profile.flavour);
    } else {
      bioSection.style.display = 'none';
    }
  }

  // DNA (player planet only)
  const dnaSection = document.getElementById('pi-dna-section');
  if (dna && dnaSection) {
    dnaSection.style.display = '';
    // While the Forge runs, the world's DNA is not known yet.
    const unformed = gameState.forge?.phase === 'draft';
    setText('pi-dna-climate', unformed ? 'unformed' : dna.climate);
    setText('pi-dna-oceans', unformed ? 'unformed' : dna.oceans.replace('_', ' '));
    setText('pi-dna-chaos', unformed ? 'unformed' : dna.chaos);
  } else if (dnaSection) {
    dnaSection.style.display = 'none';
  }

  // Religion
  const relSection = document.getElementById('pi-religion-section');
  const relName = isPlayer ? gameState.playerReligionName : star.religionName;
  if (relSection) {
    if (relName) {
      relSection.style.display = '';
      setText('pi-religion-name', relName);
      const dev = Math.round(star.religionDevotion * 100);
      setText('pi-devotion-pct', dev + '%');
      setStyle('pi-devotion-bar', 'width', dev + '%');
    } else {
      relSection.style.display = 'none';
    }
  }

  // Culture
  renderCultureSection(star);

  // Resources
  const resContainer = document.getElementById('pi-resources');
  if (resContainer) {
    if (!planet || planet.discovery === 'none') {
      resContainer.innerHTML = '<div class="pi-no-data">No survey data available</div>';
    } else {
      const resMap: [string, string, string][] = [];
      resMap.push(['Minerals', '#aaaaaa', 'minerals']);
      if (planet.type === 'rocky' || planet.type === 'lava') resMap.push(['Rare Metals', '#ffdd55', 'rare_metals']);
      if (planet.type === 'ice') resMap.push(['Energy Crystals', '#88ffee', 'energy_crystals']);
      if (planet.type === 'ocean') resMap.push(['Biological Resources', '#44aacc', 'biological']);
      if (planet.type === 'rocky') resMap.push(['Exotic Matter', '#ff88ff', 'exotic_matter']);
      resContainer.innerHTML = resMap.map(([label, color]) =>
        `<span class="pi-resource-dot"><span class="pi-res-swatch" style="background:${color};box-shadow:0 0 4px ${color};"></span>${label}</span>`
      ).join('');
    }
  }

  // ── CODEX ─────────────────────────────────────────────────
  const speciesName = isPlayer
    ? (gameState.playerSpeciesName || (star.hasLife ? 'Unnamed Species' : '—'))
    : (star.hasLife ? star.civName + 'ians' : '—');

  const iconEl = document.getElementById('pi-species-icon');
  // Another world's people: draw them (their form follows their body plan).
  const npcCiv = !isPlayer && star.biologyPhase === 'intelligent' ? gameState.civilizations[star.id] : undefined;
  const npcGenome = npcCiv ? genomeFromSummary(npcCiv.sourceGenome, `npc_${star.id}`) : null;
  if (iconEl) {
    const key = npcGenome ? `npc_${star.id}` : '';
    if (npcGenome) {
      if (iconEl.dataset['portrait'] !== key) {
        iconEl.textContent = '';
        const c = creatureCanvas(npcGenome, 40);
        c.style.imageRendering = 'pixelated';
        iconEl.appendChild(c);
        iconEl.dataset['portrait'] = key;
      }
    } else {
      iconEl.dataset['portrait'] = '';
      iconEl.textContent = star.hasLife ? SPECIES_ICONS[civLevel] : '—';
    }
  }
  setText('pi-species-name', speciesName);

  let speciesDesc = 'No life detected on this world.';
  if (star.formationStage) {
    speciesDesc = 'Planet still in formation. Life has not yet emerged.';
  } else if (star.hasLife && star.biologyPhase !== 'intelligent') {
    speciesDesc = `${BIO_PHASE_LABELS[star.biologyPhase]} · Evolving`;
    if (isPlayer) speciesDesc += ` · Invest DNA points to guide development`;
  } else if (star.hasLife) {
    speciesDesc = `Emerged on ${displayName} · ${eraName(star)}`;
    const form = npcGenome ? sapientFormOf(npcGenome) : null;
    if (form) speciesDesc = `A ${form} people · ${speciesDesc}`;
    if (dna) speciesDesc += ` · ${dna.climate} world`;
  }
  setText('pi-species-desc', speciesDesc);

  // Tech track
  const track = document.getElementById('pi-tech-track');
  if (track) {
    track.innerHTML = TECH_LEVELS.map((level, i) => {
      const cls = i < civLevel ? 'pi-tech-step reached' : i === civLevel ? 'pi-tech-step current' : 'pi-tech-step';
      const marker = i < civLevel ? '✓' : i === civLevel ? '▶' : '·';
      return `<div class="${cls}"><span style="width:14px;text-align:center;flex-shrink:0;">${marker}</span>${level}</div>`;
    }).join('');
  }

  setText('pi-tech-level', star.hasLife ? eraName(star) : 'N/A');
  setText('pi-tech-desc', star.hasLife ? (TECH_DESCRIPTIONS[civLevel] ?? '') : 'No civilization present.');

  // DNA codex section
  const codexDnaSection = document.getElementById('pi-codex-dna-section');
  if (dna && codexDnaSection) {
    codexDnaSection.style.display = '';
    const climateDesc: Record<string, string> = {
      temperate: 'Balanced seasons and moderate temperatures shape a world of great diversity.',
      desert:    'Vast arid expanses sculpted by heat and wind. Life clings to every shadow.',
      frozen:    'Perpetual cold locks the world in ice. Only the hardiest species endure.',
    };
    const oceansDesc: Record<string, string> = {
      barren:      'Minimal surface water. Civilizations built on dust and rare aquifers.',
      mixed:       'Continents and seas in balance — the cradle of complex ecologies.',
      ocean_world: 'The world is almost entirely ocean. Land is rare and sacred.',
    };
    const chaosDesc: Record<string, string> = {
      serene:    'Low geological activity. Ancient landscapes weathered smooth by time.',
      turbulent: 'Active tectonics and frequent storms keep evolution under pressure.',
      storm:     'Violent weather and seismic chaos — a world in perpetual upheaval.',
    };
    setText('pi-codex-dna-text',
      `Climate — ${dna.climate}: ${climateDesc[dna.climate] ?? ''}\n\n` +
      `Oceans — ${dna.oceans.replace('_',' ')}: ${oceansDesc[dna.oceans] ?? ''}\n\n` +
      `Chaos — ${dna.chaos}: ${chaosDesc[dna.chaos] ?? ''}`
    );
    const dnaEl = document.getElementById('pi-codex-dna-text');
    if (dnaEl) dnaEl.style.whiteSpace = 'pre-line';
  } else if (codexDnaSection) {
    codexDnaSection.style.display = 'none';
  }

  // ── LEGEND ────────────────────────────────────────────────
  buildTerrainLegend(planet?.type ?? 'rocky', dna);

  // Wire panel controls (only once — skip if already wired)
  if (!document.getElementById('pi-tabs')?.dataset['wired']) {
    document.getElementById('pi-tabs')!.dataset['wired'] = '1';

    // Tab switching
    document.querySelectorAll('.pi-tab').forEach(btn => {
      btn.addEventListener('click', function(this: HTMLElement) {
        const tab = this.dataset['tab'];
        if (!tab) return;
        document.querySelectorAll('.pi-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.pi-tab-content').forEach(c => c.classList.remove('active'));
        this.classList.add('active');
        document.getElementById(`pi-tab-${tab}`)?.classList.add('active');
      });
    });

    // Expand/collapse panel
    const expandBtn = document.getElementById('pi-expand-btn');
    const panel = document.getElementById('planet-info-panel');
    if (expandBtn && panel) {
      expandBtn.addEventListener('click', () => {
        const expanded = panel.classList.toggle('expanded');
        expandBtn.textContent = expanded ? '⇥' : '⇤';
        expandBtn.title = expanded ? 'Collapse panel' : 'Expand panel';
        // Resize canvas to fit new panel width (only when NPC planet-canvas is visible)
        const PANEL_W = expanded ? 620 : 340;
        const canvas = document.getElementById('planet-canvas') as HTMLCanvasElement;
        if (canvas.style.display !== 'none') {
          canvas.width = Math.max(400, window.innerWidth - PANEL_W);
        }
        // diorama fills via CSS — no resize needed
      });
    }

    // Accordion sections in Codex
    document.querySelectorAll('.pi-accordion-hdr').forEach(hdr => {
      hdr.addEventListener('click', function(this: HTMLElement) {
        const key = this.dataset['acc'];
        const body = document.getElementById(`pi-acc-${key}`);
        if (!body) return;
        const isOpen = body.classList.toggle('open');
        this.classList.toggle('open', isOpen);
      });
    });
  }
}

function setText(id: string, val: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setStyle(id: string, prop: string, val: string): void {
  const el = document.getElementById(id) as HTMLElement | null;
  if (el) el.style.setProperty(prop, val);
}

/** Show the civilisation's culture, or hide the section if it has none. */
function renderCultureSection(star: StarBody | null): void {
  const sec = document.getElementById('pi-culture-section');
  if (!sec) return;
  const civ = star ? engine?.cultureFor(star) ?? null : null;
  if (!civ) { sec.style.display = 'none'; return; }
  sec.style.display = '';

  setText('pi-gov', civ.government);
  setText('pi-ideology', civ.ideology);
  setText('pi-epithet', civ.epithet);
  setText('pi-arch', `${civ.architecture.settlementForm}, ${civ.architecture.material}`);
  setText('pi-culture-desc', civ.selfDescription);
  setText('pi-culture-origin', civ.origin === 'llm'
    ? 'Culture written by the AI God.'
    : 'Culture derived from biology.');

  const wrap = document.getElementById('pi-culture-values');
  if (!wrap) return;
  wrap.innerHTML = '';
  const rows: Array<[string, number]> = [
    ['Militarism', civ.values.militarism],
    ['Piety', civ.values.piety],
    ['Curiosity', civ.values.curiosity],
    ['Collectivism', civ.values.collectivism],
    ['Xenophobia', civ.values.xenophobia],
  ];
  for (const [label, v] of rows) {
    const row = document.createElement('div');
    row.className = 'pi-culture-bar-row';
    row.innerHTML = `<span></span><div class="pi-culture-track"><div class="pi-culture-fill"></div></div>`;
    row.querySelector('span')!.textContent = label;
    (row.querySelector('.pi-culture-fill') as HTMLElement).style.width =
      `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
    wrap.appendChild(row);
  }
}

function buildTerrainLegend(type: string, dna: typeof gameState.playerPlanetDNA): void {
  const container = document.getElementById('pi-legend-terrain');
  if (!container) return;

  type LegendEntry = [string, string]; // [color, label]
  let entries: LegendEntry[] = [];

  if (type === 'lava') {
    entries = [
      ['#ff2200','Lava Flows'],['#cc3300','Magma Lake'],['#552200','Igneous Rock'],
      ['#222222','Cooling Basalt'],
    ];
  } else if (type === 'ice') {
    entries = [
      ['#0a1e5a','Frozen Ocean'],['#3c6498','Ice Shelf'],['#a0c8e6','Tundra'],
      ['#c8d8f0','Permafrost'],['#646464','Bare Rock'],['#ffffff','Ice Peak'],
    ];
  } else if (type === 'gas') {
    entries = [
      ['#c8b480','Upper Cloud Band'],['#aa8844','Mid Atmosphere'],
      ['#886622','Deep Belt'],['#664422','Core Storm Zone'],
    ];
  } else if (type === 'ocean') {
    entries = [
      ['#0a3c8c','Deep Ocean'],['#1464b4','Shallow Sea'],
      ['#1878d2','Surface Wave'],['#4a8050','Land Mass'],
    ];
  } else {
    // rocky / temperate — modified by DNA
    const climate = dna?.climate ?? 'temperate';
    const oceans  = dna?.oceans  ?? 'mixed';
    if (climate === 'frozen') {
      entries = [
        ['#0a1e5a','Frozen Ocean'],['#3c6498','Ice Shelf'],['#a0c8e6','Tundra'],
        ['#c8d8f0','Snowfield'],['#646464','Rocky Ground'],['#ffffff','Mountain Peak'],
      ];
    } else if (climate === 'desert') {
      entries = [
        ['#28377a', oceans === 'barren' ? 'Brine Lake (rare)' : 'Inland Sea'],
        ['#a08250','Salt Flat'],['#b47840','Sand Dune'],
        ['#8c5c30','Canyon Wall'],['#6e4828','Mesa'],['#504038','Summit'],
      ];
    } else {
      entries = [
        ['#0a2878','Deep Ocean'],['#1450aa','Ocean'],['#beb078','Beach / Shore'],
        ['#3c8237','Plains'],['#237023','Forest'],['#645545','Mountain'],
        ['#f0f0f0','Snow Peak'],
      ];
    }
  }

  container.innerHTML = entries.map(([color, label]) =>
    `<div class="pi-legend-row">` +
    `<div class="pi-legend-swatch" style="background:${color};"></div>` +
    `<span>${label}</span></div>`
  ).join('');
}

function openSystemPanel(star: StarBody): void {
  const panel = document.getElementById('star-info-panel');
  const nameEl = document.getElementById('star-info-name');
  const techEl = document.getElementById('star-info-tech');
  if (!panel || !nameEl || !techEl) return;

  const sysName = star.isPlayerStar
    ? `◎ ${(gameState.playerPlanetName || star.civName).toUpperCase()} SYSTEM`
    : star.civName.toUpperCase() + ' SYSTEM';
  nameEl.textContent = sysName;

  const knownCount = star.planets.filter(p => p.discovery !== 'none').length;
  const civInfo = star.hasLife ? eraName(star) : 'No intelligent life';
  const starLeader = gameState.leaders.find(l => l.starId === star.id);
  const leaderInfo = starLeader ? ` | ${starLeader.ideology} — ${starLeader.name}` : '';
  techEl.textContent = `${civInfo}${leaderInfo}  ·  ${knownCount}/${star.planets.length} planets charted`;

  drawSystemOrrery(star);
  buildStarPlanetList(star);
  panel.style.display = 'block';
}

function drawSystemOrrery(star: StarBody): void {
  const canvas = document.getElementById('sys-orrery') as HTMLCanvasElement | null;
  if (!canvas) return;
  const W = canvas.width = canvas.offsetWidth || 460;
  const H = canvas.height = 72;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  const starX = 30;
  const cy = H / 2;

  // Star color by temperature
  const t = star.temperature;
  const starColor = t > 15000 ? '#aaccff' : t > 8000 ? '#eeeeff' : t > 5000 ? '#ffffcc' : t > 3500 ? '#ffcc88' : '#ff8844';

  // Star glow
  const sg = ctx.createRadialGradient(starX, cy, 0, starX, cy, 16);
  sg.addColorStop(0, starColor);
  sg.addColorStop(0.5, starColor + '55');
  sg.addColorStop(1, 'transparent');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(starX, cy, 16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = starColor;
  ctx.beginPath(); ctx.arc(starX, cy, 5, 0, Math.PI * 2); ctx.fill();

  // Draw faction flag above star glow if civ present
  const orrFlag = gameState.factionFlags[star.id];
  if (orrFlag && star.civLevel >= 1) {
    drawFactionFlag(ctx, orrFlag, 12, 8, 8);
  }

  if (star.planets.length === 0) return;

  const PCOLORS: Record<string, string> = {
    rocky: '#c8a96e', ocean: '#44aaff', gas: '#bb88ff', ice: '#aaddff', lava: '#ff4422',
  };

  const maxOrb = Math.max(...star.planets.map(p => p.orbitalRadius));
  const orrW = W - starX - 16;

  star.planets.forEach((planet, i) => {
    const px = starX + 16 + (planet.orbitalRadius / maxOrb) * (orrW - 8);
    const unknown = planet.discovery === 'none';
    const col = unknown ? '#1e1e2e' : (PCOLORS[planet.type] ?? '#888');
    const pr = Math.max(3, Math.min(7, planet.radius * 1.1));

    // Orbit dash line
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(starX + 6, cy); ctx.lineTo(px, cy); ctx.stroke();
    ctx.setLineDash([]);

    if (!unknown) {
      const pg = ctx.createRadialGradient(px, cy, 0, px, cy, pr + 5);
      pg.addColorStop(0, col + '55'); pg.addColorStop(1, 'transparent');
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(px, cy, pr + 5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = unknown ? '#141420' : col;
    ctx.strokeStyle = unknown ? '#252535' : col + 'bb';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, cy, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    // Index label
    ctx.fillStyle = unknown ? '#2a2a3a' : 'rgba(200,200,255,0.35)';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), px, cy + pr + 10);
  });
}

function buildStarPlanetList(star: StarBody): void {
  const list = document.getElementById('star-planet-list');
  if (!list) return;
  list.innerHTML = '';

  const TYPE_ICONS: Record<string, string> = {
    rocky: '◼', ocean: '◉', gas: '◌', ice: '◈', lava: '▲',
  };

  star.planets.forEach((planet: Planet, idx: number) => {
    const isHome = star.isPlayerStar && planet.hasLife;
    const displayName = (isHome && gameState.playerPlanetName)
      ? gameState.playerPlanetName
      : planet.name;

    const row = document.createElement('div');

    if (planet.discovery === 'none') {
      // Completely uncharted — show orbital slot only
      row.className = 'planet-row planet-row-unknown';
      row.innerHTML = `
        <span class="planet-row-icon" style="color:#252535">◌</span>
        <div class="planet-row-info">
          <div class="planet-row-name" style="color:#333">Orbital Body ${idx + 1}</div>
          <div class="planet-row-detail">No data available</div>
        </div>
        <span class="planet-row-badge badge-none">UNCHARTED</span>
      `;

    } else if (planet.discovery === 'telescope' && !isHome) {
      // Eyesight — name detected, no classification data
      row.className = 'planet-row';
      row.innerHTML = `
        <span class="planet-row-icon" style="color:#445566">◌</span>
        <div class="planet-row-info">
          <div class="planet-row-name">${displayName}</div>
          <div class="planet-row-detail">Detected at distance — classification unknown</div>
        </div>
        <span class="planet-row-badge badge-eyesight">SIGHTED</span>
      `;

    } else if (planet.discovery === 'probe' && !isHome) {
      // Telescope / satellite scan — limited data
      const icon = TYPE_ICONS[planet.type] ?? '·';
      const typeLabel = planet.type.charAt(0).toUpperCase() + planet.type.slice(1);
      const lifeStr = planet.hasLife ? 'Bio-signatures detected' : 'No life detected';
      row.className = 'planet-row';
      row.innerHTML = `
        <span class="planet-row-icon">${icon}</span>
        <div class="planet-row-info">
          <div class="planet-row-name">${displayName}</div>
          <div class="planet-row-detail">${typeLabel} · ⌀${planet.radius.toFixed(1)} · ${lifeStr}</div>
        </div>
        <span class="planet-row-badge badge-probe">SCANNED</span>
      `;

    } else {
      // Full data — landing/colonized OR player's home world
      const icon = TYPE_ICONS[planet.type] ?? '·';
      const typeLabel = planet.type.charAt(0).toUpperCase() + planet.type.slice(1);
      const bioStr = planet.biosphere > 0 ? ` · Biosphere ${Math.round(planet.biosphere * 100)}%` : '';
      const lifeStr = planet.hasLife ? 'Life confirmed' : 'Barren';
      const badgeLabel = isHome ? 'HOME WORLD' : 'COLONIZED';
      const badgeClass = isHome ? 'badge-home' : 'badge-landing';

      row.className = 'planet-row' + (isHome ? ' planet-row-home' : '');
      row.innerHTML = `
        <span class="planet-row-icon">${icon}</span>
        <div class="planet-row-info">
          <div class="planet-row-name">${displayName}</div>
          <div class="planet-row-detail">${typeLabel} · ${lifeStr}${bioStr} · ⌀${planet.radius.toFixed(1)}</div>
        </div>
        <span class="planet-row-badge ${badgeClass}">${badgeLabel}</span>
      `;

      const viewBtn = document.createElement('button');
      viewBtn.className = 'star-btn planet-view-btn';
      viewBtn.textContent = isHome ? '◎ VIEW MY WORLD' : '◎ VIEW SURFACE';
      viewBtn.addEventListener('click', () => {
        document.getElementById('star-info-panel')!.style.display = 'none';
        openPlanetView(star, idx);
      });
      row.appendChild(viewBtn);
    }

    list.appendChild(row);
  });
}

/** The planet (surface) view is shown with inline display:flex, not a class. */
function planetViewOpen(): boolean {
  const el = document.getElementById('planet-overlay');
  return !!el && el.style.display !== 'none' && el.style.display !== '';
}

function closePlanetView(): void {
  document.getElementById('planet-overlay')!.style.display = 'none';
  planetRenderer?.stop();
  _dioramaRenderer?.pause();
  _dioramaRenderer?.setHighlight(null);
  if (engine) engine.suspendWorldDraw = false;
}

function updateHUDTick(tick: number): void {
  const vAge = tick * 10;
  const ageStr = vAge > 1e9 ? `${(vAge / 1e9).toFixed(1)}B` :
                 vAge > 1e6 ? `${(vAge / 1e6).toFixed(1)}M` :
                 vAge > 1e3 ? `${(vAge / 1e3).toFixed(0)}K` : String(vAge);

  const tickEl = document.getElementById('tick-display');
  if (tickEl) tickEl.textContent = `TICK: ${tick.toLocaleString()}  |  AGE: ${ageStr} YRS`;
  const ageEl = document.getElementById('age-bar');
  if (ageEl) ageEl.textContent = `${ageStr} YRS`;

  setResourceChip('dp-display', 'dp-display-val', gameState.divinePoints);

  updateDivineActions();
}

/** Top-bar resource chips keep label markup; only update the value node. */
function setResourceChip(chipId: string, valId: string, value: number | string): void {
  const chip = document.getElementById(chipId);
  const val = document.getElementById(valId);
  if (chip) chip.style.display = '';
  if (val) val.textContent = String(value);
}

function renderSegmentBar(elId: string, filled: number, totalSegs = 20): void {
  const el = document.getElementById(elId);
  if (!el) return;
  const on = Math.max(0, Math.min(totalSegs, Math.round(filled)));
  if (el.childElementCount !== totalSegs) {
    el.innerHTML = Array.from({ length: totalSegs }, (_, i) =>
      `<span class="${i < on ? 'on' : ''}"></span>`
    ).join('');
  } else {
    Array.from(el.children).forEach((child, i) => child.classList.toggle('on', i < on));
  }
}

function updateBottomBar(star: { civName: string; civLevel: number; hasLife: boolean }): void {
  const el1 = document.getElementById('planet-name-bar');
  const el2 = document.getElementById('species-bar');
  const el3 = document.getElementById('civ-bar');
  const planetLabel = gameState.playerPlanetName !== '—' ? gameState.playerPlanetName : star.civName + ' Prime';
  if (el1) el1.textContent = planetLabel.toUpperCase();
  const speciesLabel = gameState.playerSpeciesName
    ? gameState.playerSpeciesName.toUpperCase()
    : (star.hasLife ? 'DETECTED' : 'NONE');
  if (el2) el2.textContent = speciesLabel;
  // Civ bar: show TECH_LEVELS only once intelligent
  const ps = engine?.getPlayerStar();
  const inBioPhase = ps && ps.biologyPhase !== 'intelligent';
  if (el3) el3.textContent = inBioPhase ? '—' : (star.hasLife ? eraName(star as StarBody) : '—');
  updatePhaseBar();
}

// ─── Species Traits Modal ──────────────────────────────────────────────────────

function openTraitsModal(): void {
  const overlay = document.getElementById('traits-overlay');
  if (!overlay) return;

  // Reset selections
  overlay.querySelectorAll('.tm-option').forEach(el => el.classList.remove('selected'));
  overlay.querySelectorAll('.tm-cat-check').forEach(el => el.classList.remove('selected'));
  overlay.querySelectorAll('.tm-pip').forEach(el => el.classList.remove('done'));
  const countEl = document.getElementById('tm-progress-count');
  if (countEl) countEl.textContent = '0 / 6';
  const noticeEl = document.getElementById('tm-selection-notice');
  if (noticeEl) noticeEl.textContent = 'Select one trait from each category';
  const evolveBtn = document.getElementById('traits-evolve-btn') as HTMLButtonElement | null;
  if (evolveBtn) { evolveBtn.disabled = true; evolveBtn.classList.remove('ready'); }

  // Pre-fill species name
  const nameInput = document.getElementById('traits-species-name') as HTMLInputElement | null;
  if (nameInput) nameInput.value = gameState.playerSpeciesName ?? '';

  // Re-select previously chosen traits if any
  Object.entries(gameState.playerSpeciesTraits).forEach(([cat, val]) => {
    const opt = overlay.querySelector(`.tm-option[data-category="${cat}"][data-value="${val}"]`);
    if (opt) opt.classList.add('selected');
    const check = document.getElementById(`check-${cat}`);
    if (check) check.classList.add('selected');
  });

  overlay.classList.add('open');
  checkTraitsReady();
}

function checkTraitsReady(): void {
  const overlay = document.getElementById('traits-overlay');
  if (!overlay) return;
  const selected = overlay.querySelectorAll('.tm-option.selected');
  const count = selected.length;
  const countEl = document.getElementById('tm-progress-count');
  if (countEl) countEl.textContent = `${count} / 6`;

  // Fill pips
  overlay.querySelectorAll('.tm-pip').forEach((pip, i) => {
    pip.classList.toggle('done', i < count);
  });

  const nameInput = document.getElementById('traits-species-name') as HTMLInputElement | null;
  const allSelected = count === 6 && (nameInput?.value.trim() ?? '') !== '';
  const evolveBtn = document.getElementById('traits-evolve-btn') as HTMLButtonElement | null;
  if (evolveBtn) { evolveBtn.disabled = !allSelected; evolveBtn.classList.toggle('ready', allSelected); }

  const noticeEl = document.getElementById('tm-selection-notice');
  if (noticeEl) {
    noticeEl.textContent = allSelected
      ? 'All traits selected — ready to evolve'
      : count === 6 ? 'Name your species to continue' : 'Select one trait from each category';
  }
}

function wireTraitsModal(): void {
  const overlay = document.getElementById('traits-overlay');
  if (!overlay) return;

  // Option card selection
  overlay.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest('.tm-option') as HTMLElement | null;
    if (!opt) return;
    const cat = opt.dataset['category'];
    if (!cat) return;
    overlay.querySelectorAll(`.tm-option[data-category="${cat}"]`).forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    const check = document.getElementById(`check-${cat}`);
    if (check) check.classList.add('selected');
    checkTraitsReady();
  });

  // Species name input
  document.getElementById('traits-species-name')?.addEventListener('input', checkTraitsReady);

  // Close buttons
  document.getElementById('traits-close-btn')?.addEventListener('click', () => {
    document.getElementById('traits-overlay')?.classList.remove('open');
  });
  document.getElementById('traits-close-btn-footer')?.addEventListener('click', () => {
    document.getElementById('traits-overlay')?.classList.remove('open');
  });

  // Evolve button
  document.getElementById('traits-evolve-btn')?.addEventListener('click', () => {
    const selected: Record<string, string> = {};
    overlay.querySelectorAll('.tm-option.selected').forEach((el) => {
      const e = el as HTMLElement;
      if (e.dataset['category'] && e.dataset['value']) {
        selected[e.dataset['category']] = e.dataset['value'];
      }
    });
    const nameInput = document.getElementById('traits-species-name') as HTMLInputElement | null;
    const speciesName = nameInput?.value.trim() ?? gameState.playerSpeciesName;
    if (Object.keys(selected).length < 6 || !speciesName) return;
    commitEvolution(selected, speciesName);
    overlay.classList.remove('open');
  });
}

function commitEvolution(traits: Record<string, string>, speciesName: string): void {
  // No point deduction — evolution is triggered per branch milestone (every 10 pts),
  // points were already spent when the player incremented the branch.
  gameState.playerSpeciesTraits = { ...traits };
  if (speciesName) gameState.playerSpeciesName = speciesName;

  // Apply current DNA branch distribution permanently to player star
  const ps = engine?.getPlayerStar();
  if (ps) ps.dna = { ...gameState.playerDNA };

  updateDNAPanel();

  addFeedEntry(`Evolution event: ${speciesName} species traits locked`, 'milestone');

  // Build Gemini prompt for species description
  const dna = gameState.playerDNA;
  const traitLines = Object.entries(traits).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  const dnaLines = currentBranchDefs()
    .map(d => `  ${d.label}: ${dna[d.id] ?? 0}/100 — ${d.blurb}`).join('\n');
  const prompt =
    `You are the God narrator of a cosmic simulation game called Eternal Systems.\n` +
    `A new intelligent species has evolved on the planet ${gameState.playerPlanetName}.\n` +
    `Species name: ${speciesName}\n` +
    `DNA profile:\n${dnaLines}\n` +
    `Physical traits chosen by the divine player:\n${traitLines}\n\n` +
    `Write a 3–4 sentence poetic description of this species — their appearance, behaviour, and essence. ` +
    `Address the player directly ("Your people are..."). Be vivid and specific. No preamble, no quotes.`;

  if (geminiKey) {
    void (async () => {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
        );
        if (!resp.ok) return;
        const json = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const desc = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
        if (desc) {
          gameState.playerSpeciesDescription = desc;
          const entry = addCodexEntry(`${speciesName} — Species Codex`, 'biology', desc);
          entry.body = desc;
          addChatMessage(desc, 'god');
        }
      } catch { /* silent */ }
    })();
  } else {
    const desc = `Your people, the ${speciesName}, have taken their first steps into a wider cosmos. ` +
      `${traits['bodyPlan'] ?? 'Bipedal'} in form, driven by ${dna.aggression > 5 ? 'conquest' : 'curiosity'}, ` +
      `they carry within them the weight of your divine design.`;
    gameState.playerSpeciesDescription = desc;
    addCodexEntry(`${speciesName} — Species Codex`, 'biology', desc);
    addChatMessage(desc, 'god');
  }
}

// ─── Phase bar in bottom bar ───────────────────────────────────────────────────
function updatePhaseBar(): void {
  const phaseEl = document.getElementById('phase-bar');
  if (!phaseEl) return;
  const ps = engine?.getPlayerStar();
  if (!ps) return;

  if (ps.formationDestiny && ps.formationStage) {
    // Still forming: the bar is the formation ladder, filled by progress.
    phaseEl.textContent = `FORMING · ${FORMATION_STAGE_LABELS[ps.formationStage] ?? ps.formationStage}`.toUpperCase();
    phaseEl.style.color = '#ff9a4a';
    renderSegmentBar('phase-segs', (engine?.homeFormationFraction() ?? 0) * 12, 12);
    return;
  }

  if (ps.biologyPhase !== 'intelligent') {
    phaseEl.textContent = BIO_PHASE_LABELS[ps.biologyPhase].toUpperCase();
    phaseEl.style.color = '#44cc88';
    const phIdx = BIO_PHASE_SEQUENCE.indexOf(ps.biologyPhase);
    renderSegmentBar('phase-segs', ((phIdx + 1) / BIO_PHASE_SEQUENCE.length) * 12, 12);
    // Show DNA panel if there are points to spend
    if (gameState.dnaPoints > 0) {
      document.getElementById('dna-panel')?.classList.add('visible');
    }
    updateDNAPanel();
  } else {
    const phase = civLevelToPhase(ps.civLevel);
    phaseEl.textContent = CIV_PHASE_LABELS[phase].toUpperCase();
    phaseEl.style.color = '';
    renderSegmentBar('phase-segs', ((ps.civLevel + 1) / 10) * 12, 12);
  }
}

// ─── DNA Investment Panel ─────────────────────────────────────────────────────
// Colour and glyph now travel with each branch definition, because the branch
// set itself is rolled per universe rather than being a fixed list of eight.
function currentBranchDefs(): BranchDef[] {
  return runtimeState.branchDefs;
}

function updateDNAPanel(): void {
  const panel = document.getElementById('dna-panel');
  if (!panel) return;
  const ps = engine?.getPlayerStar();
  if (!ps) return;

  const points = gameState.dnaPoints;

  // Phase badge + name + progress
  const phIdx = BIO_PHASE_SEQUENCE.indexOf(ps.biologyPhase);
  const progressPct = phIdx >= 0 ? Math.round((phIdx / (BIO_PHASE_SEQUENCE.length - 1)) * 100) : 100;
  const phaseLabel = BIO_PHASE_LABELS[ps.biologyPhase] ?? 'Intelligent Species';
  const phaseBadge = phaseLabel.split(' ')[0];
  const phEl = document.getElementById('el-phase-name');
  const phBadge = document.getElementById('el-phase-badge');
  const phPct = document.getElementById('el-phase-pct');
  const phBar = document.getElementById('dna-phase-bar');
  if (phEl) phEl.textContent = phaseLabel;
  if (phBadge) phBadge.textContent = phaseBadge;
  if (phPct) phPct.textContent = progressPct + '%';
  if (phBar) (phBar as HTMLElement).style.width = progressPct + '%';

  // DNA count: unspent points, and the bar fills toward the cheapest card on offer.
  const ctx = mutationContext();
  const states = cardStates(ctx);
  const cheapest = states.filter(c => c.status === 'available').reduce((m, c) => Math.min(m, c.def.cost), Infinity);
  const accumCount = document.getElementById('el-accum-count');
  const accumFill  = document.getElementById('el-accum-fill');
  if (accumCount) accumCount.textContent = `${points} DNA`;
  if (accumFill) {
    const pct = Number.isFinite(cheapest) ? Math.min(100, (points / cheapest) * 100) : 0;
    (accumFill as HTMLElement).style.width = pct + '%';
    accumFill.classList.toggle('full', Number.isFinite(cheapest) && points >= cheapest);
  }

  // Top-bar DNA display + bottom segmented bar
  setResourceChip('dna-display', 'dna-display-val', points);
  const statusDna = document.getElementById('status-dna-count');
  if (statusDna) statusDna.textContent = `${points} DNA`;
  renderSegmentBar('status-dna-segs', Math.min(20, points / 2), 20);

  // Summary of the signature species: the same state the lab shows.
  const sp = labSpecimen();
  const box = document.getElementById('dna-branch-rows');
  const queue = gameState.mutationQueue;
  const ready = !!sp && queueReady(queue);
  if (box) {
    box.innerHTML = '';
    if (sp) {
      const row = document.createElement('div');
      row.className = 'el-sig-row';
      row.appendChild(creatureCanvas(sp, 44));
      const t = document.createElement('div');
      t.innerHTML = '<div class="el-sig-name"></div><div class="el-sig-form"></div>';
      t.querySelector('.el-sig-name')!.textContent = sp.name;
      t.querySelector('.el-sig-form')!.textContent =
        `Form ${roman(Math.max(1, gameState.speciesForms.length))} · ${gameState.mutationsOwned.length} mutations`;
      row.appendChild(t);
      box.appendChild(row);
    }
  }
  const note = document.getElementById('el-focus-note');
  if (note) {
    const affordable = states.filter(c => c.status === 'available' && c.affordable).length;
    note.textContent = !sp ? 'Your species appears when life takes hold.'
      : ready ? 'Mutations queued — your species is ready to evolve!'
      : queue.length > 0 ? `${queue.length} mutation queued. Queue ${EVOLVE_THRESHOLD - queue.length} more, or one major card.`
      : affordable > 0 ? `${affordable} mutation${affordable > 1 ? 's' : ''} affordable now.`
      : 'Earn DNA as your species spreads, branches and outlasts rivals.';
  }
  const commitBtn = document.getElementById('el-commit-btn') as HTMLButtonElement | null;
  if (commitBtn) {
    commitBtn.disabled = false;
    commitBtn.classList.toggle('ready', ready);
    commitBtn.textContent = ready ? '◈ EVOLVE READY ◈' : 'OPEN EVOLUTION LAB';
  }
}

/** Position of the player's world on the biology ladder, 0 = microbial. */
function currentPhaseIndex(): number {
  const ps = engine?.getPlayerStar();
  if (!ps) return 0;
  return Math.max(0, BIO_PHASE_SEQUENCE.indexOf(ps.biologyPhase));
}


// ─── War Dice Modal ───────────────────────────────────────────────────────────
const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅']; // index 1–6

function openWarDiceModal(warId: number, attackerName: string, defenderName: string, attackerDice: number[], attackerColor: string, phase: string, playerIsDefender = false): void {
  const overlay = document.getElementById('war-dice-overlay');
  if (!overlay) return;
  slowForEvent(1);

  _warDiceWarId = warId;
  _warDiceAttackerDice = attackerDice;

  // Set header labels
  const warTypeLabel = playerIsDefender ? 'HOMELAND DEFENSE' : 'INTERGALACTIC WAR';
  const phaseLabel = phase === 'siege'
    ? `🔴 ${warTypeLabel} — SIEGE BEGINS — ROLL FOR YOUR SURVIVAL`
    : `⚔ ${warTypeLabel} — CAMPAIGN BEGINS — ROLL TO DEFEND`;
  const el = (id: string) => document.getElementById(id);
  const setText = (id: string, v: string) => { const e = el(id); if (e) e.textContent = v; };
  setText('wd-phase-label', phaseLabel);
  setText('wd-attacker-name', attackerName.toUpperCase());
  setText('wd-defender-name', defenderName.toUpperCase() || 'YOUR FORCES');

  // Reset outcome + result labels
  const outcome = el('wd-outcome') as HTMLElement | null;
  if (outcome) { outcome.style.display = 'none'; outcome.className = 'wd-outcome'; outcome.textContent = ''; }
  setText('wd-atk-result', '');
  setText('wd-def-result', '');

  // Reset roll button
  const rollBtn = el('wd-roll-btn') as HTMLButtonElement | null;
  if (rollBtn) { rollBtn.disabled = false; rollBtn.textContent = '🎲 ROLL DEFENSE'; }

  // Render attacker dice with roll animation
  const atkRow = el('wd-atk-dice');
  if (atkRow) {
    atkRow.innerHTML = attackerDice.map(d =>
      `<div class="wd-die atk rolling" style="border-color:${attackerColor}55;color:${attackerColor}">${DICE_FACES[d] ?? d}</div>`
    ).join('');
    setTimeout(() => {
      atkRow.querySelectorAll('.wd-die').forEach(die => die.classList.remove('rolling'));
    }, 450);
  }

  // Reset defender dice to question marks
  const defRow = el('wd-def-dice');
  if (defRow) {
    defRow.innerHTML = `<div class="wd-die def">?</div><div class="wd-die def">?</div><div class="wd-die def">?</div>`;
  }

  overlay.classList.add('open');

  // Auto-dismiss after 20s with neutral result if player ignores it
  if (_warDiceDismissTimeout) clearTimeout(_warDiceDismissTimeout);
  _warDiceDismissTimeout = setTimeout(() => closeWarDiceModal(), 20_000);
}

function rollDefenseDice(): void {
  const rollBtn = document.getElementById('wd-roll-btn') as HTMLButtonElement | null;
  if (!rollBtn || rollBtn.disabled) return;
  rollBtn.disabled = true;

  // Roll 3 defense dice
  const defDice = [
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
  ].sort((a, b) => b - a);

  const defRow = document.getElementById('wd-def-dice');
  if (defRow) {
    defRow.innerHTML = defDice.map(d =>
      `<div class="wd-die def rolling">${DICE_FACES[d] ?? d}</div>`
    ).join('');
    setTimeout(() => defRow.querySelectorAll('.wd-die').forEach(d => d.classList.remove('rolling')), 450);
  }

  // Compare pairs (Risk rules: attacker wins ties)
  const pairs = Math.min(_warDiceAttackerDice.length, defDice.length, 2);
  let defWins = 0, atkWins = 0;
  const atkDiceEls = document.getElementById('wd-atk-dice')?.querySelectorAll('.wd-die');
  const defDiceEls = defRow?.querySelectorAll('.wd-die');

  for (let i = 0; i < pairs; i++) {
    const a = _warDiceAttackerDice[i] ?? 0;
    const d = defDice[i] ?? 0;
    if (d > a) {
      defWins++;
      defDiceEls?.[i]?.classList.add('win');
      atkDiceEls?.[i]?.classList.add('lose');
    } else {
      atkWins++;
      atkDiceEls?.[i]?.classList.add('win');
      defDiceEls?.[i]?.classList.add('lose');
    }
  }

  // Apply result to war
  const netDef = defWins - atkWins; // positive = defender gained, negative = attacker gained
  engine?.applyBattleResult(_warDiceWarId, netDef);

  // Show result text
  const setText = (id: string, v: string) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  setText('wd-atk-result', atkWins === 2 ? 'DOMINANT ASSAULT' : atkWins === 1 ? 'PARTIAL ADVANCE' : 'REPELLED');
  setText('wd-def-result', defWins === 2 ? 'TOTAL DEFENSE' : defWins === 1 ? 'HELD THE LINE' : 'OVERRUN');

  // Outcome banner
  const outcome = document.getElementById('wd-outcome') as HTMLElement | null;
  if (outcome) {
    outcome.style.display = '';
    if (netDef > 0) {
      outcome.className = 'wd-outcome victory';
      outcome.textContent = `Your forces held! Defender strength bolstered. The invaders are pushed back.`;
    } else if (netDef < 0) {
      outcome.className = 'wd-outcome defeat';
      outcome.textContent = `The invaders break through. Attacker gains momentum — shore up your defenses.`;
    } else {
      outcome.className = 'wd-outcome stalemate';
      outcome.textContent = `Both sides absorb equal losses. The battle grinds on.`;
    }
  }

  rollBtn.textContent = '✓ BATTLE RESOLVED';
  if (_warDiceDismissTimeout) clearTimeout(_warDiceDismissTimeout);
  _warDiceDismissTimeout = setTimeout(() => closeWarDiceModal(), 8_000);
}

function closeWarDiceModal(): void {
  document.getElementById('war-dice-overlay')?.classList.remove('open');
  if (_warDiceDismissTimeout) { clearTimeout(_warDiceDismissTimeout); _warDiceDismissTimeout = null; }
  restoreSpeed();
}

// ─── Codex Modal ──────────────────────────────────────────────────────────────
// Includes the generated record categories (species, flora) as well as the
// stored milestone ones, so the index signature has to be a plain string.
const CODEX_CAT_LABELS: Record<string, string> = {
  biology: '🧬 Biology', civilisation: '🏛 Civilisation',
  war: '⚔ War', extinction: '💀 Extinction', divine: '✦ Divine',
  species: '🐾 Species', flora: '🌿 Flora',
};

let _codexFilter = 'all';
let _codexSearch = '';
let _codexActiveId: string | null = null;

/**
 * Escape text before it is concatenated into an innerHTML template.
 *
 * Codex record titles/subtitles can now carry LLM-generated text (a
 * civilisation's `epithet`), so the list markup below is no longer safe to
 * build with a bare template literal the way it always has been.
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch] ?? ch
  ));
}

function addCodexEntry(title: string, category: CodexEntry['category'], body = ''): CodexEntry {
  const entry: CodexEntry = { id: uuid(), tick: gameState.tick, title, body, category };
  gameState.codexEntries.push(entry);
  if (geminiKey && !body) void narrateCodexEntry(entry);
  return entry;
}

async function narrateCodexEntry(entry: CodexEntry): Promise<void> {
  const planet = gameState.playerPlanetName || 'the home world';
  const prompt = `You are the God narrator of a cosmic simulation. In 2-3 sentences, narrate the moment "${entry.title}" (category: ${entry.category}) in the universe centred on ${planet}. Be poetic and cosmic in tone. No preamble, no quotes.`;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    if (!resp.ok) return;
    const json = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const body = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (body) { entry.body = body; }
  } catch { /* silent */ }
}

function openCodex(): void {
  const overlay = document.getElementById('codex-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  _codexFilter = 'all';
  _codexSearch = '';
  const searchEl = document.getElementById('codex-search') as HTMLInputElement | null;
  if (searchEl) searchEl.value = '';
  document.querySelectorAll('.codex-tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset['cat'] === 'all'));
  _codexActiveId = null;
  renderCodexList();
}

function closeCodex(): void {
  document.getElementById('codex-overlay')?.classList.remove('open');
}

function renderCodexList(): void {
  const listEl = document.getElementById('codex-entry-list');
  const countEl = document.getElementById('codex-count');
  const detailEl = document.getElementById('codex-entry-detail');
  if (!listEl) return;

  const all = codexRecords();
  const q = _codexSearch.trim().toLowerCase();
  const filtered = all.filter(r =>
    (_codexFilter === 'all' || r.category === _codexFilter) &&
    (q === '' || r.haystack.includes(q) || r.title.toLowerCase().includes(q)));

  if (countEl) {
    const n = all.length;
    countEl.textContent = q || _codexFilter !== 'all'
      ? `${filtered.length} of ${n} records`
      : `${n} record${n === 1 ? '' : 's'}`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = q
      ? '<div class="codex-empty-list">Nothing matches<br>that search.</div>'
      : '<div class="codex-empty-list">No records found<br>in this category.<br><br>Explore the cosmos.</div>';
    if (detailEl) detailEl.innerHTML = '<div class="codex-detail-empty">Select a record to read its history.</div>';
    return;
  }

  // Newest first, so the most recent thing to happen is at the top.
  const sorted = [...filtered].sort((a, b) => b.tick - a.tick);
  listEl.innerHTML = sorted.map(r => {
    const badge = CODEX_CAT_LABELS[r.category] ?? r.category;
    const dead = r.species?.isExtinct ? ' extinct' : '';
    return `<div class="codex-entry-item${r.id === _codexActiveId ? ' active' : ''}${dead}" data-id="${r.id}">
      <div class="codex-entry-name">${escapeHtml(r.title)}</div>
      <div class="codex-entry-age">${escapeHtml(r.subtitle)}</div>
      <span class="codex-entry-cat-badge ${r.category}">${badge}</span>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.codex-entry-item').forEach(el => {
    el.addEventListener('click', function(this: HTMLElement) {
      _codexActiveId = this.dataset['id'] ?? null;
      listEl.querySelectorAll('.codex-entry-item').forEach(i => i.classList.remove('active'));
      this.classList.add('active');
      const rec = all.find(r => r.id === _codexActiveId);
      if (!rec) return;
      if (rec.species) renderSpeciesDetail(rec.species);
      else if (rec.civ) renderCivDetail(rec.civ);
      else if (rec.entry) renderCodexDetail(rec.entry);
    });
  });

  // Auto-select most recent, or keep the active one if it survived the filter.
  const toShow = _codexActiveId
    ? all.find(r => r.id === _codexActiveId && filtered.includes(r)) ?? sorted[0]
    : sorted[0];
  if (toShow) {
    _codexActiveId = toShow.id;
    if (toShow.species) renderSpeciesDetail(toShow.species);
    else if (toShow.civ) renderCivDetail(toShow.civ);
    else if (toShow.entry) renderCodexDetail(toShow.entry);
    listEl.querySelector(`[data-id="${toShow.id}"]`)?.classList.add('active');
  }
}

function renderCodexDetail(entry: CodexEntry): void {
  const detailEl = document.getElementById('codex-entry-detail');
  if (!detailEl) return;
  const age = (entry.tick * 10).toLocaleString();
  const cat = CODEX_CAT_LABELS[entry.category] ?? entry.category;
  const bodyHtml = entry.body
    ? `<div class="codex-detail-body">${escapeHtml(entry.body)}</div>`
    : `<div class="codex-detail-pending">The chronicles are still being written…<br>The AI God will speak on this matter soon.</div>`;
  detailEl.innerHTML = `
    <div class="codex-detail-title">${escapeHtml(entry.title)}</div>
    <div class="codex-detail-meta">${cat} · Year ${age}</div>
    ${bodyHtml}
  `;
}

function addChatMessage(text: string, type: 'god' | 'player' | 'system'): void {
  const thread = document.getElementById('chat-thread');
  if (!thread) return;
  const div = document.createElement('div');
  div.className = `msg msg-${type}`;
  div.textContent = text;
  thread.appendChild(div);
  while (thread.children.length > 40) thread.removeChild(thread.firstChild!);
  thread.scrollTop = thread.scrollHeight;
}

let _unreadEventCount = 0;

function addFeedEntry(text: string, type: 'milestone' | 'war' | 'cosmic' | 'discovery'): void {
  const feed = document.getElementById('event-feed');
  if (!feed) return;
  const icons: Record<string, string> = { milestone: '✦', war: '⚔', cosmic: '◈', discovery: '✦' };
  const div = document.createElement('div');
  div.className = 'feed-entry';
  div.innerHTML = `<span class="feed-tick">[${gameState.tick.toLocaleString()}]</span> <span class="feed-icon icon-${type}">${icons[type]}</span> ${text}`;
  feed.prepend(div);
  while (feed.children.length > 60) feed.removeChild(feed.lastChild!);

  // Notification badge on bell icon
  _unreadEventCount++;
  const badge = document.getElementById('notif-badge');
  if (badge) {
    badge.textContent = _unreadEventCount > 9 ? '9+' : String(_unreadEventCount);
    badge.classList.add('visible');
  }
  const tabCount = document.getElementById('events-tab-count');
  if (tabCount) tabCount.textContent = _unreadEventCount > 0 ? String(_unreadEventCount) : '';

  // Store in global event log
  eventLogEntries.unshift({ tick: gameState.tick, type, text });
  if (eventLogEntries.length > 2000) eventLogEntries.length = 2000;
}

function renderEventLog(): void {
  const list = document.getElementById('event-log-list');
  const countEl = document.getElementById('event-log-count');
  if (!list) return;

  const icons: Record<string, string> = { milestone: '✦', war: '⚔', cosmic: '◈', discovery: '◉' };
  const search = eventLogSearch.toLowerCase();

  const filtered = eventLogEntries.filter(e => {
    if (eventLogFilter !== 'all' && e.type !== eventLogFilter) return false;
    if (search && !e.text.toLowerCase().includes(search)) return false;
    return true;
  });

  if (countEl) countEl.textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="event-log-empty">NO EVENTS MATCH</div>`;
    return;
  }

  list.innerHTML = filtered.map(e =>
    `<div class="event-log-row">
      <span class="elr-tick">[${e.tick.toLocaleString()}]</span>
      <span class="elr-icon icon-${e.type}">${icons[e.type] ?? '✦'}</span>
      <span class="elr-text">${e.text}</span>
    </div>`
  ).join('');
}

function openEventLog(): void {
  const modal = document.getElementById('event-log-modal');
  if (!modal) return;
  modal.classList.add('open');
  renderEventLog();
  // Clear notification badge
  _unreadEventCount = 0;
  const badge = document.getElementById('notif-badge');
  if (badge) { badge.textContent = ''; badge.classList.remove('visible'); }
}

function closeEventLog(): void {
  document.getElementById('event-log-modal')?.classList.remove('open');
}

// ─── Notification Toast ───────────────────────────────────────────────────────
const TOAST_ICONS: Record<string, string> = {
  dna:             '🧬',
  supernova:       '💥',
  asteroid_impact: '☄',
  void_storm:      '🌀',
  plague:          '☣',
  warning:         '⚠',
  smite:           '⚡',
  war_start:       '⚔',
  war_siege:       '🏴',
  war_end:         '⚑',
};

const TOAST_TITLES: Record<string, string> = {
  dna:             'EVOLUTION',
  supernova:       'STELLAR COLLAPSE',
  asteroid_impact: 'ASTEROID IMPACT',
  void_storm:      'VOID STORM',
  plague:          'COSMIC PLAGUE',
  warning:         'COSMIC WARNING',
  smite:           'ASTEROID SMITED',
  war_start:       'WAR DECLARED',
  war_siege:       'SIEGE PHASE',
  war_end:         'WAR RESOLVED',
};

function showToast(type: string, text: string, durationMs = 7000): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.style.setProperty('--toast-dur', `${durationMs / 1000}s`);
  toast.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] ?? '✦'}</span>
    <div class="toast-body">
      <div class="toast-title">${TOAST_TITLES[type] ?? type.toUpperCase()}</div>
      <div class="toast-text">${text}</div>
    </div>
    <button class="toast-close" aria-label="Dismiss">✕</button>
    <div class="toast-bar"></div>
  `;

  toast.querySelector('.toast-close')?.addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);

  setTimeout(() => dismissToast(toast), durationMs);
}

function dismissToast(toast: HTMLElement): void {
  if (!toast.isConnected) return;
  toast.classList.add('toast-out');
  setTimeout(() => toast.remove(), 400);
}

let _pendingAsteroidWarning = false;

function wireCosmicCallbacks(): void {
  if (!engine) return;

  engine.onCosmicWarning = (ev, star) => {
    AudioManager.playSfx('notification');
    const isPlayerStar = star.isPlayerStar;
    const warningLeadTicks = ev.scheduledTick - gameState.tick;
    const typeLabels: Record<string, string> = {
      supernova:       'A supernova is imminent',
      asteroid_impact: 'A massive asteroid is inbound',
      void_storm:      'A void storm is approaching',
      plague:          'A cosmic plague is spreading',
    };
    const label = typeLabels[ev.type] ?? 'A cosmic event approaches';
    const targetDesc = isPlayerStar ? 'your system' : `the ${star.civName} system`;
    const text = `${label} toward ${targetDesc}. Impact in ~${warningLeadTicks.toLocaleString()} ticks.`;

    addFeedEntry(text, 'cosmic');
    showToast('warning', text, 9000);

    if (ev.type === 'asteroid_impact' && isPlayerStar) {
      _pendingAsteroidWarning = true;
      updateSmiteButton();
      addChatMessage(`⚠ An asteroid is on a collision course with your world. You have time to act — spend 25 DP to SMITE it.`, 'god');
    }
  };

  engine.onCosmicStrike = (ev, star) => {
    AudioManager.playSfx('cosmic_event');
    const isPlayerStar = star.isPlayerStar;
    const strikeDesc: Record<string, string> = {
      supernova:       `The star ${star.civName} has gone supernova — shockwaves ripple through nearby systems.`,
      asteroid_impact: isPlayerStar
        ? 'An asteroid has struck your world. Biosphere damage is severe.'
        : `An asteroid struck the ${star.civName} system.`,
      void_storm:      isPlayerStar
        ? 'A void storm has swept through your system — civilization progress has been set back.'
        : `A void storm struck the ${star.civName} system — their advancement has been disrupted.`,
      plague:          isPlayerStar
        ? 'A plague has come down from the stars. Fever spreads through your nations.'
        : `The ${star.civName} civilization has been struck by cosmic plague.`,
    };
    const text = strikeDesc[ev.type] ?? `A cosmic event struck ${star.civName}.`;

    addFeedEntry(text, 'cosmic');
    showToast(ev.type, text, 8000);

    if (isPlayerStar) {
      addChatMessage(text, 'god');
    }

    if (ev.type === 'asteroid_impact' && isPlayerStar) {
      _pendingAsteroidWarning = false;
      updateSmiteButton();
      // The strike lands on the home world: show it falling (size 1.0, a land
      // cell in view picked by the renderer).
      _dioramaRenderer?.playMeteorStrike(null, 1.0);
    }
  };
}

function updateSmiteButton(): void {
  const btn = document.getElementById('smite-asteroid-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const visible = _pendingAsteroidWarning;
  btn.style.display = visible ? '' : 'none';
  if (visible) {
    const dp = gameState.divinePoints;
    btn.disabled = dp < 25;
    btn.querySelector('.divine-action-cost')?.classList.toggle('affordable', dp >= 25);
  }
}

function smiteAsteroid(): void {
  if (gameState.divinePoints < 25) {
    addChatMessage('Insufficient Divine Points. You need 25 DP to smite the asteroid.', 'system');
    return;
  }
  const deflected = engine?.smiteAsteroid();
  if (!deflected) {
    addChatMessage('There is no asteroid threatening your world right now.', 'system');
    return;
  }
  gameState.divinePoints -= 25;
  _dioramaRenderer?.playDivineEffect('smite');
  _pendingAsteroidWarning = false;
  updateSmiteButton();
  addFeedEntry('Divine intervention: the incoming asteroid was obliterated.', 'cosmic');
  showToast('smite', 'Your divine power destroyed the asteroid before it could reach your world.', 7000);
  addChatMessage('The asteroid crumbles to dust before your might.', 'god');
}

function setSpeed(speed: number): void {
  // Normal mode has one fixed pace: anything that is not a pause runs at it.
  const normal = gameState.playMode === 'normal';
  if (normal && speed > 0) speed = NORMAL_PACE;
  gameState.speed = speed;
  (window as unknown as Record<string, unknown>)['eternalSpeed'] = speed;
  document.querySelectorAll('.speed-btn').forEach(btn => {
    const b = Number((btn as HTMLElement).dataset['speed']);
    btn.classList.toggle('active', normal ? (b > 0) === (speed > 0) : b === speed);
  });
}

/** Divine points a Creative run always has. */
const CREATIVE_DP = 9999;

/**
 * Normal: pause and play only (fixed pace), no Place Life. Creative: the full
 * speed row, unlimited divine points, Place Life.
 */
function applyPlayModeControls(): void {
  const creative = gameState.playMode === 'creative';
  document.querySelectorAll<HTMLElement>('.speed-btn').forEach(btn => {
    const b = Number(btn.dataset['speed']);
    if (b > 1) btn.style.display = creative ? '' : 'none';
    if (b === 1) {
      btn.textContent = creative ? '1×' : '▶';
      btn.title = creative ? '' : 'Play (normal pace)';
    }
  });
  const place = document.getElementById('place-life-btn');
  if (place) place.style.display = creative ? '' : 'none';
  const leap = document.getElementById('era-leap');
  if (leap) leap.style.display = creative ? '' : 'none';
  if (creative) gameState.divinePoints = CREATIVE_DP;
  document.body.classList.toggle('mode-creative', creative);
}

const DESTINY_LABELS: Record<DestinyType, string> = {
  ocean: 'ocean world', rocky: 'rocky world', ice: 'ice world', desert: 'desert world',
};

const FORMATION_STAGE_LABELS: Record<string, string> = {
  magma: 'Magma Ocean', cooling: 'Cooling Crust', volcanic: 'Volcanic Era',
  atmosphere: 'First Air', ice_age: 'Ice Age', primordial: 'Primordial Sea',
};

const FORMATION_STAGE_LINES: Record<string, string> = {
  cooling: 'The magma sea is skinning over. A dark crust floats on the fire.',
  volcanic: 'The crust holds now, but the world still bleeds fire through a thousand vents.',
  atmosphere: 'Outgassing has given the world a first, thin breath of air.',
  ice_age: 'The air has turned cold. Ice is spreading across the young world.',
  primordial: 'Rain has fallen for an age. A primordial sea fills the low places.',
};

/**
 * The home world's face changed (a new formation stage, or formation done):
 * regenerate its surface grid as that face and repaint the diorama if open.
 */
function refreshHomeWorldSurface(): void {
  runtimeState.playerPlanetGrid = null;
  const overlay = document.getElementById('planet-overlay');
  const ps = engine?.getPlayerStar();
  if (!ps || !overlay || overlay.style.display === 'none' || !_dioramaRenderer) return;
  void openPlanetView(ps);
}

/** Creative: fill the era picker (once) and leap the home world when one is picked. */
function wireEraLeap(): void {
  const sel = document.getElementById('era-leap') as HTMLSelectElement | null;
  if (!sel || sel.dataset['wired'] === '1') return;
  sel.dataset['wired'] = '1';
  TECH_LEVELS.forEach((label, i) => {
    if (i === 0) return;
    const o = document.createElement('option');
    o.value = String(i); o.textContent = label;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    const target = Number(sel.value);
    sel.value = '';
    if (!engine || gameState.playMode !== 'creative' || !target) return;
    if (!runtimeState.playerPlanetGrid) {
      addChatMessage('Open your world first: the ages need a surface to pass over.', 'system');
      return;
    }
    const line = engine.leapToEra(target);
    addChatMessage(line ?? 'Your world is not ready for that leap yet.', 'system');
    if (line && selectedTile) showTileInfo(selectedTile, false);
  });
}

function placeLifeAction(): void {
  if (!engine || gameState.playMode !== 'creative') return;
  if (!engine.placeLife()) {
    addChatMessage('Life already thrives there.', 'system');
    return;
  }
  _dioramaRenderer?.playDivineEffect('fertility');
  updateDivineActions();
}

let _preEventSpeed: number | null = null;

/** Slow the sim to targetSpeed for a modal/event moment. Saves current speed once. */
function slowForEvent(targetSpeed = 1): void {
  if (_preEventSpeed === null) _preEventSpeed = gameState.speed;
  setSpeed(targetSpeed);
}

/** Restore the speed saved by slowForEvent(). No-op if never slowed. */
function restoreSpeed(): void {
  if (_preEventSpeed !== null) {
    setSpeed(_preEventSpeed);
    _preEventSpeed = null;
  }
}

let _lastDP = -1;
let _lastWarChatTime = 0; // timestamp of last war chat message

/** Award bonus DP from a milestone event and show a brief toast. */
function awardDP(amount: number, reason: string): void {
  const before = gameState.divinePoints;
  gameState.divinePoints = Math.min(DP_CAP, gameState.divinePoints + amount);
  const actual = gameState.divinePoints - before;
  if (actual <= 0) return;
  updateDivineActions();
  setResourceChip('dp-display', 'dp-display-val', gameState.divinePoints);
  addFeedEntry(`+${actual} Divine Power — ${reason}`, 'milestone');
}

// ─── Leader Dialogue ──────────────────────────────────────────────────────────

function appendLeaderMemory(leaderId: string, entry: string): void {
  let mem = gameState.leaderMemories.find(m => m.leaderId === leaderId);
  if (!mem) {
    mem = { leaderId, entries: [] };
    gameState.leaderMemories.push(mem);
  }
  mem.entries.push(entry);
  if (mem.entries.length > 10) mem.entries.shift();
}

function closeLeaderDialogue(): void {
  document.getElementById('leader-dialogue-overlay')!.classList.remove('active');
  currentDialogueLeader = null;
  _leaderDialogueOpen = false;
}

function showTimeline(): void {
  const overlay  = document.getElementById('timeline-overlay')!;
  const list     = document.getElementById('timeline-list')!;
  const countEl  = document.getElementById('timeline-count')!;

  list.innerHTML = '';

  // eventLogEntries is newest-first (prepended in addFeedEntry)
  for (const entry of eventLogEntries) {
    const age = (entry.tick * 10).toLocaleString();
    const div = document.createElement('div');
    div.className = 'tl-entry';
    div.innerHTML = `
      <div class="tl-dot tl-dot-${entry.type}"></div>
      <div class="tl-body">
        <div class="tl-meta">TICK ${entry.tick.toLocaleString()} · ${age} YRS</div>
        <div class="tl-text">${entry.text}</div>
      </div>`;
    list.appendChild(div);
  }

  countEl.textContent = `${eventLogEntries.length.toLocaleString()} events recorded`;
  overlay.classList.add('active');
}

async function showLeaderDialogue(leader: Leader, eventContext: string): Promise<void> {
  if (_leaderDialogueOpen) return;
  _leaderDialogueOpen = true;
  if (gameState.divinePoints < 1) {
    _leaderDialogueOpen = false;
    addChatMessage(`${leader.name} of ${leader.faction} reaches out, but divine silence prevails.`, 'god');
    return;
  }
  gameState.divinePoints -= 1;
  updateDivineActions();
  addFeedEntry(`-1 Divine Power — Leader communication: ${leader.name}`, 'milestone');

  currentDialogueLeader = leader;

  const overlay   = document.getElementById('leader-dialogue-overlay')!;
  const nameEl    = document.getElementById('leader-dlg-name')!;
  const metaEl    = document.getElementById('leader-dlg-meta')!;
  const msgEl     = document.getElementById('leader-dlg-message')!;
  const attEl     = document.getElementById('leader-dlg-attitude')!;
  const dpNotice  = document.getElementById('leader-dlg-dp-notice')!;
  const optionsEl = document.getElementById('leader-response-options')!;

  nameEl.textContent   = leader.name;
  metaEl.textContent   = `${leader.role} • ${leader.faction} • ${leader.ideology}`;
  attEl.textContent    = `Attitude: ${leader.attitudeTowardGod.replace(/_/g, ' ')}`;
  msgEl.textContent    = '…';
  dpNotice.textContent = `${gameState.divinePoints} DP remaining`;
  optionsEl.innerHTML  = '';

  // Draw flag on mini canvas
  const flagCanvas = document.getElementById('leader-flag-canvas') as HTMLCanvasElement;
  if (flagCanvas) {
    const flagCtx = flagCanvas.getContext('2d')!;
    flagCtx.clearRect(0, 0, 36, 24);
    const flag = gameState.factionFlags[leader.starId];
    if (flag) drawFactionFlag(flagCtx, flag, 18, 12, 14);
  }

  overlay.classList.add('active');

  // Response options
  const RESPONSE_OPTIONS: Array<{ label: string; cost: number; valence: 1 | -1 | 0; action: string }> = [
    { label: 'Grant your blessing (+0.2 devotion)', cost: 1, valence:  1, action: 'bless'  },
    { label: 'Send an omen of warning',             cost: 1, valence: -1, action: 'omen'   },
    { label: 'Remain silent (observe)',             cost: 0, valence:  0, action: 'silent' },
  ];
  for (const opt of RESPONSE_OPTIONS) {
    const btn = document.createElement('button');
    btn.textContent = opt.cost > 0 ? `${opt.label} [${opt.cost} DP]` : opt.label;
    btn.style.cssText = 'padding:7px 12px; background:#1a0025; border:1px solid #553366; color:#ccaaee; border-radius:4px; cursor:pointer; font-size:11px; text-align:left; width:100%;';
    btn.addEventListener('click', () => handleLeaderResponse(opt.cost, opt.valence, opt.action, opt.label));
    optionsEl.appendChild(btn);
  }

  // Generate AI message async
  const memories = gameState.leaderMemories.find(m => m.leaderId === leader.id);
  const { text } = await generateLeaderDialogue(leader, eventContext, memories, _geminiService, fallbackNarrator!);
  msgEl.textContent    = `"${text}"`;
  dpNotice.textContent = `${gameState.divinePoints} DP remaining`;

  // Store memory entry
  const memEntry = await generateMemoryEntry(leader, eventContext, _geminiService, fallbackNarrator!);
  appendLeaderMemory(leader.id, memEntry);
}

function handleLeaderResponse(cost: number, valence: 1 | -1 | 0, action: string, label: string): void {
  if (!currentDialogueLeader) return;
  if (gameState.divinePoints < cost) { addChatMessage('Not enough Divine Points.', 'system'); return; }
  if (cost > 0) {
    gameState.divinePoints -= cost;
    updateDivineActions();
    addFeedEntry(`-${cost} Divine Power — Leader response: ${label}`, 'milestone');
  }

  const leader = currentDialogueLeader;

  if (valence !== 0) {
    leader.attitudeTowardGod = shiftLeaderAttitude(leader.attitudeTowardGod, valence as 1 | -1);
    const attEl = document.getElementById('leader-dlg-attitude');
    if (attEl) attEl.textContent = `Attitude: ${leader.attitudeTowardGod.replace(/_/g, ' ')}`;
  }

  if (action === 'bless') {
    const star = engine?.getStarById(leader.starId);
    if (star) star.religionDevotion = Math.min(1, (star.religionDevotion ?? 0) + 0.2);
    addChatMessage(`You bestowed a blessing upon ${leader.name}'s people.`, 'god');
    appendLeaderMemory(leader.id, 'The god granted us a blessing of devotion.');
  } else if (action === 'omen') {
    leader.fearLevel = Math.min(10, leader.fearLevel + 2);
    addChatMessage(`You sent an omen to ${leader.name}. Fear spreads among the faithful.`, 'god');
    appendLeaderMemory(leader.id, 'A divine omen filled our hearts with dread.');
  } else {
    addChatMessage(`You observed ${leader.name} in silence.`, 'god');
  }

  closeLeaderDialogue();
}

function updateDivineActions(): void {
  const dp = gameState.divinePoints;

  // Update counter + pop animation on change
  const counter = document.getElementById('divine-dp-counter');
  if (counter) {
    counter.textContent = `✦ ${dp} DP`;
    if (dp !== _lastDP && _lastDP !== -1) {
      counter.classList.remove('pop');
      void counter.offsetWidth; // reflow to restart animation
      counter.classList.add('pop');
    }
    _lastDP = dp;
  }

  const btns: Array<[string, number]> = [
    ['nudge-evolution-btn', 10],
    ['divine-explore-btn',  20],
    ['bless-harvest-btn',         5],
    ['send-prophet-btn',         15],
    ['trigger-revelation-btn',   15],
  ];
  for (const [id, cost] of btns) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) {
      const canAfford = dp >= cost;
      btn.disabled = !canAfford;
      btn.classList.toggle('affordable', canAfford);
    }
  }

  // Prophet + Revelation stay visible (mockup deck); disable until religion emerges
  const hasReligion = !!gameState.playerReligionName;
  for (const id of ['send-prophet-btn', 'trigger-revelation-btn'] as const) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.hidden = false;
    if (!hasReligion) {
      btn.disabled = true;
      btn.classList.remove('affordable');
    }
  }
  updateSmiteButton();
  refreshFaithHand();

  // Send Meteor — always in Faith deck (mockup); afford only with a valid target
  const meteorBtn = document.getElementById('send-meteor-btn') as HTMLButtonElement | null;
  if (meteorBtn) {
    const hasMeteorTarget = !!engine?.getMeteorTarget();
    meteorBtn.style.display = '';
    meteorBtn.disabled = !hasMeteorTarget || dp < 20;
    meteorBtn.classList.toggle('affordable', hasMeteorTarget && dp >= 20);
  }

  // Terraform — visible only when home planet has valid transform options and not already terraforming
  const tfBtn = document.getElementById('terraform-btn') as HTMLButtonElement | null;
  if (tfBtn) {
    const tfInfo = engine?.getTerraformInfo();
    const ps = engine?.getPlayerStar();
    const isTerraforming = !!(ps?.terraformStage);
    const TERRAFORM_COST = 50;
    if (isTerraforming) {
      tfBtn.style.display = '';
      tfBtn.disabled = true;
      const stage = ps!.terraformStage!;
      const label: Record<string, string> = {
        ice_age: 'Ice Age', atmosphere: 'Atmosphere Formation',
        cooling: 'Cooling', primordial: 'Primordial Ocean', magma: 'Magma', volcanic: 'Volcanic'
      };
      const costEl = document.getElementById('terraform-cost');
      if (costEl) costEl.textContent = `⟳ ${label[stage] ?? stage}…`;
    } else if (tfInfo && tfInfo.options.length > 0) {
      tfBtn.style.display = '';
      tfBtn.disabled = dp < TERRAFORM_COST;
      tfBtn.classList.toggle('affordable', dp >= TERRAFORM_COST);
      const costEl = document.getElementById('terraform-cost');
      if (costEl) costEl.textContent = `✦ ${TERRAFORM_COST} DP`;
    } else {
      tfBtn.style.display = 'none';
    }
  }
}

function nudgeEvolution(): void {
  if (gameState.divinePoints < 10) {
    addChatMessage('Insufficient Divine Points. You need 10 DP to nudge evolution.', 'system');
    return;
  }
  const ps = engine?.getPlayerStar();
  if (!ps) return;
  gameState.divinePoints -= 10;
  _dioramaRenderer?.playDivineEffect('nudge');
  const { outcome, mutationDesc } = engine?.nudgePlayerEvolution() ?? { outcome: 'none' as const };
  if (outcome === 'bio') {
    const phaseLabel = BIO_PHASE_LABELS[ps.biologyPhase] ?? ps.biologyPhase;
    if (mutationDesc) {
      addChatMessage(
        `Your divine will reaches into the helix of ${gameState.playerPlanetName}. ${mutationDesc}`,
        'god'
      );
      // feed entry already added by onMutationEvent — skip the duplicate
    } else {
      addChatMessage(
        `A whisper of divine will stirs the genetic code of ${gameState.playerPlanetName}. The ${phaseLabel} stage inches forward — but nature cannot be rushed.`,
        'god'
      );
      addFeedEntry(`Evolution nudged — ${phaseLabel} stage progressing`, 'milestone');
    }
  } else if (outcome === 'dna') {
    updateDNAPanel();
    addChatMessage(
      `Deep within the helix, something shifts. The people of ${gameState.playerPlanetName} have gained a fragment of divine genetic potential. Spend it wisely.`,
      'god'
    );
    addFeedEntry(`DNA point earned via divine nudge`, 'milestone');
  }
  updateDivineActions();
}

function blessHarvest(): void {
  if (gameState.divinePoints < 5) {
    addChatMessage('Insufficient Divine Points. You need 5 DP to bless the harvest.', 'system');
    return;
  }
  const ps = engine?.getPlayerStar();
  if (!ps?.hasLife) {
    addChatMessage('There is no life to bless. Your world is silent.', 'god');
    return;
  }
  gameState.divinePoints -= 5;
  engine?.blessHarvest();
  _dioramaRenderer?.playDivineEffect('bless');
  addChatMessage(`The land grows fertile. ${gameState.playerPlanetName}'s biosphere strengthens.`, 'god');
  addFeedEntry(`Divine blessing — biosphere enriched on ${gameState.playerPlanetName}`, 'milestone');
  updateDivineActions();
  const blessLeader = gameState.leaders.find(l => l.starId === gameState.playerStarId);
  if (blessLeader) setTimeout(() => void showLeaderDialogue(blessLeader, 'The god has blessed the harvest. Crops overflow.'), 1200);
}

function sendProphet(): void {
  if (gameState.divinePoints < 15) {
    addChatMessage('Insufficient Divine Points. You need 15 DP to send a prophet.', 'system');
    return;
  }
  const ps = engine?.getPlayerStar();
  if (!ps?.hasLife) {
    addChatMessage('There are no minds to receive a vision. Await life first.', 'god');
    return;
  }
  if (ps.civLevel >= 8) {
    addChatMessage('Your civilization has transcended. No prophet can take them further.', 'god');
    return;
  }
  gameState.divinePoints -= 15;
  engine?.sendProphet();
  _dioramaRenderer?.playDivineEffect('prophet');
  const speciesName = gameState.playerSpeciesName || 'your people';
  addChatMessage(`A prophet walks among ${speciesName}. The next era of enlightenment draws closer.`, 'god');
  addFeedEntry(`Prophet sent — ${speciesName} inspired toward the next era`, 'milestone');
  updateDivineActions();
}

function triggerRevelation(): void {
  if (gameState.divinePoints < 15) {
    addChatMessage('Insufficient Divine Points. You need 15 DP to trigger a revelation.', 'system');
    return;
  }
  const ps = engine?.getPlayerStar();
  if (!ps?.religionName) {
    addChatMessage('Your people have no faith yet. A religion must emerge before revelations can be sent.', 'god');
    return;
  }
  gameState.divinePoints -= 15;
  engine?.triggerRevelation();
  _dioramaRenderer?.playDivineEffect('revelation');
  AudioManager.playSfx('revelation');
  const religion = gameState.playerReligionName || ps.religionName;
  addChatMessage(`A divine sign blazes across the heavens. The faithful of ${religion} cry out in wonder.`, 'god');
  addFeedEntry(`Divine revelation — devotion of ${religion} has deepened`, 'milestone');
  updateDivineActions();
  const revLeader = gameState.leaders.find(l => l.starId === gameState.playerStarId);
  if (revLeader) setTimeout(() => void showLeaderDialogue(revLeader, 'A divine revelation has swept across the land.'), 1200);
}

function divineExplore(): void {
  if (gameState.divinePoints < 20) {
    addChatMessage('Insufficient Divine Points. You need 20 DP to cast divine sight.', 'system');
    return;
  }
  gameState.divinePoints -= 20;
  _dioramaRenderer?.playDivineEffect('sight');
  const angle = Math.random() * Math.PI * 2;
  engine?.spendDPToExplore(angle);
  const dir = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  addChatMessage(`Divine sight cast ${dir[Math.floor((angle / (Math.PI * 2)) * 8) % 8]}. New regions revealed.`, 'god');
}

// ─── Meteor Impact Overlay ────────────────────────────────────────────────────
const METEOR_IMPACT_IMAGES: Partial<Record<string, string>> = {
  rocky: '/assets/ui/meteor/impact/meteor_sand.png',
  ocean: '/assets/ui/meteor/impact/meteor_earth.png',
  gas:   '/assets/ui/meteor/impact/meteor_gas.png',
  ice:   '/assets/ui/meteor/impact/meteor_icy.png',
  lava:  '/assets/ui/meteor/impact/meteor_lava.png',
};
let _meteorDismissTimeout: ReturnType<typeof setTimeout> | null = null;

function showMeteorImpact(planetName: string, planetType: string): void {
  const overlay = document.getElementById('meteor-impact-overlay');
  const img     = document.getElementById('meteor-impact-img') as HTMLImageElement | null;
  const nameEl  = document.getElementById('meteor-impact-planet');
  if (!overlay || !img || !nameEl) return;

  img.src = METEOR_IMPACT_IMAGES[planetType] ?? '/assets/ui/meteor/impact/meteor_earth.png';
  nameEl.textContent = planetName.toUpperCase();

  overlay.classList.remove('closing');
  overlay.classList.add('open');

  if (_meteorDismissTimeout) clearTimeout(_meteorDismissTimeout);
  _meteorDismissTimeout = setTimeout(() => {
    overlay.classList.add('closing');
    overlay.addEventListener('animationend', () => {
      overlay.classList.remove('open', 'closing');
    }, { once: true });
  }, 4000);
}

function showFirstContact(npcStar: StarBody): void {
  const overlay   = document.getElementById('first-contact-overlay')!;
  const bodyEl    = document.getElementById('fc-body-text')!;
  const choicesEl = document.getElementById('fc-choices')!;

  bodyEl.textContent =
    `Long-range sensors detect a structured signal from the ${npcStar.civName} system. ` +
    `Repeating patterns. Mathematical sequences. ` +
    `They know we are here — or they will soon.`;

  choicesEl.innerHTML = '';
  AudioManager.playSfx('notification');
  addFeedEntry(`⊕ SIGNAL DETECTED — ${npcStar.civName} transmission incoming`, 'discovery');
  addCodexEntry(`First Contact: ${npcStar.civName}`, 'civilisation');
  addChatMessage(`The universe is no longer silent. ${npcStar.civName} reaches across the void.`, 'god');

  const CHOICES = [
    { label: '📡 Respond Peacefully', sub: 'Open a channel. Exchange greetings. Begin a dialogue.', action: 'peaceful' },
    { label: '🔇 Remain Silent',      sub: 'Do not respond. Observe. Let them wonder.',              action: 'silent'   },
    { label: '⚠ Broadcast Warning',  sub: 'Transmit a warning to all nearby systems.',              action: 'warning'  },
  ];

  for (const c of CHOICES) {
    const btn = document.createElement('button');
    btn.className = 'fc-choice-btn';
    btn.innerHTML = `${c.label}<div class="fc-choice-sub">${c.sub}</div>`;
    btn.addEventListener('click', () => {
      handleFirstContactChoice(c.action, npcStar.civName);
      overlay.classList.remove('active');
      restoreSpeed();
    });
    choicesEl.appendChild(btn);
  }

  overlay.classList.add('active');
  slowForEvent(1);
}

function handleFirstContactChoice(action: string, civName: string): void {
  if (action === 'peaceful') {
    addFeedEntry(`${gameState.playerSpeciesName} responds to ${civName} with a message of peace.`, 'milestone');
    addChatMessage(`A bridge between species. The first word spoken across the void was: peace.`, 'god');
    const ps = engine?.getPlayerStar();
    if (ps) ps.religionDevotion = Math.min(1, ps.religionDevotion + 0.1);
    awardDP(10, 'First Contact: Peaceful response');
  } else if (action === 'silent') {
    addFeedEntry(`${gameState.playerSpeciesName} observes ${civName} in silence. The signal goes unanswered.`, 'discovery');
    addChatMessage(`Silence is also a message. They will wonder. And wondering, they will fear.`, 'god');
    awardDP(5, 'First Contact: Observed in silence');
  } else {
    addFeedEntry(`${gameState.playerSpeciesName} broadcasts a warning to all nearby systems.`, 'war');
    addChatMessage(`The broadcast carries one meaning: we are here, and we are not afraid.`, 'god');
    awardDP(5, 'First Contact: Warning broadcast');
  }
}

function sendMeteor(): void {
  if (!engine) return;
  const target = engine.getMeteorTarget();
  if (!target) { addChatMessage('No lifeless world within reach. Explore further first.', 'system'); return; }
  if (gameState.divinePoints < 20) { addChatMessage('Insufficient Divine Points. You need 20 DP to send a meteor.', 'system'); return; }
  gameState.divinePoints -= 20;
  engine.sendMeteor();
  updateDivineActions();
}

// ─── Terraform ────────────────────────────────────────────────────────────────

const TERRAFORM_COST = 50;

function openTerraformModal(): void {
  if (!engine) return;
  const info = engine.getTerraformInfo();
  if (!info || info.options.length === 0) return;

  const container = document.getElementById('terraform-options');
  if (!container) return;
  container.innerHTML = '';

  for (const opt of info.options) {
    const stageLabels: Record<string, string> = {
      ice_age: 'Ice Age', atmosphere: 'Atmosphere Formation',
      cooling: 'Cooling', primordial: 'Primordial Ocean',
      magma: 'Magma', volcanic: 'Volcanic'
    };
    const stepsHtml = opt.stages.map(s => `<span style="color:#88ccff;font-size:10px">${stageLabels[s] ?? s}</span>`).join(' → ');
    const card = document.createElement('button');
    card.className = 'divine-action-btn';
    card.style.cssText = 'width:100%;text-align:left;padding:12px 14px';
    card.innerHTML = `
      <span class="divine-action-name" style="font-size:12px">${opt.label.toUpperCase()}</span>
      <span class="divine-action-desc" style="font-size:10px;margin-top:4px">Stages: ${stepsHtml}</span>
    `;
    card.addEventListener('click', () => {
      if (gameState.divinePoints < TERRAFORM_COST) {
        addChatMessage(`Insufficient Divine Points. Terraforming costs ${TERRAFORM_COST} DP.`, 'system');
        closeTerraformModal();
        return;
      }
      const started = engine!.startTerraform(opt.targetType);
      if (started) {
        gameState.divinePoints -= TERRAFORM_COST;
        const stageLabel: Record<string, string> = {
          ice_age: 'Ice Age', atmosphere: 'Atmosphere Formation',
          cooling: 'Cooling', primordial: 'Primordial Ocean',
          magma: 'Magma', volcanic: 'Volcanic'
        };
        const firstStage = stageLabel[opt.stages[0]] ?? opt.stages[0];
        addChatMessage(
          `Divine geological forces awaken. Your world enters the ${firstStage} phase — the transformation to ${opt.targetType} has begun.`,
          'god'
        );
        addFeedEntry(`Terraforming initiated — ${opt.label}`, 'milestone');
        addCodexEntry(`Terraforming of ${gameState.playerPlanetName}`, 'divine');
        updateDivineActions();
      }
      closeTerraformModal();
    });
    container.appendChild(card);
  }

  const overlay = document.getElementById('terraform-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeTerraformModal(): void {
  const overlay = document.getElementById('terraform-overlay');
  if (overlay) overlay.style.display = 'none';
}

function wireTerraformModal(): void {
  document.getElementById('terraform-close-btn')?.addEventListener('click', closeTerraformModal);
  document.getElementById('terraform-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTerraformModal();
  });
}

// ─── In-game Naming Modal ─────────────────────────────────────────────────────
const SPECIES_NAMES = [
  'Humans','Vael','Ithrani','Solken','Drevari','Nocthari','Auryn','Ethova',
  'Kessari','Umbral','Sylvari','Drakai','Veloxi','Mornai','Terathi','Zholvek',
];
const RELIGION_NAMES = [
  'The Eternal Flame','Order of the Void Star','Children of the First Light',
  'The Sunken Covenant','Path of the Ascending','Choir of the Deep Dark',
  'The Star Shepherds','Temple of the Wandering God','The Infinite Cycle',
  'Disciples of the Pale Flame','The Ember Accord','Order of Still Waters',
];

function randomizeName(): void {
  const input = document.getElementById('ingame-naming-input') as HTMLInputElement | null;
  if (!input) return;
  const list = namingMode === 'religion' ? RELIGION_NAMES : SPECIES_NAMES;
  const pick = list[Math.floor(Math.random() * list.length)];
  input.value = pick;
  input.focus();
}

function openNamingModal(mode: 'species' | 'religion'): void {
  namingMode = mode;
  const overlay = document.getElementById('ingame-naming-overlay');
  const icon    = document.getElementById('ingame-naming-icon');
  const title   = document.getElementById('ingame-naming-title');
  const desc    = document.getElementById('ingame-naming-desc');
  const input   = document.getElementById('ingame-naming-input') as HTMLInputElement;
  if (!overlay) return;

  if (mode === 'species') {
    // Named when life first wakes (usually as microbes), so say what it is.
    const thinking = engine?.getPlayerStar()?.biologyPhase === 'intelligent';
    if (icon)  icon.textContent  = thinking ? '🧠' : '🧬';
    if (title) title.textContent = thinking ? 'INTELLIGENCE EMERGES' : 'LIFE AWAKENS';
    if (desc)  desc.textContent  = thinking
      ? `After eons of evolution, the first truly intelligent beings have awakened on ${gameState.playerPlanetName}. What do you call your people?`
      : `Something lives on ${gameState.playerPlanetName}: one lineage, small and stubborn. Everything that ever walks this world will descend from it. What do you call it?`;
    if (input) input.placeholder = thinking ? 'e.g. Humans' : 'e.g. The First Ones';
  } else {
    if (icon)  icon.textContent  = '✦';
    if (title) title.textContent = 'FAITH IS BORN';
    if (desc)  desc.textContent  = `Your people have grown ancient enough to gaze at the stars and wonder. What is the name of their first religion?`;
    if (input) input.placeholder = 'e.g. The Order of Eternal Light';
  }
  if (input) input.value = '';
  overlay.classList.add('open');
  slowForEvent(1);
  setTimeout(() => input?.focus(), 100);
}

function closeNamingModal(): void {
  document.getElementById('ingame-naming-overlay')?.classList.remove('open');
  namingMode = null;
  restoreSpeed();
}

function confirmNaming(): void {
  const input = document.getElementById('ingame-naming-input') as HTMLInputElement | null;
  const name = input?.value.trim() ?? '';
  if (!name) return;

  if (namingMode === 'species') {
    gameState.playerSpeciesName = name;
    addChatMessage(`"${name}" — so your children shall be known across the cosmos.`, 'god');
    addFeedEntry(`First species named: ${name}`, 'milestone');
    addCodexEntry(`The ${name}`, 'civilisation');
    updateBottomBar(engine?.getPlayerStar() ?? { civName: '', civLevel: 0, hasLife: true });
    awardDP(10, `species "${name}" named`);
  } else if (namingMode === 'religion') {
    gameState.playerReligionName = name;
    engine?.setPlayerReligion(name);
    addChatMessage(`"${name}" — the first prayers drift upward from ${gameState.playerPlanetName}.`, 'god');
    addFeedEntry(`First religion born: ${name}`, 'milestone');
    addCodexEntry(name, 'divine');
    awardDP(15, `religion "${name}" founded`);
  }
  closeNamingModal();
}

// ─── Speciation Modal ─────────────────────────────────────────────────────────

const _speciationQueue: EvolutionEvent[] = [];
let _speciationOpen = false;
let _selectedSpeciationTrait = 'none';

const BRANCH_PREFIXES = ['Neo', 'Para', 'Proto', 'Xeno', 'Hyper', 'Sub', 'Archi', 'Ur'];

function showSpeciationModal(evt: EvolutionEvent): void {
  if (_speciationOpen) {
    _speciationQueue.push(evt);
    return;
  }
  _speciationOpen = true;
  _selectedSpeciationTrait = 'none';

  const overlay   = document.getElementById('speciation-overlay');
  const desc      = document.getElementById('sp-desc');
  const parentEl  = document.getElementById('sp-parent-name');
  const nameInput = document.getElementById('speciation-name-input') as HTMLInputElement | null;

  if (desc)     desc.textContent    = `${evt.speciesName} has diverged — a new lineage emerges on ${gameState.playerPlanetName}.`;
  if (parentEl) parentEl.textContent = evt.speciesName;
  if (nameInput) nameInput.value    = evt.newSpeciesName ?? '';

  // Reset trait buttons
  document.querySelectorAll('.sp-trait-btn').forEach(btn => btn.classList.remove('selected'));
  document.querySelector('.sp-trait-btn[data-trait="none"]')?.classList.add('selected');

  overlay?.classList.add('open');
  slowForEvent(1);
  setTimeout(() => nameInput?.focus(), 100);
}

function closeSpeciationModal(dismissed = false): void {
  if (dismissed) {
    // Minimal record so the event isn't completely silent
    const parentName = document.getElementById('sp-parent-name')?.textContent ?? 'a species';
    const autoName   = (document.getElementById('speciation-name-input') as HTMLInputElement | null)?.value.trim()
      || 'an unnamed lineage';
    addFeedEntry(`🌿 SPECIATION: ${parentName} diverged into ${autoName}.`, 'milestone');
    addCodexEntry(`New Lineage: ${autoName}`, 'biology');
  }
  document.getElementById('speciation-overlay')?.classList.remove('open');
  _speciationOpen = false;
  restoreSpeed();
  // Process next queued speciation
  if (_speciationQueue.length > 0) {
    const next = _speciationQueue.shift()!;
    setTimeout(() => showSpeciationModal(next), 400);
  }
}

function confirmSpeciation(): void {
  const nameInput = document.getElementById('speciation-name-input') as HTMLInputElement | null;
  const newName   = nameInput?.value.trim();
  if (!newName) return;

  const parentName = document.getElementById('sp-parent-name')?.textContent ?? '';

  // Locate the newest species in the array whose ancestorId matches the parent
  const newSpecies = [...(gameState.playerSpecies ?? [])]
    .reverse()
    .find(s => !s.isExtinct && s.ancestorId != null);

  if (newSpecies) {
    newSpecies.name = newName;

    // Apply trait nudge
    if (_selectedSpeciationTrait !== 'none') {
      const trait = _selectedSpeciationTrait as keyof typeof newSpecies.dna;
      const cur = newSpecies.dna[trait] as number | undefined;
      if (typeof cur === 'number') {
        (newSpecies.dna as Record<string, unknown>)[trait] = Math.min(10, cur + 1);
      }
    }
  }

  const traitLabel: Record<string, string> = {
    aggression:   'aggressive instincts',
    intelligence: 'heightened intelligence',
    adaptability: 'resilient adaptability',
    none:         'unguided nature',
  };
  const nudgeDesc = _selectedSpeciationTrait !== 'none'
    ? ` Blessed with ${traitLabel[_selectedSpeciationTrait]}.`
    : '';

  addFeedEntry(`🌿 New lineage named: ${newName} (diverged from ${parentName}).${nudgeDesc}`, 'milestone');
  addCodexEntry(`New Lineage: ${newName}`, 'biology');
  awardDP(5, `new lineage "${newName}" blessed`);

  _geminiService?.sendPlayerMessage(
    `[SPECIATION — narrate in 2 sentences as the divine observer]: ${newName} has diverged from ${parentName} on ${gameState.playerPlanetName}.${nudgeDesc}`,
    ''
  ).then(res => { if (res) addChatMessage(res, 'god'); }).catch(() => { /* silent */ });

  closeSpeciationModal();
}

function randomizeSpeciationName(): void {
  const nameInput = document.getElementById('speciation-name-input') as HTMLInputElement | null;
  if (!nameInput) return;
  const parentName = document.getElementById('sp-parent-name')?.textContent ?? 'Species';
  const base   = parentName.replace(/^(Neo|Para|Proto|Xeno|Hyper|Sub|Archi|Ur)/, '');
  const prefix = BRANCH_PREFIXES[Math.floor(Math.random() * BRANCH_PREFIXES.length)];
  nameInput.value = prefix + base;
  nameInput.focus();
}

// ─── Save / Load ──────────────────────────────────────────────────────────────

const SAVE_KEY = 'eternal_save_v1';

interface EternalSaveFile {
  version: 1;
  savedAt: number;
  gameState: GameStateData;
  engine: EngineSnapshot;
  eventLog: EventLogEntry[];
}

function buildSaveFile(): EternalSaveFile | null {
  if (!engine) return null;
  return {
    version: 1,
    savedAt: Date.now(),
    gameState: { ...gameState },
    engine: engine.serialize(),
    eventLog: eventLogEntries.slice(0, 500),
  };
}

function autoSaveGame(): void {
  const save = buildSaveFile();
  if (!save) return;
  try {
    const bytes = gzip(JSON.stringify(save));
    // Store as base64 (localStorage only accepts strings)
    let b64 = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    localStorage.setItem(SAVE_KEY, btoa(b64));
  } catch (e) {
    logger.warn('Auto-save failed:', e);
  }
}

function exportSaveFile(): void {
  const save = buildSaveFile();
  if (!save) return;
  const bytes = gzip(JSON.stringify(save));
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const name = (gameState.universeName || gameState.playerPlanetName || 'eternal').replace(/\s+/g, '_');
  a.download = `${name}_tick${gameState.tick}.eternal`;
  a.click();
  URL.revokeObjectURL(url);
  showSaveIndicator('EXPORTED');
}

function showSaveIndicator(label = 'SAVED'): void {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  el.textContent = `✓ ${label}`;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}

async function restoreFromBytes(bytes: Uint8Array): Promise<boolean> {
  try {
    const json = ungzip(bytes, { to: 'string' });
    const save = JSON.parse(json) as EternalSaveFile;
    if (!save.gameState || !save.engine || save.version !== 1) return false;
    return applyLoadedSave(save);
  } catch (e) {
    logger.error('Save restore failed:', e);
    return false;
  }
}

function applyLoadedSave(save: EternalSaveFile): boolean {
  Object.assign(gameState, save.gameState);
  gameState.screen = 'game';

  // Branch definitions are rebuilt from saved ids by `engine.init()` below, so
  // a save survives any later change to a branch's wording or colour. A
  // pre-branch-system save simply has none, and gets a fresh set.
  gameState.branchIds = Array.isArray(gameState.branchIds) ? gameState.branchIds : [];
  runtimeState.branchDefs = branchesFromIds(gameState.branchIds);

  if (Array.isArray(save.eventLog)) {
    eventLogEntries.length = 0;
    eventLogEntries.push(...save.eventLog);
  }

  showScreen('game');
  const gameCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  gameCanvas.width = window.innerWidth;
  gameCanvas.height = window.innerHeight;

  engine?.stop();
  engine = new BigBangEngine(gameCanvas);

  fallbackNarrator = new FallbackNarrator(save.gameState.masterSeed);
  _geminiService = geminiKey ? new GeminiService(geminiKey, save.gameState.masterSeed) : null;
  // Must be set BEFORE init(): init()'s pre-seed loop can roll a star straight
  // to 'intelligent' at tick 0 and calls ensureCivilization() synchronously —
  // if geminiService were assigned after init(), that civilisation would be
  // permanently locked to its procedural culture even with a valid API key.
  // (Any such pre-seed record is moot anyway once loadState() below restores
  // the actual saved civilisations, but the ordering must be correct
  // regardless of that.)
  engine.geminiService = _geminiService;
  engine.init(save.gameState.stats!, save.gameState.masterSeed);
  engine.loadState(save.engine);
  const godName = save.gameState.godName;

  chatHandler = async (msg: string) => {
    if (!geminiKey) return fallbackNarrator!.generateGodGreeting(godName);
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `You are ${godName}, ancient AI deity. The player says: "${msg}". Respond in 2 sentences, oracular tone.` }] }],
            generationConfig: { maxOutputTokens: 150 },
          }),
        }
      );
      const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? fallbackNarrator!.generateGodGreeting(godName);
    } catch {
      return fallbackNarrator!.generateGodGreeting(godName);
    }
  };

  wireEngineEvents(engine);
  void attachPixiRenderer(engine, gameCanvas);
  applyFrameRateCap(pendingFrameRateCap);
  engine.start();
  engine.focusPlayerStar();
  applyPlayModeControls();
  setSpeed(save.gameState.speed ?? 1);

  // Restore HUD displays
  document.getElementById('god-name-display')!.textContent = godName;
  document.getElementById('god-name-top')!.textContent = godName;
  updateHUDTick(save.gameState.tick);
  setResourceChip('dp-display', 'dp-display-val', save.gameState.divinePoints);

  const ps = engine.getPlayerStar();
  if (ps) updateBottomBar(ps);

  addChatMessage(`[ Universe restored — Tick ${save.gameState.tick.toLocaleString()} | ${new Date(save.savedAt).toLocaleString()} ]`, 'system');
  // A save made mid-forge resumes the Forge where it was.
  if (forgeActive()) startForgeIfDue();
  return true;
}

function loadFromLocalStorage(): boolean {
  const b64 = localStorage.getItem(SAVE_KEY);
  if (!b64) return false;
  try {
    const raw = atob(b64);
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const json = ungzip(bytes, { to: 'string' });
    const save = JSON.parse(json) as EternalSaveFile;
    if (!save.gameState || !save.engine || save.version !== 1) return false;
    return applyLoadedSave(save);
  } catch {
    return false;
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
const FRAME_RATE_KEY = 'eternal_frame_rate';
/** 0 = unlimited (match display refresh). */
type FrameRateCap = 0 | 30 | 60 | 120;

function loadFrameRateCap(): FrameRateCap {
  const raw = localStorage.getItem(FRAME_RATE_KEY);
  // Legacy "240" soft-cap → Unlimited (match display refresh).
  if (raw === '240') return 0;
  if (raw === '30' || raw === '60' || raw === '120') return Number(raw) as FrameRateCap;
  return 0;
}

let pendingFrameRateCap: FrameRateCap = loadFrameRateCap();

function applyFrameRateCap(cap: FrameRateCap): void {
  pendingFrameRateCap = cap;
  engine?.setTargetFps(cap);
  _dioramaRenderer?.setTargetFps(cap);
}

function syncFrameRateButtons(cap: FrameRateCap): void {
  document.querySelectorAll<HTMLButtonElement>('.settings-fps-btn').forEach(btn => {
    const v = Number(btn.dataset.fps);
    btn.classList.toggle('active', v === cap);
  });
}

function openSettings(): void {
  const overlay = document.getElementById('settings-overlay');
  const input = document.getElementById('gemini-key-input') as HTMLInputElement;
  if (overlay) overlay.classList.add('open');
  if (input) input.value = geminiKey;
  // Status is already set by the startup auto-test; only reset to idle if key changed
  if (!geminiKey) updateGeminiStatus('none');
  // Sync volume sliders to current settings
  const s = AudioManager.settings;
  const setSlider = (id: string, valId: string, v: number) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    const valEl = document.getElementById(valId);
    if (el) el.value = String(Math.round(v * 100));
    if (valEl) valEl.textContent = String(Math.round(v * 100));
  };
  setSlider('vol-master', 'vol-master-val', s.masterVolume);
  setSlider('vol-music',  'vol-music-val',  s.musicVolume);
  setSlider('vol-sfx',    'vol-sfx-val',    s.sfxVolume);
  syncFrameRateButtons(pendingFrameRateCap);
}

function closeSettings(): void {
  document.getElementById('settings-overlay')?.classList.remove('open');
}

function updateGeminiStatus(state: 'none' | 'idle' | 'testing' | 'ok' | 'error', msg?: string): void {
  const dot = document.getElementById('gemini-status-dot');
  const text = document.getElementById('gemini-status-text');
  if (!dot || !text) return;
  dot.className = 'gemini-status-dot';
  const map = {
    none:    { cls: 'status-none',    label: msg ?? 'No key configured' },
    idle:    { cls: 'status-none',    label: msg ?? 'Key entered — click TEST to verify' },
    testing: { cls: 'status-testing', label: msg ?? 'Testing connection…' },
    ok:      { cls: 'status-ok',      label: msg ?? 'Connected to Gemini ✓' },
    error:   { cls: 'status-error',   label: msg ?? 'Connection failed' },
  };
  dot.classList.add(map[state].cls);
  text.textContent = map[state].label;
}

async function testGeminiConnection(key: string): Promise<void> {
  updateGeminiStatus('testing');
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] }),
      }
    );
    if (resp.ok) {
      updateGeminiStatus('ok', 'Connected to Gemini 2.5 Flash — AI God is online ✓');
    } else {
      const err = await resp.json().catch(() => ({}));
      updateGeminiStatus('error', `Error ${resp.status}: ${(err as { error?: { message?: string } }).error?.message ?? 'Invalid key'}`);
    }
  } catch {
    updateGeminiStatus('error', 'Network error — check your connection');
  }
}

// ─── DOM Ready ────────────────────────────────────────────────────────────────
function setEvolveDrawer(open: boolean): void {
  document.querySelector('.left-panel')?.classList.toggle('drawer-open', open);
  document.getElementById('rail-evolve')?.classList.toggle('active', open);
}

function setEventsCollapsed(collapsed: boolean): void {
  document.body.classList.toggle('events-collapsed', collapsed);
}

function initHudShell(): void {
  document.getElementById('rail-evolve')?.addEventListener('click', () => {
    const panel = document.querySelector('.left-panel');
    setEvolveDrawer(!panel?.classList.contains('drawer-open'));
  });
  document.getElementById('evolve-drawer-close')?.addEventListener('click', () => setEvolveDrawer(false));
  document.getElementById('rail-god')?.addEventListener('click', () => {
    setEventsCollapsed(false);
    document.getElementById('player-input')?.focus();
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('rail-god')?.classList.add('active');
  });
  document.getElementById('rail-system')?.addEventListener('click', () => {
    const ps = engine?.getPlayerStar();
    if (ps) {
      // Solar system inspector — same path as clicking the player star
      closePlanetView();
      engine?.focusPlayerStar();
      openSystemPanel(ps);
    }
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('rail-system')?.classList.add('active');
  });
  document.getElementById('rail-chronicle')?.addEventListener('click', () => {
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('rail-chronicle')?.classList.add('active');
    openChronicle();
  });
  document.getElementById('rail-codex')?.addEventListener('click', () => {
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('rail-codex')?.classList.add('active');
    openCodex();
  });
  document.getElementById('events-collapse-btn')?.addEventListener('click', () => setEventsCollapsed(true));
  document.getElementById('events-tab')?.addEventListener('click', () => setEventsCollapsed(false));
  document.getElementById('help-btn')?.addEventListener('click', () => {
    document.getElementById('help-overlay')?.classList.add('open');
  });
  document.getElementById('help-close-btn')?.addEventListener('click', () => {
    document.getElementById('help-overlay')?.classList.remove('open');
  });
  document.getElementById('help-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) document.getElementById('help-overlay')?.classList.remove('open');
  });
  document.querySelectorAll('.divine-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.divine-action-btn').forEach(b => b.classList.remove('selected'));
      if (!(btn as HTMLButtonElement).disabled) btn.classList.add('selected');
    });
  });
  // Faith deck page dots — visual only, scroll panel
  const panel = document.getElementById('faith-panel');
  const dots = document.querySelectorAll('.faith-dot');
  panel?.addEventListener('scroll', () => {
    if (!panel || dots.length === 0) return;
    const max = panel.scrollWidth - panel.clientWidth;
    const idx = max <= 0 ? 0 : Math.round((panel.scrollLeft / max) * (dots.length - 1));
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
  });
  renderSegmentBar('status-dna-segs', 0, 20);
  renderSegmentBar('phase-segs', 0, 12);
  if (window.innerWidth < 1600) setEventsCollapsed(true);
}

window.addEventListener('DOMContentLoaded', () => {
  logger.info('Eternal Systems initializing');
  initHudShell();

  // Auto-validate stored Gemini key silently on startup
  if (geminiKey) void testGeminiConnection(geminiKey);

  showScreen('menu');

  // Start menu music immediately — AudioContext auto-resumes on first interaction
  void AudioManager.init().then(() => AudioManager.playMusic('ambient_menu'));

  document.getElementById('begin-btn')?.addEventListener('click', () => {
    showScreen('rolling');
    initRollingScreen();
  });

  document.getElementById('rolling-back-btn')?.addEventListener('click', () => {
    showScreen('menu');
  });

  // Planet name input updates roll gate + genesis button availability
  document.getElementById('planet-name-input')?.addEventListener('input', checkGenesisReady);
  document.getElementById('planet-name-randomize')?.addEventListener('click', randomizePlanetName);

  document.getElementById('continue-btn')?.addEventListener('click', () => {
    const loaded = loadFromLocalStorage();
    if (!loaded) {
      const msg = document.getElementById('no-save-msg');
      if (msg) { msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; }, 3000); }
    }
  });

  document.getElementById('roll-btn')?.addEventListener('click', rollCurrentStat);

  document.getElementById('genesis-btn')?.addEventListener('click', () => {
    if (Object.keys(lockedStats).length < STAT_KEYS.length || !godRollTriggered) return;
    const planet = (document.getElementById('planet-name-input') as HTMLInputElement | null)?.value.trim();
    if (!planet) return;
    launchBigBang();
  });

  document.getElementById('enter-universe-btn')?.addEventListener('click', enterUniverse);

  // Dev shortcut: ?dev=1 skips the D20 ritual and drops straight into the game.
  // Optional overrides: &life=20&evolution=14&hostility=6&entropy=9&divine=11&planet=Terra
  // Never reachable from the UI — the query string has to be typed deliberately.
  if (new URLSearchParams(location.search).get('dev') === '1') {
    const q = new URLSearchParams(location.search);
    const stat = (k: keyof UniverseStats, d: number) => Number(q.get(k)) || d;
    lockedStats.life      = stat('life', 14);
    lockedStats.evolution = stat('evolution', 12);
    lockedStats.hostility = stat('hostility', 9);
    lockedStats.entropy   = stat('entropy', 10);
    godDivineRoll = stat('divine', 12);
    godRollTriggered = true;
    answeredQuestions.climate = 'temperate';
    answeredQuestions.oceans  = 'mixed';
    answeredQuestions.chaos   = 'turbulent';
    // Formation lab flags (never reachable from the UI):
    //   &mode=creative       sandbox controls
    //   &destiny=ocean|...   force the home world's destiny
    //   &labdna=1            take the destiny from the setup DNA instead
    //   &formed=1            start already formed and alive (old behaviour);
    //                        implied by &lab=1 and &view=home, which need life
    if (q.get('mode') === 'creative') gameState.playMode = 'creative';
    const forcedDestiny = q.get('destiny');
    if (isDestinyType(forcedDestiny)) gameState.destinyOverride = forcedDestiny;
    else if (q.get('labdna') === '1') {
      const oceans: string = q.get('oceans') ?? answeredQuestions.oceans ?? 'mixed';
      gameState.destinyOverride = oceans === 'barren' ? 'rocky' : 'ocean';
    }
    gameState.skipFormation = q.get('formed') === '1' || q.get('lab') === '1' || q.get('view') === 'home';
    const nameInput = document.getElementById('planet-name-input') as HTMLInputElement | null;
    if (nameInput) nameInput.value = q.get('planet') || 'Terra';
    // The launch is async (it re-initialises game state when it lands), so the
    // shortcuts below wait for it rather than racing it.
    const launched = launchBigBangAsync();
    // Expose internals for console poking. Dev flag only.
    const dbg = window as unknown as Record<string, unknown>;
    dbg['__engine'] = engine;
    dbg['__gameState'] = gameState;
    dbg['__runtimeState'] = runtimeState;
    dbg['__diorama'] = () => _dioramaRenderer;
    dbg['__pixi'] = () => _pixiRenderer;
    dbg['__openPlanetView'] = openPlanetView;
    // &fps=1 draws a live frame-rate chip (also on for bare ?dev=1).
    if ((q.get('fps') === '1' || q.get('dev') === '1') && engine) {
      let chip = document.getElementById('fps-chip');
      if (!chip) {
        chip = document.createElement('div');
        chip.id = 'fps-chip';
        chip.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;font:11px/1.2 monospace;color:#c8a96e;background:rgba(0,0,8,.72);border:1px solid #443355;padding:4px 7px;pointer-events:none;';
        document.body.appendChild(chip);
      }
      engine.onFpsSample = (fps, ms) => {
        const ok = fps >= 110;
        chip!.style.color = ok ? '#5dcc8a' : fps >= 55 ? '#ff9944' : '#ff6644';
        chip!.textContent = `${fps.toFixed(0)} fps · ${ms.toFixed(1)} ms`;
      };
    }
    // &view=home also skips the Big Bang cinematic and opens the home world.
    if (q.get('view') === 'home') void launched.then(() => {
      enterUniverse();
      void openPlanetView();
    });

    // &lab=1 seeds a grown biosphere and a DNA balance, then opens the
    // Evolution Lab. A real world needs tens of thousands of ticks before it has
    // either, and requestAnimationFrame is throttled in a background tab, so
    // there is otherwise no way to look at this screen while working on it.
    if (q.get('lab') === '1') void launched.then(() => {
      enterUniverse();
      const rngL = new SeedRNG('devlab');
      if (gameState.playerSpecies.length === 0) {
        gameState.playerSpecies = initPlayerSpecies(0, rngL);
      }
      // The founder is the signature species (&phase= picks the card tier shown).
      const founder = gameState.playerSpecies[0];
      gameState.signatureSpeciesId = founder.id;
      gameState.speciesForms = [{ form: 1, name: founder.name, tick: 0, genome: { ...founder,
        dna: { ...founder.dna }, physicalTraits: { ...founder.physicalTraits },
        habitat: { ...founder.habitat }, evolutionaryPotential: { ...founder.evolutionaryPotential } },
        mutations: [] }];
      const labPhase = (q.get('phase') as BiologyPhase | null) ?? 'complex';
      const psL = engine?.getPlayerStar();
      if (psL) psL.biologyPhase = labPhase;
      let bioL = gameState.playerBiosphere;
      for (let i = 0; i < 60; i++) {
        const r = stepEvolution(labPhase, gameState.playerDNA, gameState.playerSpecies,
                                bioL, rngL, i * 2000, runtimeState.branchDefs,
                                { id: founder.id, locked: new Set() });
        gameState.playerSpecies = r.updatedSpecies;
        bioL = r.updatedBiosphere;
      }
      gameState.playerBiosphere = bioL;
      gameState.dnaPoints = Number(q.get('dna') ?? 40);
      // &codex=1 opens the Codex over the same seeded world instead of the lab.
      if (q.get('codex') === '1') openCodex();
      else openEvoLab();
    });
  }

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', function(this: HTMLElement) {
      setSpeed(Number(this.dataset['speed'] ?? 1));
    });
  });

  // Play mode, chosen on the setup screen before launch.
  const syncModeChoice = () => {
    document.querySelectorAll<HTMLElement>('.mode-choice').forEach(b => {
      b.classList.toggle('selected', b.dataset['mode'] === gameState.playMode);
    });
  };
  document.querySelectorAll<HTMLElement>('.mode-choice').forEach(b => {
    b.addEventListener('click', () => {
      gameState.playMode = b.dataset['mode'] === 'creative' ? 'creative' : 'normal';
      syncModeChoice();
    });
  });
  syncModeChoice();
  document.getElementById('place-life-btn')?.addEventListener('click', placeLifeAction);
  wireEraLeap();

  const playerInput = document.getElementById('player-input') as HTMLInputElement;

  async function sendChat(): Promise<void> {
    const msg = playerInput.value.trim();
    if (!msg) return;
    playerInput.value = '';
    addChatMessage(msg, 'player');
    const resp = await (chatHandler?.(msg) ?? Promise.resolve('The cosmos is silent.'));
    addChatMessage(resp, 'god');
  }

  playerInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { void sendChat(); } });
  document.getElementById('send-btn')?.addEventListener('click', () => { void sendChat(); });

  // Player's own planet opens from the bottom bar "View Planet" shortcut
  document.getElementById('view-planet-btn')?.addEventListener('click', () => openPlanetView());
  document.getElementById('focus-player-btn')?.addEventListener('click', () => engine?.focusPlayerStar(true));
  document.getElementById('top-mystar-btn')?.addEventListener('click', () => engine?.focusPlayerStar(true));
  document.getElementById('top-notif-btn')?.addEventListener('click', openEventLog);
  document.getElementById('view-homeworld-btn')?.addEventListener('click', () => {
    const ps = engine?.getPlayerStar();
    if (ps) {
      const homePlanet = engine?.homePlanetOf(ps);
      const idx = homePlanet ? ps.planets.indexOf(homePlanet) : -1;
      openPlanetView(ps, idx >= 0 ? idx : 0);
    }
  });
  // War dice modal
  document.getElementById('wd-roll-btn')?.addEventListener('click', rollDefenseDice);
  document.getElementById('wd-dismiss-btn')?.addEventListener('click', closeWarDiceModal);

  // Leader dialogue modal
  document.getElementById('leader-dlg-close')?.addEventListener('click', closeLeaderDialogue);
  document.getElementById('leader-freeform-send')?.addEventListener('click', async () => {
    const input = document.getElementById('leader-freeform-input') as HTMLInputElement;
    const text  = input?.value.trim();
    if (!text || !currentDialogueLeader) return;
    if (gameState.divinePoints < 1) { addChatMessage('Not enough Divine Points.', 'system'); return; }
    gameState.divinePoints -= 1;
    updateDivineActions();
    addFeedEntry(`-1 Divine Power — Leader communication: ${currentDialogueLeader.name}`, 'milestone');
    input.value = '';
    addChatMessage(`You spoke to ${currentDialogueLeader.name}: "${text}"`, 'player');
    appendLeaderMemory(currentDialogueLeader.id, `The god spoke: "${text.slice(0, 60)}"`);

    const msgEl = document.getElementById('leader-dlg-message')!;
    msgEl.textContent = '…';

    const memories = gameState.leaderMemories.find(m => m.leaderId === currentDialogueLeader!.id);
    const { text: reply } = await generateLeaderDialogue(
      currentDialogueLeader,
      `The god speaks directly: "${text}"`,
      memories,
      _geminiService,
      fallbackNarrator!,
    );
    msgEl.textContent = `"${reply}"`;

    setTimeout(closeLeaderDialogue, 3000);
  });

  // Timeline modal
  document.getElementById('timeline-btn')!.addEventListener('click', showTimeline);
  document.getElementById('timeline-close-btn')!.addEventListener('click', () => {
    document.getElementById('timeline-overlay')!.classList.remove('active');
  });

  // Codex modal
  document.getElementById('top-codex-btn')?.addEventListener('click', openCodex);
  document.getElementById('codex-close-btn')?.addEventListener('click', closeCodex);
  document.getElementById('codex-overlay')?.addEventListener('click', function(this: HTMLElement, e) {
    if (e.target === this) closeCodex();
  });
  // Search filters the list as you type.
  document.getElementById('codex-search')?.addEventListener('input', function(this: HTMLInputElement) {
    _codexSearch = this.value;
    renderCodexList();
  });
  document.querySelectorAll('.codex-tab').forEach(tab => {
    tab.addEventListener('click', function(this: HTMLElement) {
      _codexFilter = this.dataset['cat'] ?? 'all';
      document.querySelectorAll('.codex-tab').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      _codexActiveId = null;
      renderCodexList();
    });
  });

  document.getElementById('nudge-evolution-btn')?.addEventListener('click', nudgeEvolution);
  document.getElementById('divine-explore-btn')?.addEventListener('click', divineExplore);
  document.getElementById('bless-harvest-btn')?.addEventListener('click', blessHarvest);
  document.getElementById('send-prophet-btn')?.addEventListener('click', sendProphet);
  document.getElementById('smite-asteroid-btn')?.addEventListener('click', smiteAsteroid);
  document.getElementById('send-meteor-btn')?.addEventListener('click', sendMeteor);
  document.getElementById('trigger-revelation-btn')?.addEventListener('click', triggerRevelation);
  document.getElementById('terraform-btn')?.addEventListener('click', openTerraformModal);
  wireTerraformModal();

  // Planet questions — clicking a choice records the answer
  document.querySelectorAll('.pq-choice').forEach(btn => {
    btn.addEventListener('click', function(this: HTMLElement) {
      const q = this.dataset['q'] as keyof PlanetDNA;
      const v = this.dataset['v'];
      if (!q || !v) return;
      // Deselect siblings
      document.querySelectorAll(`.pq-choice[data-q="${q}"]`).forEach(el => el.classList.remove('selected'));
      this.classList.add('selected');
      document.getElementById(`pq-card-${q}`)?.classList.add('answered');
      (answeredQuestions as Record<string, string>)[q] = v;
      // Show reveal text
      const revealEl = document.getElementById(`pq-reveal-${q}`);
      if (revealEl) {
        revealEl.textContent = this.dataset['reveal'] ?? '';
        revealEl.classList.add('visible');
      }
      checkGenesisReady();
    });
  });
  document.getElementById('close-planet-btn')?.addEventListener('click', closePlanetView);
  initPlanetMap();
  initEvoLab();
  initZoomTiers();

  // In-game naming modal
  document.getElementById('ingame-naming-confirm')?.addEventListener('click', confirmNaming);
  document.getElementById('ingame-naming-randomize')?.addEventListener('click', randomizeName);
  document.getElementById('ingame-naming-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmNaming();
  });

  // Speciation modal
  document.getElementById('speciation-confirm')?.addEventListener('click', confirmSpeciation);
  document.getElementById('speciation-dismiss')?.addEventListener('click', () => closeSpeciationModal(true));
  document.getElementById('speciation-randomize')?.addEventListener('click', randomizeSpeciationName);
  document.getElementById('speciation-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSpeciation();
  });
  document.querySelectorAll('.sp-trait-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sp-trait-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      _selectedSpeciationTrait = (btn as HTMLElement).dataset['trait'] ?? 'none';
    });
  });
  document.getElementById('close-star-info')?.addEventListener('click', () => {
    document.getElementById('star-info-panel')!.style.display = 'none';
  });

  // DNA Lab — commit button opens species traits modal
  document.getElementById('el-commit-btn')?.addEventListener('click', openEvoLab);

  // Species traits modal (close + evolve wired internally)
  wireTraitsModal();

  // Event log modal
  document.getElementById('event-log-expand-btn')?.addEventListener('click', openEventLog);
  document.getElementById('event-log-close-btn')?.addEventListener('click', closeEventLog);
  document.getElementById('event-log-modal')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEventLog();
  });
  document.getElementById('event-log-search')?.addEventListener('input', (e) => {
    eventLogSearch = (e.target as HTMLInputElement).value;
    renderEventLog();
  });
  document.querySelectorAll('.elf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      eventLogFilter = (btn as HTMLElement).dataset['filter'] ?? 'all';
      document.querySelectorAll('.elf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderEventLog();
    });
  });

  // Settings (menu screen + in-game top bar both open the same modal)
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('menu-settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('settings-close-btn')?.addEventListener('click', closeSettings);

  // Volume sliders — live preview
  const wireVol = (sliderId: string, valId: string, setter: (v: number) => void) => {
    const el = document.getElementById(sliderId) as HTMLInputElement | null;
    const valEl = document.getElementById(valId);
    el?.addEventListener('input', () => {
      const v = Number(el.value) / 100;
      if (valEl) valEl.textContent = el.value;
      void AudioManager.init().then(() => setter(v));
    });
  };
  wireVol('vol-master', 'vol-master-val', v => AudioManager.setMasterVolume(v));
  wireVol('vol-music',  'vol-music-val',  v => AudioManager.setMusicVolume(v));
  wireVol('vol-sfx',    'vol-sfx-val',    v => AudioManager.setSfxVolume(v));
  document.getElementById('settings-fps-row')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest?.('.settings-fps-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const v = Number(btn.dataset.fps);
    const cap: FrameRateCap = (v === 30 || v === 60 || v === 120) ? v : 0;
    syncFrameRateButtons(cap);
    applyFrameRateCap(cap);
  });
  syncFrameRateButtons(pendingFrameRateCap);
  document.getElementById('settings-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById('toggle-key-visibility')?.addEventListener('click', () => {
    const input = document.getElementById('gemini-key-input') as HTMLInputElement;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('test-gemini-btn')?.addEventListener('click', () => {
    const key = (document.getElementById('gemini-key-input') as HTMLInputElement).value.trim();
    if (key) void testGeminiConnection(key);
  });
  document.getElementById('gemini-key-input')?.addEventListener('input', () => {
    updateGeminiStatus('idle');
  });
  document.getElementById('settings-save-btn')?.addEventListener('click', () => {
    const key = (document.getElementById('gemini-key-input') as HTMLInputElement).value.trim();
    geminiKey = key;
    if (key) {
      localStorage.setItem('eternal_gemini_key', key);
    } else {
      localStorage.removeItem('eternal_gemini_key');
    }
    // Frame rate: persist selected button and apply immediately
    const activeFps = document.querySelector<HTMLButtonElement>('.settings-fps-btn.active');
    const cap = (activeFps ? Number(activeFps.dataset.fps) : 0) as FrameRateCap;
    const next: FrameRateCap = (cap === 30 || cap === 60 || cap === 120) ? cap : 0;
    if (next === 0) localStorage.removeItem(FRAME_RATE_KEY);
    else localStorage.setItem(FRAME_RATE_KEY, String(next));
    applyFrameRateCap(next);
    // Recreate gemini service with new key
    if (_geminiService) _geminiService.destroy?.();
    _geminiService = key ? new GeminiService(key, gameState.masterSeed) : null;
    if (engine) engine.geminiService = _geminiService;
    closeSettings();
    // Notify in-game if active
    if (gameState.screen === 'game' || gameState.screen === 'bigbang') {
      addChatMessage(key
        ? '[ Gemini API key saved. The God now speaks with true intelligence. ]'
        : '[ API key removed. Returning to offline narrator. ]',
        'system'
      );
    }
  });

  document.getElementById('export-save-btn')?.addEventListener('click', exportSaveFile);

  document.getElementById('import-save-btn')?.addEventListener('click', () => {
    document.getElementById('import-file-input')?.click();
  });

  document.getElementById('import-file-input')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file.arrayBuffer().then(buf => {
      void restoreFromBytes(new Uint8Array(buf)).then(ok => {
        if (!ok) addChatMessage('[ Failed to load save file — it may be corrupt or from an incompatible version. ]', 'system');
      });
    });
    (e.target as HTMLInputElement).value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePlanetView();
    if (e.key === 'f' || e.key === 'F') engine?.focusPlayerStar();
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (gameState.screen === 'game') { autoSaveGame(); showSaveIndicator(); }
    }
  });

  window.addEventListener('resize', () => {
    const bb = document.getElementById('bigbang-canvas') as HTMLCanvasElement | null;
    const gc = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (bb) { bb.width = window.innerWidth; bb.height = window.innerHeight; }
    if (gc) { gc.width = window.innerWidth; gc.height = window.innerHeight; }
  });
});

(window as unknown as Record<string, unknown>)['eternalSpeed'] = 1;

// ═════════════════════════════════════════════════════════════════════════════
// PLANET MAP (M22d)
//
// The diorama projects one hemisphere onto a disc, so half the world was simply
// unreachable — you could not look at it, let alone act on it. This is the whole
// 256×256 grid laid out flat, with the species living on it as first-class
// objects you can inspect, act on, and speak to.
// ═════════════════════════════════════════════════════════════════════════════

type MapLayer = 'biome' | 'species' | 'civ' | 'elevation';

let _pmLayer: MapLayer = 'biome';
let _pmSelected: { row: number; col: number } | null = null;
/** How many cells this species currently occupies, and where its centre is. */
function speciesRange(id: string): { cells: number; row: number; col: number } {
  const grid = runtimeState.playerPlanetGrid;
  if (!grid) return { cells: 0, row: 0, col: 0 };
  let n = 0, sr = 0, sc = 0;
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (grid[r][c].dominantSpeciesId === id) { n++; sr += r; sc += c; }
    }
  }
  return n === 0 ? { cells: 0, row: 0, col: 0 }
                 : { cells: n, row: Math.round(sr / n), col: Math.round(sc / n) };
}

function drawPlanetMap(): void {
  const canvas = document.getElementById('pm-canvas') as HTMLCanvasElement | null;
  const grid = runtimeState.playerPlanetGrid;
  if (!canvas || !grid) return;

  canvas.width = GRID_SIZE;
  canvas.height = GRID_SIZE;
  // Keep the map wide: an equirectangular world reads better at 2:1 than square.
  canvas.style.width = '100%';
  canvas.style.aspectRatio = '2 / 1';

  const g = canvas.getContext('2d');
  if (!g) return;
  const img = g.createImageData(GRID_SIZE, GRID_SIZE);
  const d = img.data;

  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = grid[r][c];
      const i = (r * GRID_SIZE + c) * 4;
      let cr = 0, cg = 0, cb = 0;

      const [br, bg, bb] = BIOME_COLORS[cell.biome] ?? [60, 60, 70];

      if (_pmLayer === 'elevation') {
        // Water stays blue so the coastline is still legible under the ramp.
        if (isWater(cell.biome)) { cr = 24; cg = 44; cb = 86; }
        else {
          const t = Math.max(0, Math.min(1, (cell.elevation - SEA_LEVEL) / (1 - SEA_LEVEL)));
          cr = 40 + t * 215; cg = 52 + t * 190; cb = 60 + t * 150;
        }
      } else if (_pmLayer === 'civ') {
        const dim = isWater(cell.biome) ? 0.45 : 0.30;
        cr = br * dim; cg = bg * dim; cb = bb * dim;
        if (cell.civId != null) { cr = 255; cg = 196; cb = 96; }
      } else if (_pmLayer === 'species') {
        const dim = 0.26;
        cr = br * dim; cg = bg * dim; cb = bb * dim;
        const sid = cell.dominantSpeciesId;
        if (sid) {
          const rgbv = speciesRGB(sid);
          // Weight by how much life is actually there, so range edges fade out.
          const w = 0.35 + Math.min(1, cell.lifeDensity) * 0.65;
          cr = cr * (1 - w) + rgbv[0] * w;
          cg = cg * (1 - w) + rgbv[1] * w;
          cb = cb * (1 - w) + rgbv[2] * w;
        }
      } else {
        cr = br; cg = bg; cb = bb;
        if (cell.river > 0 && !isWater(cell.biome)) {
          const tinted = tintRiver(cr, cg, cb, cell.river);
          cr = tinted[0]; cg = tinted[1]; cb = tinted[2];
        }
        // A little relief so continents read as terrain, not flat colour.
        const east = grid[r]?.[(c + 1) % GRID_SIZE];
        const slope = east ? (cell.elevation - east.elevation) * 5 : 0;
        const f = 1 + Math.max(-0.28, Math.min(0.28, slope));
        cr *= f; cg *= f; cb *= f;
      }

      d[i]     = Math.max(0, Math.min(255, cr));
      d[i + 1] = Math.max(0, Math.min(255, cg));
      d[i + 2] = Math.max(0, Math.min(255, cb));
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // Selection marker — crosshair rather than a filled box, so the cell under it
  // stays visible.
  if (_pmSelected) {
    const { row, col } = _pmSelected;
    g.strokeStyle = 'rgba(255,240,180,0.95)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(col + 0.5, Math.max(0, row - 6)); g.lineTo(col + 0.5, Math.max(0, row - 2));
    g.moveTo(col + 0.5, Math.min(GRID_SIZE, row + 3)); g.lineTo(col + 0.5, Math.min(GRID_SIZE, row + 7));
    g.moveTo(Math.max(0, col - 6), row + 0.5); g.lineTo(Math.max(0, col - 2), row + 0.5);
    g.moveTo(Math.min(GRID_SIZE, col + 3), row + 0.5); g.lineTo(Math.min(GRID_SIZE, col + 7), row + 0.5);
    g.stroke();
    g.strokeRect(col - 1.5, row - 1.5, 4, 4);
  }
}


/** Divine acts that target a SPECIES rather than a place. */
interface SpeciesAct {
  id: string; label: string; cost: number;
  enabled: (sp: SpeciesGenome) => boolean;
  run: (sp: SpeciesGenome) => string;
}

const SPECIES_ACTS: SpeciesAct[] = [
  {
    id: 'favour', label: 'Favour this lineage', cost: 10,
    enabled: () => true,
    run: (sp) => {
      sp.population = Math.min(1.4, sp.population + 0.22);
      sp.dna.adaptability = Math.min(10, sp.dna.adaptability + 1);
      // Their range grows with them: life thickens where they already are.
      const grid = runtimeState.playerPlanetGrid;
      if (grid) {
        for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
          const cell = grid[r][c];
          if (cell.dominantSpeciesId === sp.id) {
            cell.lifeDensity = Math.min(1, cell.lifeDensity + 0.18);
            cell.fertility   = Math.min(1, cell.fertility + 0.10);
          }
        }
      }
      return `${sp.name} thrives. Their numbers swell and they grow hardier.`;
    },
  },
  {
    id: 'cull', label: 'Cull this lineage', cost: 10,
    enabled: (sp) => sp.population > 0.06,
    run: (sp) => {
      sp.population = Math.max(0.02, sp.population - 0.30);
      const grid = runtimeState.playerPlanetGrid;
      if (grid) {
        for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
          const cell = grid[r][c];
          if (cell.dominantSpeciesId === sp.id) {
            cell.lifeDensity = Math.max(0, cell.lifeDensity - 0.34);
          }
        }
      }
      return `${sp.name} is struck down. Their range thins and falls quiet.`;
    },
  },
  {
    id: 'awaken', label: 'Kindle their minds', cost: 20,
    enabled: (sp) => sp.dna.intelligence < 10,
    run: (sp) => {
      sp.dna.intelligence = Math.min(10, sp.dna.intelligence + 1);
      sp.evolutionaryPotential.intelligenceGrowth =
        Math.min(1, sp.evolutionaryPotential.intelligenceGrowth + 0.12);
      return `Something new stirs behind the eyes of ${sp.name}.`;
    },
  },
  {
    id: 'spread', label: 'Drive them outward', cost: 12,
    enabled: (sp) => speciesRange(sp.id).cells > 0,
    run: (sp) => {
      // Push the lineage into every unclaimed habitable neighbour it touches.
      const grid = runtimeState.playerPlanetGrid;
      if (!grid) return 'The world does not answer.';
      const claimed: Array<[number, number]> = [];
      const STEPS: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
        if (grid[r][c].dominantSpeciesId !== sp.id) continue;
        for (const [dr, dc] of STEPS) {
          const r2 = r + dr;
          if (r2 < 0 || r2 >= GRID_SIZE) continue;
          const c2 = (c + dc + GRID_SIZE) % GRID_SIZE;
          const n = grid[r2][c2];
          if (n.dominantSpeciesId == null && isHabitable(n.biome) && n.fertility > 0.1) {
            claimed.push([r2, c2]);
          }
        }
      }
      for (const [r, c] of claimed) {
        grid[r][c].dominantSpeciesId = sp.id;
        grid[r][c].lifeDensity = Math.max(grid[r][c].lifeDensity, 0.4);
      }
      return claimed.length === 0
        ? `${sp.name} has nowhere left to go.`
        : `${sp.name} pushes into ${claimed.length} new regions.`;
    },
  },
];

function pmSpeciesAt(cell: GridCell): SpeciesGenome | null {
  const id = cell.dominantSpeciesId;
  if (!id) return null;
  return gameState.playerSpecies.find(sp => sp.id === id && !sp.isExtinct) ?? null;
}

function pmSelect(row: number, col: number): void {
  const grid = runtimeState.playerPlanetGrid;
  if (!grid) return;
  const cell = grid[row]?.[col];
  if (!cell) return;
  _pmSelected = { row, col };

  document.getElementById('pm-empty')!.style.display = 'none';
  document.getElementById('pm-cell')!.style.display = '';

  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set('pm-coord', `${row}, ${col}`);
  set('pm-biome', cell.biome.replace(/_/g, ' '));
  set('pm-elev', cell.elevation.toFixed(2) + (isWater(cell.biome) ? ' (submerged)' : ''));
  set('pm-temp', cell.temperature.toFixed(2));
  set('pm-moist', cell.moisture.toFixed(2));
  set('pm-fert', cell.fertility.toFixed(2));
  set('pm-life', cell.lifeDensity.toFixed(2));
  set('pm-civ', cell.civId != null ? 'yes' : 'no');

  const sp = pmSpeciesAt(cell);
  const spBox = document.getElementById('pm-species')!;
  if (!sp) {
    spBox.style.display = 'none';
    drawPlanetMap();
    return;
  }
  spBox.style.display = '';

  set('pm-sp-name', sp.name);
  set('pm-sp-tagline',
    `A ${sp.physicalTraits.size} ${sp.dna.diet} of the ${sp.dna.environment.replace(/_/g, ' ')}, ` +
    `${sp.dna.locomotion} on ${sp.physicalTraits.mobilityType}, sensing by ${sp.physicalTraits.sensorySystem}.`);

  const traits = document.getElementById('pm-sp-traits')!;
  traits.innerHTML = '';
  for (const t of [
    sp.dna.metabolism, sp.dna.respiration, sp.dna.reproduction,
    sp.physicalTraits.bodyStructure, sp.habitat.temperatureRange,
  ]) {
    const chip = document.createElement('span');
    chip.className = 'pm-trait';
    chip.textContent = String(t).replace(/_/g, ' ');
    traits.appendChild(chip);
  }

  const range = speciesRange(sp.id);
  set('pm-sp-pop', `${(sp.population * 100).toFixed(0)}% dominance`);
  set('pm-sp-range', `${range.cells.toLocaleString()} regions`);
  set('pm-sp-int', `${sp.dna.intelligence}/10` +
    (sp.dna.intelligence >= 7 ? ' — they can be spoken to'
     : sp.dna.intelligence >= 3 ? ' — they sense you dimly'
     : ' — no mind to reach'));

  buildSpeciesActs(sp);
  drawPlanetMap();
}

function buildSpeciesActs(sp: SpeciesGenome): void {
  const wrap = document.getElementById('pm-sp-acts')!;
  const msg  = document.getElementById('pm-sp-msg')!;
  wrap.innerHTML = '';
  msg.textContent = '';

  const mk = (label: string, cost: number, ok: boolean, why: string, run: () => void) => {
    const btn = document.createElement('button');
    btn.className = 'pm-act';
    btn.append(label);
    const c = document.createElement('span');
    c.className = 'cost';
    c.textContent = cost > 0 ? `${cost} DP` : '';
    btn.appendChild(c);
    const afford = gameState.divinePoints >= cost;
    btn.disabled = !ok || !afford;
    btn.title = !ok ? why : !afford ? `Needs ${cost} Divine Power` : '';
    btn.addEventListener('click', run);
    wrap.appendChild(btn);
  };

  for (const act of SPECIES_ACTS) {
    mk(act.label, act.cost, act.enabled(sp), 'Not possible for this lineage', () => {
      if (gameState.divinePoints < act.cost) return;
      gameState.divinePoints -= act.cost;
      const report = act.run(sp);
      msg.textContent = report;
      addChatMessage(report, 'god');
      addFeedEntry(`Divine act on ${sp.name} — ${act.label}`, 'milestone');
      updateDivineActions();
      _dioramaRenderer?.setLiveData(gameState.playerSpecies, gameState.playerBiosphere);
      _dioramaRenderer?.markSurfaceDirty(true);
      buildSpeciesActs(sp);
      drawPlanetMap();
    });
  }

  // Speaking to them. A lineage with no mind cannot be addressed — saying so
  // plainly is more interesting than hiding the option.
  mk('Speak to them', 1, sp.dna.intelligence >= 3, 'They have no mind to reach', () => {
    if (gameState.divinePoints < 1) return;
    void communeWithSpecies(sp);
  });
}

/**
 * Address a species directly.
 *
 * A civilised world already has a named leader who speaks for it, so route to
 * the existing leader dialogue there. Below that, there is nobody to negotiate
 * with — what comes back is an impression, not a conversation, and it reads
 * better for saying so.
 */
async function communeWithSpecies(sp: SpeciesGenome): Promise<void> {
  const ps = engine?.getPlayerStar();
  const leader = gameState.leaders.find(l => l.starId === gameState.playerStarId);

  if (leader && ps?.biologyPhase === 'intelligent' && sp.dna.intelligence >= 7) {
    closePlanetMap();
    await showLeaderDialogue(leader, `The god has reached out to ${sp.name} directly.`);
    return;
  }

  gameState.divinePoints -= 1;
  updateDivineActions();

  const msg = document.getElementById('pm-sp-msg')!;
  const sense = sp.physicalTraits.sensorySystem;
  const lines = sp.dna.intelligence >= 7
    ? [`${sp.name} answers. Not in words — in a held silence, and then a slow turning toward you.`,
       `The minds of ${sp.name} press back against yours, curious and unafraid.`]
    : sp.dna.intelligence >= 5
    ? [`${sp.name} stops what it is doing. Something in it knows it is being watched.`,
       `A ripple passes through ${sp.name}. They do not understand, but they attend.`]
    : [`Through ${sense}, ${sp.name} registers you as weather — vast, and not to be argued with.`,
       `${sp.name} feels the pressure of your attention and moves, uneasily, away from it.`];

  const line = lines[Math.floor(Math.random() * lines.length)];
  msg.textContent = line;
  addChatMessage(line, 'god');
  addFeedEntry(`Communed with ${sp.name}`, 'milestone');
  buildSpeciesActs(sp);
}

// ── Planet map open / close / wiring ─────────────────────────────────────────

function openPlanetMap(at?: { row: number; col: number } | null): void {
  if (!runtimeState.playerPlanetGrid) return;
  document.getElementById('planet-map-overlay')!.classList.add('active');
  // Pause the diorama while the map is up: it is a second full renderer and
  // there is no reason for both to be running.
  _dioramaRenderer?.pause();
  if (at) pmSelect(at.row, at.col);
  else drawPlanetMap();
}

function closePlanetMap(): void {
  document.getElementById('planet-map-overlay')!.classList.remove('active');
  _dioramaRenderer?.resume();
}

function initPlanetMap(): void {
  document.getElementById('pm-close')?.addEventListener('click', closePlanetMap);
  document.getElementById('planet-map-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePlanetMap();
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.pm-layer')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pm-layer').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _pmLayer = (btn.dataset.layer as MapLayer) ?? 'biome';
      drawPlanetMap();
    });
  }

  const canvas = document.getElementById('pm-canvas') as HTMLCanvasElement | null;
  canvas?.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // The canvas is a 256×256 buffer stretched to a 2:1 box, so x and y scale
    // by different factors — using one factor for both puts every click in the
    // wrong hemisphere.
    const col = Math.floor((e.clientX - rect.left) / rect.width * GRID_SIZE);
    const row = Math.floor((e.clientY - rect.top) / rect.height * GRID_SIZE);
    if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) return;
    pmSelect(row, col);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// EVOLUTION LAB POP-UP (M22h)
//
// The DNA branches used to live in a thin strip of the HUD, where the most
// consequential decision in the game got the same visual weight as a stat
// readout. This is the same data as a pixel-art CRT terminal, after
// `dna_lab pop-up idea.jpg`.
//
// Since the signature-species rework (docs/superpowers/specs/
// 2026-10-04-signature-species-evolution-design.md) it is where the player
// buys mutation cards into a queue and evolves their own species; the side
// panel is a summary of the same state and opens it.
// ═════════════════════════════════════════════════════════════════════════════

/** The lab's subject: the player's signature lineage (the most populous one as a fallback). */
function labSpecimen(): SpeciesGenome | null {
  const sig = engine?.signatureSpecies() ?? null;
  if (sig) return sig;
  const living = gameState.playerSpecies.filter(s => !s.isExtinct);
  if (living.length === 0) return null;
  return living.reduce((a, b) => (b.population > a.population ? b : a));
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const roman = (n: number) => ROMAN[n - 1] ?? String(n);

/** A crisp creature canvas whose long edge is about `px` screen pixels. */
/** A drawable genome for a people known only by their culture's summary. */
function genomeFromSummary(g: GenomeSummary, id: string): SpeciesGenome {
  const mobility = g.locomotion === 'flying' ? 'feathered wings' : g.locomotion === 'swimming' ? 'fins' : 'legs';
  return {
    id, name: g.speciesName, originTick: 0, population: 1, isExtinct: false, ancestorId: null,
    dna: {
      metabolism: g.metabolism, locomotion: g.locomotion, environment: g.environment, reproduction: g.reproduction,
      diet: g.diet, respiration: g.respiration, intelligence: g.intelligence, social: g.social,
      aggression: g.aggression, adaptability: g.adaptability,
    },
    physicalTraits: { size: g.size, bodyStructure: g.bodyStructure, mobilityType: mobility, sensorySystem: g.sensorySystem },
    habitat: { biome: g.biome, temperatureRange: g.temperatureRange },
    evolutionaryPotential: { landTransition: 1, intelligenceGrowth: 0, toolUse: 1 },
  } as SpeciesGenome;
}

function creatureCanvas(g: SpeciesGenome, px: number): HTMLCanvasElement {
  return bakeCreaturePortrait(g, px);
}

/** DNA awards this session, newest first — the lab's "how did I earn this". */
const dnaEarnLog: Array<{ n: number; why: string }> = [];

function mutationContext() {
  const ps = engine?.getPlayerStar();
  return {
    genome: labSpecimen(),
    phase: (ps?.biologyPhase ?? 'microbial') as BiologyPhase,
    owned: gameState.mutationsOwned,
    queued: gameState.mutationQueue,
    offered: gameState.offeredMutations,
    points: gameState.dnaPoints,
  };
}

/** Buy a card into the queue (DNA spent now; un-queue refunds). */
function queueMutation(id: string): void {
  const st = cardStates(mutationContext()).find(c => c.def.id === id);
  if (!st || st.status !== 'available' || !st.affordable) return;
  gameState.dnaPoints -= st.def.cost;
  gameState.mutationQueue.push(id);
  AudioManager.playSfx('ui_click');
  refreshEvolutionUI();
}

function unqueueMutation(id: string): void {
  const i = gameState.mutationQueue.lastIndexOf(id);
  if (i < 0) return;
  gameState.mutationQueue.splice(i, 1);
  // A spontaneous card was free: removing it refunds nothing.
  const gi = gameState.mutationGifts.indexOf(id);
  if (gi >= 0) gameState.mutationGifts.splice(gi, 1);
  else gameState.dnaPoints += MUTATION_BY_ID[id]?.cost ?? 0;
  // Cards that needed this one cannot stay queued without it.
  for (let guard = 0; guard < 8; guard++) {
    const bad = gameState.mutationQueue.find(q => {
      const req = MUTATION_BY_ID[q]?.requiresAny;
      return req && !req.some(r => gameState.mutationsOwned.includes(r) || gameState.mutationQueue.includes(r));
    });
    if (!bad) break;
    unqueueMutation(bad);
  }
  refreshEvolutionUI();
}

function refreshEvolutionUI(): void {
  updateDNAPanel();
  renderEvoLab();
}

function renderEvoLab(): void {
  const overlay = document.getElementById('evo-lab-overlay');
  if (!overlay || !overlay.classList.contains('active')) return;

  const ps = engine?.getPlayerStar();
  const sp = labSpecimen();
  const ctx = mutationContext();
  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  // ── Your species: current form, next form, queue, EVOLVE ──────────────────
  const tank = document.getElementById('evo-tank')!;
  tank.innerHTML = '';
  const form = Math.max(1, gameState.speciesForms.length);
  if (sp) {
    tank.appendChild(creatureCanvas(sp, 150));
    set('evo-form-tag', `FORM ${roman(form)}`);
    set('evo-specimen-name', gameState.playerSpeciesName && form === 1 ? `${gameState.playerSpeciesName}` : sp.name);
    const WHERE: Record<string, string> = {
      land: 'across open land', ocean: 'through open water',
      deep_sea: 'in the deep', coastal: 'along the shoreline', aerial: 'on the wing',
    };
    set('evo-specimen-kind',
      `${sp.physicalTraits.size} ${sp.physicalTraits.bodyStructure} ${sp.dna.diet} — ${sp.dna.locomotion} ` +
      `${WHERE[sp.dna.environment] ?? 'in the ' + sp.dna.environment.replace(/_/g, ' ')}`);
    const stats = document.getElementById('evo-specimen-stats')!;
    stats.innerHTML = '';
    const rows: Array<[string, string]> = [
      ['INTELLECT', `${sp.dna.intelligence}/10`], ['SOCIAL', `${sp.dna.social}/10`],
      ['AGGRESSION', `${sp.dna.aggression}/10`], ['ADAPTABILITY', `${sp.dna.adaptability}/10`],
      ['SENSES', sp.physicalTraits.sensorySystem], ['DOMINANCE', `${(sp.population * 100).toFixed(0)}%`],
    ];
    for (const [k, v] of rows) {
      const d = document.createElement('div');
      d.className = 'evo-stat';
      d.innerHTML = `<span>${k}</span><b></b>`;
      d.querySelector('b')!.textContent = v;
      stats.appendChild(d);
    }
  } else {
    set('evo-form-tag', '');
    set('evo-specimen-name', 'NO SPECIMEN');
    set('evo-specimen-kind', ps?.formationStage
      ? 'Your world is still forming. Life will come.'
      : 'Life has not yet taken hold on this world.');
    document.getElementById('evo-specimen-stats')!.innerHTML = '';
  }

  const next = document.getElementById('evo-next')!;
  const queue = gameState.mutationQueue;
  next.classList.toggle('hidden', !sp || queue.length === 0);
  if (sp && queue.length > 0) {
    const nt = document.getElementById('evo-next-tank')!;
    nt.innerHTML = '';
    nt.appendChild(creatureCanvas(previewGenome(sp, queue), 84));
    const chips = document.getElementById('evo-queue')!;
    chips.innerHTML = '';
    for (const id of queue) {
      const def = MUTATION_BY_ID[id];
      if (!def) continue;
      const b = document.createElement('button');
      const gift = gameState.mutationGifts.includes(id);
      b.className = 'evo-qchip' + (gift ? ' gift' : '');
      b.textContent = `${def.glyph} ${def.label} ✕`;
      b.title = gift ? 'A spontaneous mutation (free). Click to discard.' : `Click to un-queue (refunds ${def.cost} DNA)`;
      b.addEventListener('click', () => unqueueMutation(id));
      chips.appendChild(b);
    }
  }
  const evolveBtn = document.getElementById('evo-evolve-btn') as HTMLButtonElement;
  const ready = !!sp && queueReady(queue);
  evolveBtn.disabled = !ready;
  evolveBtn.classList.toggle('ready', ready);
  evolveBtn.textContent = ready ? '◈ EVOLVE ◈'
    : queue.length > 0 ? `QUEUE ${EVOLVE_THRESHOLD - queue.length} MORE (OR A MAJOR CARD)`
    : 'QUEUE MUTATIONS TO EVOLVE';

  // ── Mutation tree, by phase ────────────────────────────────────────────────
  const tree = document.getElementById('evo-tree')!;
  tree.innerHTML = '';
  const states = cardStates(ctx);
  const phIdx = BIO_PHASE_SEQUENCE.indexOf(ctx.phase);
  BIO_PHASE_SEQUENCE.forEach((ph, i) => {
    const cards = states.filter(c => c.def.phase === ph);
    if (cards.length === 0) return;
    const tier = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'evo-tier-head' + (i === phIdx ? ' now' : '');
    head.innerHTML = `<span></span><span></span>`;
    head.children[0].textContent = (BIO_PHASE_LABELS[ph] ?? ph).toUpperCase();
    head.children[1].textContent = i > phIdx ? 'LOCKED' : i === phIdx ? 'NOW' : '';
    tier.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'evo-tier-cards';
    for (const c of cards) {
      const b = document.createElement('button');
      const poor = c.status === 'available' && !c.affordable;
      b.className = `evo-card ${c.status}` + (c.def.major ? ' major' : '') + (poor ? ' poor' : '');
      b.innerHTML = `<div class="c-top"><span class="c-glyph"></span><span class="c-name"></span><span class="c-cost"></span></div>`
        + `<div class="c-blurb"></div><div class="c-tag"></div>`;
      b.querySelector('.c-glyph')!.textContent = c.def.glyph;
      b.querySelector('.c-name')!.textContent = c.def.label;
      b.querySelector('.c-cost')!.textContent =
        c.status === 'owned' ? '✓' : c.status === 'queued' ? 'QUEUED' : `${c.def.cost}`;
      b.querySelector('.c-blurb')!.textContent = c.def.blurb;
      const tag = c.status === 'locked' ? (c.reason ?? '')
        : poor ? `Needs ${c.def.cost - gameState.dnaPoints} more DNA`
        : c.def.group ? `Fork: pick one ${c.def.group} path` : '';
      b.querySelector('.c-tag')!.textContent = tag;
      b.disabled = c.status === 'owned' || c.status === 'locked' || poor;
      if (c.status === 'available') b.addEventListener('click', () => queueMutation(c.def.id));
      if (c.status === 'queued') { b.disabled = false; b.title = 'Click to un-queue'; b.addEventListener('click', () => unqueueMutation(c.def.id)); }
      grid.appendChild(b);
    }
    tier.appendChild(grid);
    tree.appendChild(tier);
  });

  // ── DNA, earnings, dex ─────────────────────────────────────────────────────
  set('evo-dna-points', String(gameState.dnaPoints));
  set('evo-phase', ps ? (BIO_PHASE_LABELS[ps.biologyPhase] ?? ps.biologyPhase) : '—');
  const earned = document.getElementById('evo-earned')!;
  earned.innerHTML = '';
  if (dnaEarnLog.length === 0) {
    earned.innerHTML = '<div class="evo-earn" style="color:var(--phos-dim)">Nothing yet this session.</div>';
  }
  for (const e of dnaEarnLog.slice(0, 14)) {
    const d = document.createElement('div');
    d.className = 'evo-earn';
    d.innerHTML = '<b></b><span></span>';
    d.querySelector('b')!.textContent = `+${e.n}`;
    d.querySelector('span')!.textContent = e.why;
    earned.appendChild(d);
  }
  const dex = document.getElementById('evo-dex')!;
  dex.innerHTML = '';
  for (const f of [...gameState.speciesForms].reverse()) {
    const row = document.createElement('div');
    row.className = 'evo-dex-row';
    row.appendChild(creatureCanvas(f.genome, 34));
    const txt = document.createElement('div');
    txt.innerHTML = '<div class="d-num"></div><div class="d-name"></div><div class="d-muts"></div>';
    txt.querySelector('.d-num')!.textContent = `FORM ${roman(f.form)}`;
    txt.querySelector('.d-name')!.textContent = f.name;
    txt.querySelector('.d-muts')!.textContent = f.mutations.length
      ? f.mutations.map(m => MUTATION_BY_ID[m]?.label ?? m).join(' · ') : 'founding organism';
    row.appendChild(txt);
    dex.appendChild(row);
  }
}

/** Press EVOLVE: apply the queue on the engine, then play the sequence. */
function evolveNow(): void {
  const r = engine?.evolveSignature();
  if (!r) return;
  gameState.mutationGifts = [];
  playEvolutionSequence(r.before, r.after, r.form, r.diff);
  addFeedEntry(`${r.before.name} evolved into ${r.after.name} (Form ${roman(r.form)})`, 'milestone');
  addCodexEntry(`Form ${roman(r.form)}: ${r.after.name}`, 'biology');
  // The planet's creatures are drawn from the same genomes.
  if (_dioramaRenderer) {
    _dioramaRenderer.setLiveData(gameState.playerSpecies, gameState.playerBiosphere);
    _dioramaRenderer.markSurfaceDirty();
  }
  refreshEvolutionUI();
}

/**
 * The evolution moment: the old form turns to a white silhouette, old and new
 * silhouettes trade places faster and faster, a flash, and the new form is
 * revealed with what changed.
 */
function playEvolutionSequence(before: SpeciesGenome, after: SpeciesGenome, form: number, diff: string[]): void {
  const box = document.getElementById('evo-seq');
  const cv = document.getElementById('evo-seq-canvas') as HTMLCanvasElement | null;
  const text = document.getElementById('evo-seq-text');
  const diffEl = document.getElementById('evo-seq-diff');
  const cont = document.getElementById('evo-seq-continue') as HTMLButtonElement | null;
  if (!box || !cv || !text || !diffEl || !cont) return;
  const g = cv.getContext('2d');
  if (!g) return;
  box.classList.remove('hidden');
  cont.style.visibility = 'hidden';
  diffEl.textContent = '';
  text.textContent = `What? ${before.name} is evolving!`;
  AudioManager.playSfx('revelation');

  const W = cv.width, H = cv.height;
  const A = creatureCanvas(before, 190), B = creatureCanvas(after, 190);
  const silhouette = (src: HTMLCanvasElement): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d')!;
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    return c;
  };
  const sA = silhouette(A), sB = silhouette(B);
  const draw = (img: HTMLCanvasElement, alpha = 1) => {
    g.globalAlpha = alpha;
    g.drawImage(img, Math.round((W - img.width) / 2), Math.round((H - img.height) / 2));
    g.globalAlpha = 1;
  };
  const t0 = performance.now();
  const INTRO = 900, SWAP = 3200, FLASH = 450;
  let done = false;
  const frame = (now: number) => {
    if (done) return;
    const t = now - t0;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, W, H);
    // A ring of light that tightens as the change builds.
    const build = Math.min(1, Math.max(0, (t - INTRO) / SWAP));
    for (let i = 0; i < 3; i++) {
      const r = (1 - ((t / 900 + i / 3) % 1)) * 160 * (1 - build * 0.5) + 30;
      g.strokeStyle = `rgba(125,255,180,${0.08 + build * 0.25})`;
      g.lineWidth = 2;
      g.beginPath(); g.arc(W / 2, H / 2, r, 0, Math.PI * 2); g.stroke();
    }
    if (t < INTRO) {
      draw(A);
      draw(sA, t / INTRO * 0.85);
    } else if (t < INTRO + SWAP) {
      // Alternate, the period shrinking from ~420 ms to ~45 ms.
      const u = (t - INTRO) / SWAP;
      const period = 420 * Math.pow(1 - u, 1.6) + 45;
      const which = Math.floor((t - INTRO) / period) % 2;
      draw(which ? sB : sA);
    } else if (t < INTRO + SWAP + FLASH) {
      const u = (t - INTRO - SWAP) / FLASH;
      draw(sB);
      g.fillStyle = `rgba(255,255,255,${1 - Math.abs(u * 2 - 1)})`;
      g.fillRect(0, 0, W, H);
    } else {
      const u = Math.min(1, (t - INTRO - SWAP - FLASH) / 600);
      draw(B);
      draw(sB, 1 - u);
      // Sparkles.
      for (let i = 0; i < 10; i++) {
        const a = i * 0.628 + t / 700, r = 70 + 40 * Math.sin(t / 300 + i);
        g.fillStyle = `rgba(255,236,150,${0.6 * (1 - u * 0.5)})`;
        g.fillRect(Math.round(W / 2 + Math.cos(a) * r), Math.round(H / 2 + Math.sin(a) * r * 0.8), 3, 3);
      }
      if (cont.style.visibility === 'hidden') {
        text.textContent = `Congratulations! ${before.name} evolved into ${after.name}! (Form ${roman(form)})`;
        diffEl.textContent = diff.join('   ·   ');
        cont.style.visibility = 'visible';
        AudioManager.playSfx('discovery');
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  cont.onclick = () => { done = true; box.classList.add('hidden'); renderEvoLab(); };
}

function openEvoLab(): void {
  const overlay = document.getElementById('evo-lab-overlay');
  if (!overlay) return;
  overlay.classList.add('active');
  renderEvoLab();
}

function closeEvoLab(): void {
  document.getElementById('evo-lab-overlay')?.classList.remove('active');
}

function initEvoLab(): void {
  document.getElementById('evo-close-btn')?.addEventListener('click', closeEvoLab);
  document.getElementById('evo-lab-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEvoLab();
  });
  // The DNA panel's header opens the full lab.
  document.getElementById('dna-panel-title')?.addEventListener('click', openEvoLab);
  document.getElementById('evo-evolve-btn')?.addEventListener('click', evolveNow);
  document.getElementById('el-open-lab-btn')?.addEventListener('click', openEvoLab);
  document.getElementById('dna-display')?.addEventListener('click', openEvoLab);
}

// ═════════════════════════════════════════════════════════════════════════════
// CODEX — SPECIES, FLORA AND EVOLUTION RECORDS (M22i)
//
// The Codex held only milestone entries: a handful of one-off "First Fire"
// notes. Everything the player had actually grown — every lineage, living or
// extinct, and everything it was made of — existed in `gameState.playerSpecies`
// and was never readable anywhere.
//
// Species records are GENERATED from live state rather than stored, so they stay
// true as lineages mutate, spread and die out. Milestone entries stay stored,
// because they are historical events rather than descriptions of a thing.
// ═════════════════════════════════════════════════════════════════════════════

/** A row in the codex list: either a stored milestone or a live species record. */
interface CodexRecord {
  id: string;
  tick: number;
  title: string;
  subtitle: string;
  category: string;
  /** Free text searched by the search box, in addition to the title. */
  haystack: string;
  /** Set for generated species records. */
  species?: SpeciesGenome;
  /** Set for stored milestone entries. */
  entry?: CodexEntry;
  /** Set for generated civilisation records. */
  civ?: Civilization;
}

/** Is this lineage vegetation rather than an animal? */
function isFlora(sp: SpeciesGenome): boolean {
  return sp.dna.diet === 'producer'
      || sp.dna.metabolism === 'photosynthetic'
      || sp.dna.locomotion === 'stationary';
}

/** Everything the codex can show, milestones and living things together. */
function codexRecords(): CodexRecord[] {
  const out: CodexRecord[] = [];

  for (const e of gameState.codexEntries) {
    out.push({
      id: e.id, tick: e.tick, title: e.title,
      subtitle: `Year ${(e.tick * 10).toLocaleString()}`,
      category: e.category,
      haystack: `${e.title} ${e.body} ${e.category}`.toLowerCase(),
      entry: e,
    });
  }

  for (const sp of gameState.playerSpecies) {
    const flora = isFlora(sp);
    out.push({
      id: `sp_${sp.id}`,
      tick: sp.originTick,
      title: sp.name,
      subtitle: sp.isExtinct
        ? `Extinct · arose year ${(sp.originTick * 10).toLocaleString()}`
        : `${(sp.population * 100).toFixed(0)}% dominance`,
      category: flora ? 'flora' : 'species',
      haystack: [
        sp.name, sp.dna.metabolism, sp.dna.locomotion, sp.dna.environment,
        sp.dna.diet, sp.dna.respiration, sp.dna.reproduction,
        sp.physicalTraits.size, sp.physicalTraits.bodyStructure,
        sp.physicalTraits.mobilityType, sp.physicalTraits.sensorySystem,
        sp.habitat.biome, sp.habitat.temperatureRange,
        sp.isExtinct ? 'extinct' : 'living',
      ].join(' ').toLowerCase(),
      species: sp,
    });
  }

  for (const civ of Object.values(gameState.civilizations)) {
    out.push({
      id: `civ_${civ.starId}`,
      tick: civ.generatedAtTick,
      title: `${civ.name} ${civ.epithet}`,
      subtitle: `${civ.government} · ${civ.ideology}`,
      category: 'civilisation',
      haystack: [civ.name, civ.epithet, civ.government, civ.ideology,
                 civ.architecture.style, civ.architecture.material,
                 civ.architecture.settlementForm, civ.selfDescription,
                 civ.foundingMyth].join(' ').toLowerCase(),
      civ,
    });
  }

  return out;
}

/** Detail page for one lineage. */
function renderSpeciesDetail(sp: SpeciesGenome): void {
  const detailEl = document.getElementById('codex-entry-detail');
  if (!detailEl) return;

  const range = speciesRange(sp.id);
  const ancestor = sp.ancestorId
    ? gameState.playerSpecies.find(s => s.id === sp.ancestorId)
    : null;
  const descendants = gameState.playerSpecies.filter(s => s.ancestorId === sp.id);

  const row = (k: string, v: string) =>
    `<div class="cx-row"><span>${k}</span><b>${v}</b></div>`;

  const traits = [
    ['Metabolism',   sp.dna.metabolism],
    ['Respiration',  sp.dna.respiration],
    ['Locomotion',   `${sp.dna.locomotion} (${sp.physicalTraits.mobilityType})`],
    ['Environment',  sp.dna.environment.replace(/_/g, ' ')],
    ['Diet',         sp.dna.diet],
    ['Reproduction', sp.dna.reproduction],
    ['Size',         sp.physicalTraits.size],
    ['Body plan',    sp.physicalTraits.bodyStructure],
    ['Senses',       sp.physicalTraits.sensorySystem],
    ['Habitat',      `${sp.habitat.biome.replace(/_/g, ' ')}, ${sp.habitat.temperatureRange.replace(/_/g, ' ')}`],
  ].map(([k, v]) => row(k, String(v))).join('');

  const mind = [
    ['Intelligence', `${sp.dna.intelligence}/10`],
    ['Social',       `${sp.dna.social}/10`],
    ['Aggression',   `${sp.dna.aggression}/10`],
    ['Adaptability', `${sp.dna.adaptability}/10`],
  ].map(([k, v]) => row(k, String(v))).join('');

  const lineage = [
    row('Arose', `Year ${(sp.originTick * 10).toLocaleString()}`),
    row('Status', sp.isExtinct ? 'Extinct' : 'Living'),
    row('Range', `${range.cells.toLocaleString()} regions`),
    ancestor ? row('Descended from', ancestor.name) : '',
    descendants.length ? row('Gave rise to', descendants.map(d => d.name).join(', ')) : '',
  ].join('');

  detailEl.innerHTML = `
    <div class="codex-detail-title">${sp.name}</div>
    <div class="codex-detail-meta">${isFlora(sp) ? 'Flora' : 'Species'}${sp.isExtinct ? ' · extinct' : ''}</div>
    <div class="cx-portrait" id="cx-portrait"></div>
    <div class="cx-sec">Anatomy</div>${traits}
    <div class="cx-sec">Disposition</div>${mind}
    <div class="cx-sec">Lineage</div>${lineage}
  `;

  // The portrait is the same baked sprite the world draws, so the record shows
  // the actual creature rather than an illustration of one.
  const port = document.getElementById('cx-portrait');
  if (port) port.appendChild(bakeCreatureSprite(sp, 8));
}

/**
 * Detail page for one civilisation's culture.
 *
 * `selfDescription`, `foundingMyth`, `epithet` and the architecture strings can
 * all be LLM output (`civ.origin === 'llm'`). The skeleton below is built with
 * innerHTML because every string in it is one we wrote; every value that could
 * have come from a model is then assigned with textContent, never concatenated
 * into markup — see the project's HTML-injection rule.
 */
function renderCivDetail(civ: Civilization): void {
  const detailEl = document.getElementById('codex-entry-detail');
  if (!detailEl) return;

  const row = (label: string, valueId: string) =>
    `<div class="cx-row"><span>${label}</span><b id="${valueId}"></b></div>`;

  detailEl.innerHTML = `
    <div class="codex-detail-title" id="cx-civ-title"></div>
    <div class="codex-detail-meta" id="cx-civ-meta"></div>
    <div class="cx-sec">Governance</div>
    ${row('Government', 'cx-civ-gov')}
    ${row('Ideology', 'cx-civ-ideology')}
    <div class="cx-sec">Values</div>
    <div id="cx-civ-values"></div>
    <div class="cx-sec">Architecture</div>
    ${row('Style', 'cx-civ-style')}
    ${row('Material', 'cx-civ-material')}
    ${row('Settlement', 'cx-civ-settlement')}
    <div class="cx-sec">Self-Description</div>
    <div class="codex-detail-body" id="cx-civ-desc"></div>
    <div class="cx-sec">Founding Myth</div>
    <div class="codex-detail-body" id="cx-civ-myth"></div>
    <div class="cx-sec">Origins</div>
    ${row('Evolved from', 'cx-civ-species')}
    ${row('First recorded', 'cx-civ-tick')}
    <div class="pi-note" id="cx-civ-origin" style="opacity:0.6"></div>
  `;

  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  // `civ.name` is always assigned by us (see Civilization.ts / CultureGenerator's
  // `{...base, ...}` merge), but `civ.epithet` is not — a Gemini result can
  // replace it. Both go through textContent regardless.
  set('cx-civ-title', `${civ.name} ${civ.epithet}`);
  set('cx-civ-meta', `Civilisation · ${civ.origin === 'llm' ? 'AI-written culture' : 'Procedurally derived culture'}`);
  set('cx-civ-gov', civ.government);
  set('cx-civ-ideology', civ.ideology);
  set('cx-civ-style', civ.architecture.style);
  set('cx-civ-material', civ.architecture.material);
  set('cx-civ-settlement', civ.architecture.settlementForm);
  set('cx-civ-desc', civ.selfDescription);
  set('cx-civ-myth', civ.foundingMyth);
  set('cx-civ-species', civ.sourceGenome.speciesName);
  set('cx-civ-tick', `Year ${(civ.generatedAtTick * 10).toLocaleString()}`);
  // A player must be able to tell a Gemini-written culture from a procedurally
  // derived one at a glance, honestly — not just infer it from prose quality.
  set('cx-civ-origin', civ.origin === 'llm'
    ? 'This culture was written by the AI God, grounded in the species’ evolved biology.'
    : 'This culture was derived procedurally from the species’ evolved biology — no AI God narration was involved.');

  const wrap = document.getElementById('cx-civ-values');
  if (wrap) {
    const rows: Array<[string, number]> = [
      ['Militarism', civ.values.militarism],
      ['Piety', civ.values.piety],
      ['Curiosity', civ.values.curiosity],
      ['Collectivism', civ.values.collectivism],
      ['Xenophobia', civ.values.xenophobia],
    ];
    for (const [label, v] of rows) {
      const barRow = document.createElement('div');
      barRow.className = 'pi-culture-bar-row';
      barRow.innerHTML = `<span></span><div class="pi-culture-track"><div class="pi-culture-fill"></div></div>`;
      barRow.querySelector('span')!.textContent = label;
      (barRow.querySelector('.pi-culture-fill') as HTMLElement).style.width =
        `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
      wrap.appendChild(barRow);
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// ZOOM TIERS (M22a)
//
// Universe → Galaxy → Solar System → Planet as one continuum. Scrolling moves
// through the tiers and the buttons jump between them; both update the same
// indicator, so however the player got there the UI agrees about where they are.
// ═════════════════════════════════════════════════════════════════════════════

let _lastZoomTier: ZoomTier | null = null;

function initZoomTiers(): void {
  initUniverseMap({
    engine: () => engine,
    setOverlay: (m) => _pixiRenderer?.setMapOverlay(m),
    blocked: () => document.body.classList.contains('cinematic') || (gameState.forge?.phase === 'draft' && !forgeAwaitingDescent()) || planetViewOpen(),
  });
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.zt-btn')) {
    btn.addEventListener('click', () => {
      const tier = btn.dataset['tier'] as ZoomTier | undefined;
      if (!tier || !engine) return;
      AudioManager.playSfx('ui_click');
      // The Forge's draft needs the world in view: the scale is held until
      // the forging is complete.
      if (gameState.forge?.phase === 'draft' && !forgeAwaitingDescent()) return;
      // The planet tier is not a camera position — it is the surface view. Zoom
      // to the system first so closing it lands somewhere sensible.
      if (tier === 'planet') {
        engine.setZoomTier('system');
        openPlanetView();
        return;
      }
      // The surface view sits over the map: leave it, or the new scale is
      // set behind it and the button seems to do nothing.
      if (planetViewOpen()) closePlanetView();
      engine.setZoomTier(tier);
    });
  }
  syncZoomTierUI();
}

/**
 * Keep the indicator honest.
 *
 * Called on a timer rather than only from the button handlers, because the tier
 * changes whenever the player scrolls — the buttons are one way in, not the
 * only one.
 */
function syncZoomTierUI(): void {
  const tier = engine?.zoomTier ?? null;
  const shown: ZoomTier | null = planetViewOpen() ? 'planet' : tier;
  document.getElementById('zoom-tiers')?.classList.toggle('zt-held', gameState.forge?.phase === 'draft');

  if (shown !== _lastZoomTier) {
    _lastZoomTier = shown;
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.zt-btn')) {
      btn.classList.toggle('active', btn.dataset['tier'] === shown);
    }
  }
  window.setTimeout(syncZoomTierUI, 250);
}


/**
 * Details card for a planet or moon clicked in the system view, with a way
 * into the world. One card at a time; closes on its button, Escape, or the
 * next click elsewhere.
 */
function showBodyCard(star: StarBody, planetIndex: number, moonIndex: number | null, sx: number, sy: number): void {
  document.getElementById('body-card')?.remove();
  const planet = star.planets[planetIndex];
  if (!planet) return;
  const moon = moonIndex != null ? planet.moons[moonIndex] : null;
  const isHome = star.isPlayerStar && (engine?.homeWorld(star) ?? null) === planet;
  // A world can be visited once a satellite has studied it, or it is settled.
  const studied = planet.discovery === 'probe' || planet.discovery === 'landing';
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const planetName = isHome ? (gameState.playerPlanetName || planet.name) : `${star.civName} ${planet.name}`;
  const rows: Array<[string, string]> = [];
  let title: string, subtitle: string;
  if (moon) {
    title = moon.name || 'Moon';
    subtitle = `Moon of ${planetName}`;
    rows.push(['Type', cap(String(moon.kind))]);
    rows.push(['Size', moonSizeLabel(moonSizeClass(moon, planet))]);
    rows.push(['Habitability', `${Math.round(moon.habitability * 100)}%`]);
    rows.push(['Status', moon.colonised ? 'Colonised' : 'Untouched']);
  } else {
    title = planetName;
    subtitle = isHome ? 'Your home world' : star.isDead ? 'Remnant system' : `${star.civName} system`;
    rows.push(['Type', cap(String(planet.type))]);
    rows.push(['Life', planet.isDead ? 'Dead world' : planet.hasLife ? (isHome ? cap(String(star.biologyPhase ?? 'present')) : 'Present') : 'None detected']);
    if (isHome && engine?.isHomeForming() && star.formationStage) rows.push(['Forming', cap(String(star.formationStage).replace(/_/g, ' '))]);
    if (isHome && star.civLevel > 0) rows.push(['Civilisation', eraName(star)]);
    rows.push(['Moons', String(planet.moons.length)]);
    rows.push(['Survey', planet.discovery === 'landing' ? 'Settled' : planet.discovery === 'probe' ? 'Studied by satellite' : planet.discovery === 'telescope' ? 'Telescope only' : 'Unknown']);
  }
  const card = document.createElement('div');
  card.id = 'body-card';
  card.style.cssText = 'position:fixed;z-index:60;min-width:200px;max-width:260px;padding:12px 14px;'
    + 'background:rgba(8,6,20,.94);border:1px solid #c8a96e;color:#d8d0e8;font:12px/1.5 monospace;'
    + 'box-shadow:0 0 18px rgba(200,169,110,.25);';
  card.innerHTML = '<div class="body-card-art" style="display:flex;justify-content:center;margin:-2px 0 8px"></div>'
    + `<div style="color:#c8a96e;font-size:13px;letter-spacing:.08em">${title.toUpperCase()}</div>`
    + `<div style="color:#8a80a0;margin-bottom:8px">${subtitle}</div>`
    + rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8a80a0">${k}</span><span>${v}</span></div>`).join('')
    + '<div style="display:flex;gap:8px;margin-top:10px"></div>';
  const bar = card.lastElementChild as HTMLElement;
  const button = (label: string, primary: boolean, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `flex:1;padding:5px 8px;font:11px monospace;letter-spacing:.06em;cursor:pointer;border:1px solid ${primary ? '#c8a96e' : '#443355'};`
      + `background:${primary ? 'rgba(200,169,110,.15)' : 'transparent'};color:${primary ? '#e8d4a0' : '#8a80a0'};`;
    b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    bar.appendChild(b);
  };
  const close = () => { card.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
  const canView = !moon && !planet.isDead && (isHome || studied);
  if (canView) button(isHome ? 'ENTER WORLD' : 'VIEW WORLD', true, () => { close(); void openPlanetView(star, planetIndex); });
  else if (!moon && !planet.isDead) {
    const note = document.createElement('div');
    note.textContent = 'Send a satellite to study this world before you can view it.';
    note.style.cssText = 'flex:2;color:#8a80a0;font-size:10px;line-height:1.3;align-self:center';
    bar.appendChild(note);
  }
  button('CLOSE', !canView, close);
  // The body itself: the system view's own globe (or MoonArt moon), x3.
  const art = card.querySelector<HTMLElement>('.body-card-art');
  if (art) {
    let src: HTMLCanvasElement | null = null;
    try {
      if (moon) {
        const c = moon.color.replace('#', ''), n = parseInt(c.length === 3 ? c.split('').map(ch => ch + ch).join('') : c, 16);
        const f = paintMoon({ kind: moon.kind as MoonKindArt, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], size: 28,
          seed: (planet.genomeSeed ?? 1) * 31 + (moonIndex ?? 0) * 977, lx: 0.8, ly: -0.4, colonised: moon.colonised, irregular: moonIsIrregular(moon, planet) });
        src = document.createElement('canvas'); src.width = f.width; src.height = f.height;
        const g = src.getContext('2d'); if (g) { const img = g.createImageData(f.width, f.height); img.data.set(f.data); g.putImageData(img, 0, 0); }
      } else if (!planet.isDead) {
        const dna = isHome ? (gameState.playerPlanetDNA ?? planet.dna ?? DEFAULT_PLANET_DNA) : (planet.dna ?? DEFAULT_PLANET_DNA);
        const eq = bakePlanetTexture(star.id, planetIndex, isHome && star.formationDestiny && star.formationStage ? 'lava' : planet.type, dna, 96, isHome && planet.hasLife ? (star.biologyPhase ?? null) : null,
          isHome ? runtimeState.playerPlanetGrid : null);
        src = wrapEquirectToGlobe(eq, 48, { rings: planet.type === 'gas', seed: star.id * 17 + planetIndex * 31 });
      }
    } catch { src = null; }
    if (src) {
      const cv = document.createElement('canvas');
      cv.width = src.width * 3; cv.height = src.height * 3;
      cv.style.cssText = 'image-rendering:pixelated;width:' + Math.min(144, src.width * 3) + 'px;filter:drop-shadow(0 0 10px rgba(200,169,110,.25))';
      const g = cv.getContext('2d');
      if (g) { g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, cv.width, cv.height); }
      art.appendChild(cv);
    }
  }
  document.body.appendChild(card);
  // Beside the click, kept on screen.
  const r = card.getBoundingClientRect();
  card.style.left = `${Math.min(window.innerWidth - r.width - 8, sx + 14)}px`;
  card.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, sy - r.height / 2))}px`;
  document.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('mousedown', (ev) => { if (!card.contains(ev.target as Node)) close(); }, { once: true }), 0);
}


/**
 * The engine side of the Faith Cards (FaithCards.DivineHost): the home
 * surface for works on land and life, and the heavens — sight, meteors,
 * seeding life, terraforming, stirring evolution — through the engine.
 */
function faithHost(): DivineHost | null {
  if (!engine) return null;
  const eng = engine;
  const ps = eng.getPlayerStar();
  const planet = ps?.planets.find(p => p.discovery === 'landing' || p.hasLife);
  return {
    grid: runtimeState.playerPlanetGrid,
    planetType: planet?.type ?? 'rocky',
    species: gameState.playerSpecies,
    canCosmic: (w) => {
      const star = eng.getPlayerStar();
      if (!star) return false;
      if (w === 'meteor') return !!eng.getMeteorTarget();
      if (w === 'terraform') { const tf = eng.getTerraformInfo(); return !!tf && tf.options.length > 0 && !star.terraformStage; }
      if (w === 'mutate') return star.hasLife;
      if (w === 'seed') return !star.formationDestiny;
      return true;
    },
    cosmic: (w, rng, mag) => {
      const star = eng.getPlayerStar();
      if (!star) return null;
      switch (w) {
        case 'sight': {
          const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
          const seen: string[] = [];
          for (let i = 0; i < mag; i++) {
            const angle = rng.next() * Math.PI * 2;
            eng.spendDPToExplore(angle);
            seen.push(dirs[Math.floor((angle / (Math.PI * 2)) * 8) % 8]);
          }
          return `Your sight opens to the ${[...new Set(seen)].join(', ')}.`;
        }
        case 'meteor': {
          const t = eng.getMeteorTarget();
          if (!t) return null;
          eng.sendMeteor();
          return `A seed-stone falls toward ${t.civName}.`;
        }
        case 'seed':
          for (let i = 0; i < mag; i++) eng.blessHarvest();
          return `Life swells across ${gameState.playerPlanetName}.`;
        case 'terraform': {
          const tf = eng.getTerraformInfo();
          if (!tf?.options.length) return null;
          const opt = tf.options[Math.floor(rng.next() * tf.options.length)];
          if (!eng.startTerraform(opt.targetType)) return null;
          addCodexEntry(`Terraforming of ${gameState.playerPlanetName}`, 'divine');
          return `The crust of ${gameState.playerPlanetName} cracks open: it is becoming a ${opt.targetType} world.`;
        }
        case 'mutate': {
          let said = '';
          for (let i = 0; i < mag; i++) {
            const r = eng.nudgePlayerEvolution();
            if (r.mutationDesc) said = r.mutationDesc;
            if (r.outcome === 'dna') updateDNAPanel();
          }
          return said || `Something shifts in the blood of ${gameState.playerSpeciesName || 'your world\'s life'}.`;
        }
      }
    },
    surfaceChanged: () => {
      _dioramaRenderer?.setLiveData(gameState.playerSpecies, gameState.playerBiosphere);
      _dioramaRenderer?.markSurfaceDirty(true);
    },
  };
}

/**
 * Faith deck: folded into a stack until the top card is clicked; the label
 * toggles; a click elsewhere folds it again. While folded, the click that
 * unfolds never fires a card.
 */
function setupFaithDeckFold(): void {
  const deck = document.querySelector<HTMLElement>('.faith-deck');
  const panel = document.getElementById('faith-panel');
  const label = deck?.querySelector<HTMLElement>('.faith-deck-label');
  if (!deck || !panel || !label) return;
  const mark = label.querySelector<HTMLElement>('.fold-mark');
  const set = (folded: boolean) => {
    deck.classList.toggle('folded', folded);
    if (mark) mark.textContent = folded ? '▸' : '▾';
  };
  panel.addEventListener('click', (e) => {
    if (!deck.classList.contains('folded')) return;
    e.stopPropagation(); e.preventDefault();
    set(false);
  }, true);
  label.addEventListener('click', () => set(!deck.classList.contains('folded')));
  // A long hand runs past the screen: the wheel scrolls the row sideways.
  panel.addEventListener('wheel', (e) => {
    if (deck.classList.contains('folded') || panel.scrollWidth <= panel.clientWidth) return;
    panel.scrollLeft += e.deltaY + e.deltaX;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('mousedown', (e) => {
    // The Faith Card modals (seek, crucible) belong to the deck.
    if (!deck.classList.contains('folded') && !deck.contains(e.target as Node)
      && !(e.target as Element | null)?.closest?.('#faith-modal')) set(true);
  });
}
setupFaithDeckFold();
initFaithHand({
  chat: (text, kind) => addChatMessage(text, kind),
  dpChanged: () => {
    updateDivineActions();
    setResourceChip('dp-display', 'dp-display-val', gameState.divinePoints);
  },
  tick: () => engine?.tick ?? 0,
  effect: (kind, cell) => _dioramaRenderer?.playDivineEffect(kind, cell),
  host: faithHost,
  context: () => {
    const ps = engine?.getPlayerStar();
    const tf = engine?.getTerraformInfo();
    return {
      nations: !!runtimeState.playerNations?.isFounded && runtimeState.playerNations.nations.some(n => !n.fallen),
      life: !!ps?.hasLife,
      grid: !!runtimeState.playerPlanetGrid,
      intelligent: ps?.biologyPhase === 'intelligent',
      lifeless: !!engine?.getMeteorTarget(),
      terraform: !!tf && tf.options.length > 0 && !ps?.terraformStage,
    };
  },
});
