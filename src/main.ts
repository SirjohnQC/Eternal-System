import { BigBangEngine, StarBody, Planet, EngineSnapshot, type ZoomTier } from './simulation/BigBangEngine';
import { PlanetRenderer } from './simulation/PlanetRenderer';
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
import { PixiBigBangRenderer } from './rendering/PixiBigBangRenderer';
import { IsoDioramaRenderer, type DivineEffectKind } from './rendering/IsoDioramaRenderer';
import {
  generatePlanetGrid, classifyBiome, isWater, isHabitable,
  SEA_LEVEL, GRID_SIZE, BIOME_COLORS,
  type BiomeType, type GridCell,
} from './simulation/PlanetGrid';
import { ARCHETYPES } from './simulation/LifeSystem';
import type { SpeciesGenome } from './simulation/SpeciesGenome';
import { speciesRGB, clearSpeciesPalette } from './ui/speciesPalette';
import {
  generateBranchSet, emptyInvestment, branchesFromIds, dnaPointCost, type BranchDef,
} from './simulation/DnaBranches';
import { assignDominantSpecies } from './simulation/SpeciesDistribution';
import { initPlayerSpecies, stepEvolution } from './simulation/EvolutionEngine';
import { clearSpriteCaches, bakeCreatureSprite } from './rendering/SpeciesSprite';
import { runtimeState } from './simulation/GameState';
import { DP_CAP, DP_REGEN_BASE, DP_DEVOTION_THRESHOLD_MID, DP_DEVOTION_THRESHOLD_HIGH } from './constants';

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

function initRollingScreen(): void {
  const container = document.getElementById('stat-cards')!;
  container.innerHTML = '';
  currentStatIndex = 0;
  godDivineRoll = 10;
  godRollTriggered = false;
  delete answeredQuestions.climate;
  delete answeredQuestions.oceans;
  delete answeredQuestions.chaos;

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

function highlightCard(key: keyof UniverseStats): void {
  STAT_KEYS.forEach(k => {
    document.getElementById(`stat-card-${k}`)?.classList.toggle('active', k === key);
  });
}

function showRollButton(): void {
  const btn = document.getElementById('roll-btn') as HTMLButtonElement;
  const genBtn = document.getElementById('genesis-btn') as HTMLButtonElement;
  const hintEl = document.getElementById('roll-hint');

  if (currentStatIndex < STAT_KEYS.length) {
    btn.textContent = `⬡ ROLL: ${STAT_LABELS[STAT_KEYS[currentStatIndex]]}`;
    btn.style.display = '';
    genBtn.style.display = 'none';
  } else {
    // All player stats locked — God rolls next, then naming
    btn.style.display = 'none';
    genBtn.style.display = 'none';
    if (hintEl) hintEl.textContent = 'The God now claims its share of fate…';
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
      // Reveal planet questions, then check genesis readiness
      setTimeout(() => {
        const pqSection = document.getElementById('planet-questions-section');
        if (pqSection) pqSection.style.display = 'flex';
        checkGenesisReady();
      }, 700);
    }
  }, 55);
}

function checkGenesisReady(): void {
  const hintEl = document.getElementById('roll-hint');
  const planet = (document.getElementById('planet-name-input') as HTMLInputElement | null)?.value.trim() ?? '';
  const genBtn = document.getElementById('genesis-btn') as HTMLButtonElement | null;
  if (!genBtn) return;
  if (!godRollTriggered) return;

  const allQuestionsAnswered = !!(answeredQuestions.climate && answeredQuestions.oceans && answeredQuestions.chaos);

  if (planet && allQuestionsAnswered) {
    genBtn.style.display = '';
    if (hintEl) hintEl.textContent = 'Your universe awaits. Speak the word.';
  } else {
    genBtn.style.display = 'none';
    if (!planet) {
      if (hintEl) hintEl.textContent = 'Name your home planet to begin genesis.';
    } else {
      if (hintEl) hintEl.textContent = 'Define your world above to continue.';
    }
  }
}

function rollCurrentStat(): void {
  if (currentStatIndex >= STAT_KEYS.length) return;
  const key = STAT_KEYS[currentStatIndex];

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
function launchBigBang(): void {
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

  const canvas = document.getElementById('bigbang-canvas') as HTMLCanvasElement;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  runtimeState.playerPlanetGrid = null; // reset on new game
  engine = new BigBangEngine(canvas);
  engine.init(stats, seed);

  wireEngineEvents(engine);
  void attachPixiRenderer(engine, canvas);
  engine.start();

  // Initial god greeting
  setTimeout(() => {
    addChatMessage(fallbackNarrator!.generateGodGreeting(godName), 'god');
    if (!geminiKey) {
      addChatMessage('[ Offline mode — procedural AI active. Add VITE_GEMINI_API_KEY for full Gemini integration. ]', 'system');
    }
  }, 1800);
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
    const el = document.getElementById('dna-display');
    if (el) { el.textContent = `🧬 ${total} DNA`; el.style.display = ''; }
  };
  eng.onTechPointEarned = (total) => {
    const el = document.getElementById('tech-display');
    if (el) { el.textContent = `⚙ ${total} TP`; el.style.display = ''; }
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
      const home = ps.planets.find(p => p.hasLife) ?? ps.planets[0];
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
    const homePlanet = ps?.planets.find(p => p.hasLife) ?? ps?.planets[0];
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
    const el = document.getElementById('civ-bar');
    if (el) el.textContent = label;
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
    // the player is watching it. The renderer throttles the actual rebake.
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
    gameState.divinePoints = Math.min(DP_CAP, gameState.divinePoints + dpGain);
    updateDivineActions();
    const dpEl = document.getElementById('dp-display');
    if (dpEl) dpEl.textContent = `✦ ${gameState.divinePoints} DP`;
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
  eng.onStarSelected = (star) => {
    openSystemPanel(star);
  };
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
}

function enterUniverse(): void {
  if (!engine) return;
  engine.stop();
  showScreen('game');

  const gameCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  gameCanvas.width = window.innerWidth;
  gameCanvas.height = window.innerHeight;

  const newEngine = new BigBangEngine(gameCanvas);
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

  engine = newEngine;
  wireEngineEvents(engine);
  void attachPixiRenderer(engine, gameCanvas);
  engine.start();
  engine.focusPlayerStar();
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
    runtimeState.playerPlanetGrid = generatePlanetGrid(
      planet?.type ?? 'rocky',
      gridSeed,
      gameState.playerPlanetDNA,
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
  setText('pi-tile-biome', BIOME_LABELS[cell.biome] ?? cell.biome);

  // Shown relative to sea level, which is what the player can actually see.
  const rel = cell.elevation - SEA_LEVEL;
  setText('pi-tile-elev', isWater(cell.biome)
    ? Math.round(-rel * 8000) + ' m below sea level'
    : Math.round(rel * 8000) + ' m above sea level');

  const tempC = Math.round(cell.temperature * 60 - 25);   // 0–1 → −25…35 °C
  setText('pi-tile-climate', tempC + '°C · ' + Math.round(cell.moisture * 100) + '% humidity');
  setText('pi-tile-fert', isHabitable(cell.biome)
    ? Math.round(cell.fertility * 100) + '%' : 'Barren');
  setText('pi-tile-life', cell.lifeDensity > 0.01
    ? Math.round(cell.lifeDensity * 100) + '% coverage' : 'None');
  setText('pi-tile-civ', cell.civId != null
    ? (gameState.playerSpeciesName || engine?.getPlayerStar()?.civName || 'Settled')
    : 'Uninhabited');

  const occupant = cell.dominantSpeciesId
    ? gameState.playerSpecies.find(sp => sp.id === cell.dominantSpeciesId)
    : null;
  setText('pi-tile-species', occupant ? occupant.name : '—');
  setText('pi-tile-species-detail', occupant
    ? `${occupant.physicalTraits.size} · ${occupant.dna.locomotion} · ${occupant.dna.diet}`
    : '');

  buildTileActionButtons(cell, target);
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

function buildPlanetInfoPanel(star: StarBody, planetIndex: number): void {
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
    setText('pi-era', CIV_PHASE_LABELS[civPhase] + ` — ${TECH_LEVELS[civLevel]}`);
    const biosphere = planet?.biosphere ?? 0;
    setText('pi-population', formatPop(calcPop(civLevel)));
    setText('pi-biosphere', Math.round(biosphere * 100) + '%');
    setStyle('pi-biosphere-bar', 'width', Math.round(biosphere * 100) + '%');
  } else {
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
    setText('pi-dna-climate', dna.climate);
    setText('pi-dna-oceans', dna.oceans.replace('_', ' '));
    setText('pi-dna-chaos', dna.chaos);
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
  if (iconEl) iconEl.textContent = star.hasLife ? SPECIES_ICONS[civLevel] : '—';
  setText('pi-species-name', speciesName);

  let speciesDesc = 'No life detected on this world.';
  if (star.formationStage) {
    speciesDesc = 'Planet still in formation. Life has not yet emerged.';
  } else if (star.hasLife && star.biologyPhase !== 'intelligent') {
    speciesDesc = `${BIO_PHASE_LABELS[star.biologyPhase]} · Evolving`;
    if (isPlayer) speciesDesc += ` · Invest DNA points to guide development`;
  } else if (star.hasLife) {
    speciesDesc = `Emerged on ${displayName} · ${TECH_LEVELS[civLevel]} era`;
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

  setText('pi-tech-level', star.hasLife ? TECH_LEVELS[civLevel] : 'N/A');
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
  const civInfo = star.hasLife ? (TECH_LEVELS[star.civLevel] ?? 'Unknown') : 'No intelligent life';
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

function closePlanetView(): void {
  document.getElementById('planet-overlay')!.style.display = 'none';
  planetRenderer?.stop();
  _dioramaRenderer?.pause();
  _dioramaRenderer?.setHighlight(null);
}

function updateHUDTick(tick: number): void {
  const vAge = tick * 10;
  const ageStr = vAge > 1e9 ? `${(vAge / 1e9).toFixed(1)}B` :
                 vAge > 1e6 ? `${(vAge / 1e6).toFixed(1)}M` :
                 vAge > 1e3 ? `${(vAge / 1e3).toFixed(0)}K` : String(vAge);

  const tickEl = document.getElementById('tick-display');
  if (tickEl) tickEl.textContent = `TICK: ${tick.toLocaleString()}  |  AGE: ${ageStr} YRS`;

  const dpEl = document.getElementById('dp-display');
  if (dpEl) dpEl.textContent = `✦ ${gameState.divinePoints} DP`;

  updateDivineActions();
}

function updateBottomBar(star: { civName: string; civLevel: number; hasLife: boolean }): void {
  const el1 = document.getElementById('planet-name-bar');
  const el2 = document.getElementById('species-bar');
  const el3 = document.getElementById('civ-bar');
  const planetLabel = gameState.playerPlanetName !== '—' ? gameState.playerPlanetName : star.civName + ' Prime';
  if (el1) el1.textContent = planetLabel;
  const speciesLabel = gameState.playerSpeciesName || (star.hasLife ? 'Life Detected' : 'No life');
  if (el2) el2.textContent = star.hasLife ? speciesLabel : 'No life';
  // Civ bar: show TECH_LEVELS only once intelligent
  const ps = engine?.getPlayerStar();
  const inBioPhase = ps && ps.biologyPhase !== 'intelligent';
  if (el3) el3.textContent = inBioPhase ? '—' : (star.hasLife ? TECH_LEVELS[star.civLevel] : '—');
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

  if (ps.biologyPhase !== 'intelligent') {
    phaseEl.textContent = BIO_PHASE_LABELS[ps.biologyPhase];
    phaseEl.style.color = '#44cc88';
    // Show DNA panel if there are points to spend
    if (gameState.dnaPoints > 0) {
      document.getElementById('dna-panel')?.classList.add('visible');
    }
    updateDNAPanel();
  } else {
    const phase = civLevelToPhase(ps.civLevel);
    phaseEl.textContent = CIV_PHASE_LABELS[phase];
    phaseEl.style.color = '';
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
  const dna = gameState.playerDNA;

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

  // Accumulation bar — shows unspent DNA points
  const accumCount = document.getElementById('el-accum-count');
  const accumFill  = document.getElementById('el-accum-fill');
  if (accumCount) accumCount.textContent = `${points} DNA pts`;
  if (accumFill) {
    // Bar shows progress toward next 10-point threshold within unspent pool
    const pct = Math.min(100, (points % 10) / 10 * 100) || (points > 0 ? 100 : 0);
    (accumFill as HTMLElement).style.width = pct + '%';
    accumFill.classList.toggle('full', points >= 10);
  }

  // Commit button — ready when ≥10 unspent points (one evolution step)
  const commitBtn = document.getElementById('el-commit-btn') as HTMLButtonElement | null;
  if (commitBtn) {
    const ready = points >= 10;
    commitBtn.disabled = !ready;
    commitBtn.classList.toggle('ready', ready);
    commitBtn.textContent = ready ? 'EVOLVE SPECIES ◈' : `Need ${10 - (points % 10 || 10)} more DNA`;
  }

  // Top-bar DNA display
  const dnaDisplay = document.getElementById('dna-display');
  if (dnaDisplay) { dnaDisplay.textContent = `🧬 ${points} DNA`; dnaDisplay.style.display = ''; }

  // Branch rows — build once, update values on subsequent calls
  const container = document.getElementById('dna-branch-rows');
  if (!container) return;

  const defs = currentBranchDefs();
  if (defs.length === 0) return;

  // Rebuild whenever the universe's branch set changes, not just once.
  const signature = defs.map(d => d.id).join(',');
  if (container.dataset['built'] !== signature) {
    container.dataset['built'] = signature;
    container.innerHTML = defs.map(def => {
      const key = def.id;
      const color = def.color;
      const val = dna[key] ?? 0;
      const cost = dnaPointCost(val, phIdx);
      return `<div class="el-branch-row" title="${def.blurb}">
        <div class="el-branch-icon" style="color:${color};background:${color}18">${def.glyph}</div>
        <span class="el-branch-name">${def.label}</span>
        <div class="el-branch-track">
          <div class="el-branch-fill" id="branch-fill-${key}"
            style="width:${val}%;background:linear-gradient(90deg,${color}88,${color})"></div>
        </div>
        <span class="el-branch-val" style="color:${color}" id="branch-val-${key}">${val}</span>
        <span class="el-branch-cost" id="branch-cost-${key}">${cost}</span>
        <div class="el-branch-btns">
          <button class="el-btn" id="branch-minus-${key}" ${val <= 0 ? 'disabled' : ''}>&#8722;</button>
          <button class="el-btn" id="branch-plus-${key}"  ${points < cost || val >= 100 ? 'disabled' : ''}>&#43;</button>
        </div>
      </div>`;
    }).join('');

    defs.map(d => d.id).forEach(key => {
      document.getElementById(`branch-plus-${key}`)?.addEventListener('click', () => {
        const prevVal = gameState.playerDNA[key] ?? 0;
        if (prevVal >= 100) return;
        // One thing at a time: the first point of a phase fixes the direction.
        if (gameState.dnaFocusBranch && gameState.dnaFocusBranch !== key) return;
        const cost = dnaPointCost(prevVal, currentPhaseIndex());
        if (gameState.dnaPoints < cost) return;

        gameState.dnaPoints -= cost;
        gameState.playerDNA[key] = prevVal + 1;
        gameState.dnaFocusBranch = key;
        const newVal = gameState.playerDNA[key];
        updateDNAPanel();
        // Trigger evolution modal every time a branch crosses a multiple of 10
        if (newVal % 10 === 0 && newVal > prevVal) {
          openTraitsModal();
        }
      });
      document.getElementById(`branch-minus-${key}`)?.addEventListener('click', () => {
        const cur = gameState.playerDNA[key] ?? 0;
        if (cur <= 0) return;
        // Refund exactly what that point cost, so undo cannot be used to farm
        // points by buying cheap at an early phase and selling back at a later.
        gameState.dnaPoints += dnaPointCost(cur - 1, currentPhaseIndex());
        gameState.playerDNA[key] = cur - 1;
        // Backing all the way out releases the commitment for this phase.
        if (gameState.playerDNA[key] === 0 && gameState.dnaFocusBranch === key) {
          gameState.dnaFocusBranch = null;
        }
        updateDNAPanel();
      });
    });
    return;
  }

  // Update existing rows
  const focus = gameState.dnaFocusBranch;
  defs.forEach(def => {
    const key = def.id;
    const val = dna[key] ?? 0;
    const color = def.color;
    const cost = dnaPointCost(val, phIdx);
    const valEl = document.getElementById(`branch-val-${key}`);
    const fillEl = document.getElementById(`branch-fill-${key}`);
    const costEl = document.getElementById(`branch-cost-${key}`);
    const plusBtn = document.getElementById(`branch-plus-${key}`) as HTMLButtonElement | null;
    const minusBtn = document.getElementById(`branch-minus-${key}`) as HTMLButtonElement | null;
    const rowEl = plusBtn?.closest('.el-branch-row') as HTMLElement | null;

    const locked = focus != null && focus !== key;
    if (valEl) valEl.textContent = String(val);
    if (fillEl) (fillEl as HTMLElement).style.width = val + '%';
    if (fillEl) (fillEl as HTMLElement).style.background = `linear-gradient(90deg,${color}88,${color})`;
    if (costEl) costEl.textContent = val >= 100 ? '\u2014' : String(cost);
    if (rowEl) {
      rowEl.classList.toggle('locked', locked);
      rowEl.classList.toggle('focused', focus === key);
      const focusLabel = defs.find(d => d.id === focus)?.label ?? 'another branch';
      rowEl.title = locked
        ? `Evolution this era already runs toward ${focusLabel}. This opens again next phase.`
        : def.blurb;
    }
    if (plusBtn)  plusBtn.disabled  = locked || points < cost || val >= 100;
    if (minusBtn) minusBtn.disabled = locked || val <= 0;
  });

  // Say plainly what is going on, rather than leaving the player looking at
  // seven greyed-out rows with no explanation.
  const focusNote = document.getElementById('el-focus-note');
  if (focusNote) {
    const fdef = focus ? defs.find(d => d.id === focus) : null;
    focusNote.textContent = fdef
      ? `Evolution this era runs toward ${fdef.label}. A new course can be set at the next phase.`
      : 'Choose one branch to evolve this era.';
    focusNote.style.color = fdef ? fdef.color : '';
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
      <div class="codex-entry-name">${r.title}</div>
      <div class="codex-entry-age">${r.subtitle}</div>
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
    ? `<div class="codex-detail-body">${entry.body}</div>`
    : `<div class="codex-detail-pending">The chronicles are still being written…<br>The AI God will speak on this matter soon.</div>`;
  detailEl.innerHTML = `
    <div class="codex-detail-title">${entry.title}</div>
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
        ? 'A cosmic plague has ravaged your civilization. Tech level has regressed.'
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
  gameState.speed = speed;
  (window as unknown as Record<string, unknown>)['eternalSpeed'] = speed;
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', Number((btn as HTMLElement).dataset['speed']) === speed);
  });
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
  const dpEl = document.getElementById('dp-display');
  if (dpEl) dpEl.textContent = `✦ ${gameState.divinePoints} DP`;
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
      btn.querySelector('.divine-action-cost')?.classList.toggle('affordable', canAfford);
    }
  }

  // Prophet + Revelation require religion to have emerged
  const hasReligion = !!gameState.playerReligionName;
  (document.getElementById('send-prophet-btn')     as HTMLButtonElement | null)?.toggleAttribute('hidden', !hasReligion);
  (document.getElementById('trigger-revelation-btn') as HTMLButtonElement | null)?.toggleAttribute('hidden', !hasReligion);
  updateSmiteButton();

  // Send Meteor — visible only when a revealed lifeless star exists nearby
  const meteorBtn = document.getElementById('send-meteor-btn') as HTMLButtonElement | null;
  if (meteorBtn) {
    const hasMeteorTarget = !!engine?.getMeteorTarget();
    meteorBtn.style.display = hasMeteorTarget ? '' : 'none';
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
      if (costEl) costEl.textContent = `${TERRAFORM_COST} DP`;
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
    if (icon)  icon.textContent  = '🧠';
    if (title) title.textContent = 'INTELLIGENCE EMERGES';
    if (desc)  desc.textContent  = `After eons of evolution, the first truly intelligent beings have awakened on ${gameState.playerPlanetName}. What do you call your people?`;
    if (input) input.placeholder = 'e.g. Humans';
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
  engine.init(save.gameState.stats!, save.gameState.masterSeed);
  engine.loadState(save.engine);

  fallbackNarrator = new FallbackNarrator(save.gameState.masterSeed);
  _geminiService = geminiKey ? new GeminiService(geminiKey, save.gameState.masterSeed) : null;
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
  engine.start();
  engine.focusPlayerStar();
  setSpeed(save.gameState.speed ?? 1);

  // Restore HUD displays
  document.getElementById('god-name-display')!.textContent = godName;
  document.getElementById('god-name-top')!.textContent = godName;
  updateHUDTick(save.gameState.tick);
  const dpEl = document.getElementById('dp-display');
  if (dpEl) dpEl.textContent = `✦ ${save.gameState.divinePoints} DP`;

  const ps = engine.getPlayerStar();
  if (ps) updateBottomBar(ps);

  addChatMessage(`[ Universe restored — Tick ${save.gameState.tick.toLocaleString()} | ${new Date(save.savedAt).toLocaleString()} ]`, 'system');
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
window.addEventListener('DOMContentLoaded', () => {
  logger.info('Eternal Systems initializing');

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

  // Planet name input updates genesis button availability
  document.getElementById('planet-name-input')?.addEventListener('input', checkGenesisReady);

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
    const nameInput = document.getElementById('planet-name-input') as HTMLInputElement | null;
    if (nameInput) nameInput.value = q.get('planet') || 'Terra';
    launchBigBang();
    // Expose internals for console poking. Dev flag only.
    const dbg = window as unknown as Record<string, unknown>;
    dbg['__engine'] = engine;
    dbg['__gameState'] = gameState;
    dbg['__runtimeState'] = runtimeState;
    dbg['__diorama'] = () => _dioramaRenderer;
    dbg['__pixi'] = () => _pixiRenderer;
    // &view=home also skips the Big Bang cinematic and opens the home world.
    if (q.get('view') === 'home') {
      enterUniverse();
      void openPlanetView();
    }

    // &lab=1 seeds a grown biosphere and a DNA balance, then opens the
    // Evolution Lab. A real world needs tens of thousands of ticks before it has
    // either, and requestAnimationFrame is throttled in a background tab, so
    // there is otherwise no way to look at this screen while working on it.
    if (q.get('lab') === '1') {
      enterUniverse();
      const rngL = new SeedRNG('devlab');
      if (gameState.playerSpecies.length === 0) {
        gameState.playerSpecies = initPlayerSpecies(0, rngL);
      }
      let bioL = gameState.playerBiosphere;
      for (let i = 0; i < 400; i++) {
        const r = stepEvolution('primitive', gameState.playerDNA, gameState.playerSpecies,
                                bioL, rngL, i * 2000, runtimeState.branchDefs);
        gameState.playerSpecies = r.updatedSpecies;
        bioL = r.updatedBiosphere;
      }
      gameState.playerBiosphere = bioL;
      gameState.dnaPoints = Number(q.get('dna') ?? 40);
      // &codex=1 opens the Codex over the same seeded world instead of the lab.
      if (q.get('codex') === '1') openCodex();
      else openEvoLab();
    }
  }

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', function(this: HTMLElement) {
      setSpeed(Number(this.dataset['speed'] ?? 1));
    });
  });

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
      const homePlanet = ps.planets.find(p => p.hasLife) ?? ps.planets[0];
      const idx = ps.planets.indexOf(homePlanet);
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
  document.getElementById('el-commit-btn')?.addEventListener('click', () => {
    if (gameState.dnaPoints >= 10) openTraitsModal();
  });

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
    // Recreate gemini service with new key
    if (_geminiService) _geminiService.destroy?.();
    _geminiService = key ? new GeminiService(key, gameState.masterSeed) : null;
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
// It is a VIEW, not a second source of truth: every button goes through the same
// cost and focus rules as the side panel (`dnaPointCost`, `dnaFocusBranch`), and
// both refresh together.
// ═════════════════════════════════════════════════════════════════════════════

/** The species the lab is looking at — the most populous living lineage. */
function labSpecimen(): SpeciesGenome | null {
  const living = gameState.playerSpecies.filter(s => !s.isExtinct);
  if (living.length === 0) return null;
  return living.reduce((a, b) => (b.population > a.population ? b : a));
}

/**
 * Draw a DNA double helix whose base pairs are derived from the genome.
 *
 * Decorative, but not arbitrary: the same species always produces the same
 * sequence, so the strip is a fingerprint of the lineage rather than noise that
 * reshuffles every time the panel opens.
 */
function drawHelix(canvas: HTMLCanvasElement, sp: SpeciesGenome | null): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width = canvas.clientWidth || 520;
  const H = canvas.height = 74;
  g.clearRect(0, 0, W, H);
  if (!sp) return;

  let h = 2166136261;
  const src = sp.id + sp.dna.metabolism + sp.dna.locomotion + sp.dna.environment +
              sp.dna.diet + sp.physicalTraits.bodyStructure;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rnd = () => { h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h >>> 0) % 1000) / 1000; };

  const BASES = ['A', 'T', 'G', 'C'];
  const mid = H / 2, amp = H * 0.32, step = 13;

  g.font = '9px "Courier New",monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  for (let x = 8, i = 0; x < W - 8; x += step, i++) {
    const phase = (x / W) * Math.PI * 6;
    const y1 = mid + Math.sin(phase) * amp;
    const y2 = mid - Math.sin(phase) * amp;
    const depth = (Math.cos(phase) + 1) / 2;      // strand nearest the viewer

    // Rung between the strands.
    g.strokeStyle = `rgba(63,143,102,${0.25 + depth * 0.4})`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y1); g.lineTo(x, y2); g.stroke();

    const b = Math.floor(rnd() * 4);
    // Base pairs: A–T and G–C, so the strip reads as real complementary DNA.
    const top = BASES[b];
    const bot = BASES[b % 2 === 0 ? b + 1 : b - 1];
    g.fillStyle = `rgba(125,255,180,${0.45 + depth * 0.55})`;
    g.fillText(top, x, y1);
    g.fillStyle = `rgba(125,255,180,${0.9 - depth * 0.5})`;
    g.fillText(bot, x, y2);
  }
}

function renderEvoLab(): void {
  const overlay = document.getElementById('evo-lab-overlay');
  if (!overlay || !overlay.classList.contains('active')) return;

  const ps = engine?.getPlayerStar();
  const sp = labSpecimen();
  const defs = currentBranchDefs();
  const phIdx = currentPhaseIndex();
  const points = gameState.dnaPoints;
  const focus = gameState.dnaFocusBranch;

  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  // ── Specimen ─────────────────────────────────────────────────────────────
  const tank = document.getElementById('evo-tank')!;
  tank.innerHTML = '';
  if (sp) {
    // Baked large: this is a specimen tank, not a map marker. The sprite is
    // pixel art scaled with nearest-neighbour, so a big integer factor is free.
    const sprite = bakeCreatureSprite(sp, 10);
    tank.appendChild(sprite);
    set('evo-specimen-name', sp.name);
    // "flying in the land" is the kind of phrasing that falls out of naive
    // template stitching; each environment gets a preposition that fits it.
    const WHERE: Record<string, string> = {
      land: 'across open land', ocean: 'through open water',
      deep_sea: 'in the deep', coastal: 'along the shoreline', aerial: 'on the wing',
    };
    set('evo-specimen-kind',
      `${sp.physicalTraits.size} ${sp.dna.diet} — ${sp.dna.locomotion} ` +
      `${WHERE[sp.dna.environment] ?? 'in the ' + sp.dna.environment.replace(/_/g, ' ')}`);
    const stats = document.getElementById('evo-specimen-stats')!;
    stats.innerHTML = '';
    const rows: Array<[string, string]> = [
      ['INT', `${sp.dna.intelligence}/10`],
      ['SOC', `${sp.dna.social}/10`],
      ['AGG', `${sp.dna.aggression}/10`],
      ['ADAPT', `${sp.dna.adaptability}/10`],
      ['DOMINANCE', `${(sp.population * 100).toFixed(0)}%`],
      ['BODY', sp.physicalTraits.bodyStructure],
    ];
    for (const [k, v] of rows) {
      const d = document.createElement('div');
      d.className = 'evo-stat';
      d.innerHTML = `<span>${k}</span><b></b>`;
      d.querySelector('b')!.textContent = v;
      stats.appendChild(d);
    }
  } else {
    set('evo-specimen-name', 'NO SPECIMEN');
    set('evo-specimen-kind', 'Life has not yet taken hold on this world.');
    document.getElementById('evo-specimen-stats')!.innerHTML = '';
  }

  // ── Genome ───────────────────────────────────────────────────────────────
  drawHelix(document.getElementById('evo-helix') as HTMLCanvasElement, sp);

  const slots = document.getElementById('evo-slots')!;
  slots.innerHTML = '';
  BIO_PHASE_SEQUENCE.forEach((ph, i) => {
    const el = document.createElement('span');
    el.className = 'evo-slot' + (i <= phIdx ? ' on' : '');
    el.textContent = ph.slice(0, 6).toUpperCase();
    slots.appendChild(el);
  });

  const genes = document.getElementById('evo-genes')!;
  genes.innerHTML = '';
  if (sp) {
    const cards: Array<[string, string, string]> = [
      ['METABOLISM',  sp.dna.metabolism,                 'how it makes a living'],
      ['LOCOMOTION',  sp.dna.locomotion,                 sp.physicalTraits.mobilityType],
      ['ENVIRONMENT', sp.dna.environment.replace(/_/g, ' '), sp.habitat.biome.replace(/_/g, ' ')],
      ['DIET',        sp.dna.diet,                       'trophic role'],
      ['RESPIRATION', sp.dna.respiration,                'gas exchange'],
      ['REPRODUCTION', sp.dna.reproduction,              'how it persists'],
      ['BODY PLAN',   sp.physicalTraits.bodyStructure,   sp.physicalTraits.size],
      ['SENSES',      sp.physicalTraits.sensorySystem,   sp.habitat.temperatureRange.replace(/_/g, ' ')],
    ];
    for (const [label, value, note] of cards) {
      const d = document.createElement('div');
      d.className = 'evo-gene';
      d.innerHTML = `<div class="g-label"></div><div class="g-value"></div><div class="g-note"></div>`;
      d.querySelector('.g-label')!.textContent = label;
      d.querySelector('.g-value')!.textContent = value;
      d.querySelector('.g-note')!.textContent = note;
      genes.appendChild(d);
    }
  }

  // ── Gene bank ────────────────────────────────────────────────────────────
  const list = document.getElementById('evo-bank-list')!;
  list.innerHTML = '';
  for (const def of defs) {
    const val = gameState.playerDNA[def.id] ?? 0;
    const cost = dnaPointCost(val, phIdx);
    const locked = focus != null && focus !== def.id;
    const affordable = points >= cost;

    const btn = document.createElement('button');
    btn.className = 'evo-bank-row' + (locked ? ' locked' : '') + (focus === def.id ? ' focused' : '');
    btn.disabled = locked || !affordable || val >= 100;
    btn.title = locked
      ? `Evolution this era already runs toward another branch. This opens again next phase.`
      : !affordable ? `Needs ${cost} DNA` : def.blurb;
    btn.innerHTML =
      `<span class="evo-bank-glyph"></span>` +
      `<span class="evo-bank-mid"><div class="evo-bank-name"></div><div class="evo-bank-sub"></div></span>` +
      `<span class="evo-bank-cost"></span>`;
    btn.querySelector('.evo-bank-glyph')!.textContent = def.glyph;
    (btn.querySelector('.evo-bank-glyph') as HTMLElement).style.color = def.color;
    btn.querySelector('.evo-bank-name')!.textContent = def.label;
    btn.querySelector('.evo-bank-sub')!.textContent = `${val} expressed`;
    btn.querySelector('.evo-bank-cost')!.textContent = val >= 100 ? 'MAX' : `${cost} DNA`;

    btn.addEventListener('click', () => {
      const cur = gameState.playerDNA[def.id] ?? 0;
      if (cur >= 100) return;
      if (gameState.dnaFocusBranch && gameState.dnaFocusBranch !== def.id) return;
      const c = dnaPointCost(cur, currentPhaseIndex());
      if (gameState.dnaPoints < c) return;
      gameState.dnaPoints -= c;
      gameState.playerDNA[def.id] = cur + 1;
      gameState.dnaFocusBranch = def.id;
      AudioManager.playSfx('ui_click');
      // Both views read the same state, so both are refreshed together.
      updateDNAPanel();
      renderEvoLab();
    });
    list.appendChild(btn);
  }

  set('evo-dna-points', String(points));
  set('evo-phase', ps ? (BIO_PHASE_LABELS[ps.biologyPhase] ?? ps.biologyPhase) : '—');

  const focusLine = document.getElementById('evo-focus-line')!;
  const fdef = focus ? defs.find(d => d.id === focus) : null;
  focusLine.textContent = fdef
    ? `Evolution this era runs toward ${fdef.label}. A new course can be set at the next phase.`
    : 'Choose one branch to evolve this era.';
  focusLine.style.color = fdef ? fdef.color : '';
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


// ═════════════════════════════════════════════════════════════════════════════
// ZOOM TIERS (M22a)
//
// Universe → Galaxy → Solar System → Planet as one continuum. Scrolling moves
// through the tiers and the buttons jump between them; both update the same
// indicator, so however the player got there the UI agrees about where they are.
// ═════════════════════════════════════════════════════════════════════════════

let _lastZoomTier: ZoomTier | null = null;

function initZoomTiers(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.zt-btn')) {
    btn.addEventListener('click', () => {
      const tier = btn.dataset['tier'] as ZoomTier | undefined;
      if (!tier || !engine) return;
      AudioManager.playSfx('ui_click');
      // The planet tier is not a camera position — it is the surface view. Zoom
      // to the system first so closing it lands somewhere sensible.
      if (tier === 'planet') {
        engine.setZoomTier('system');
        openPlanetView();
        return;
      }
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
  const overlayOpen = document.getElementById('planet-overlay')?.classList.contains('active');
  const shown: ZoomTier | null = overlayOpen ? 'planet' : tier;

  if (shown !== _lastZoomTier) {
    _lastZoomTier = shown;
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.zt-btn')) {
      btn.classList.toggle('active', btn.dataset['tier'] === shown);
    }
  }
  window.setTimeout(syncZoomTierUI, 250);
}
