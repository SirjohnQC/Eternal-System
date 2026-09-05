/**
 * CultureGenerator — asks Gemini for a civilisation's culture, and refuses to
 * believe it without checking.
 *
 * Model output DRIVES THE SIMULATION here (war odds, tech speed, diplomacy), so
 * validation is not cosmetic. It is all-or-nothing: a partially valid response
 * is rejected rather than merged, because a half-generated half-procedural
 * record is harder to reason about than either on its own.
 */
import type { GeminiService } from './GeminiService';
import {
  GOVERNMENTS, IDEOLOGIES, type Civilization, type GenomeSummary,
  type Government, type Ideology, type CultureValues,
} from '../simulation/Civilization';

const MAX_PROSE = 400;
const MAX_SHORT = 60;

export function buildCulturePrompt(
  g: GenomeSummary, civName: string, techTier: string,
): string {
  return `You are generating a civilisation for a procedural god-game. The species
below EVOLVED these traits through simulated natural selection; the culture must
follow from that biology, not from human history.

Species: ${g.speciesName}
Metabolism: ${g.metabolism}      Respiration: ${g.respiration}
Locomotion: ${g.locomotion}      Environment: ${g.environment}
Diet: ${g.diet}                  Reproduction: ${g.reproduction}
Size: ${g.size}                  Body plan: ${g.bodyStructure}
Senses: ${g.sensorySystem}
Intelligence ${g.intelligence}/10, Social ${g.social}/10, Aggression ${g.aggression}/10, Adaptability ${g.adaptability}/10
Home biome: ${g.biome}, ${g.temperatureRange}
Civilisation name: ${civName}
Technology tier: ${techTier}

Reply with ONLY a JSON object, no prose around it, exactly this shape:
{
  "government": one of ${JSON.stringify(GOVERNMENTS)},
  "ideology": one of ${JSON.stringify(IDEOLOGIES)},
  "values": {
    "militarism": 0.0-1.0, "piety": 0.0-1.0, "curiosity": 0.0-1.0,
    "collectivism": 0.0-1.0, "xenophobia": 0.0-1.0
  },
  "architecture": { "style": "...", "material": "...", "settlementForm": "..." },
  "selfDescription": "2-3 sentences, how they see themselves",
  "foundingMyth": "1-2 sentences, their origin story",
  "epithet": "a short title, e.g. 'the Tidebound'"
}

Rules: architecture must follow from morphology and environment. A species that
cannot manipulate objects does not build with tools. Keep every string under 300
characters. Output the JSON and nothing else.`;
}

function capped(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0) return null;
  return s.slice(0, max);
}

function num01(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null; // rejects "very high", null, true, [], ""
  return Math.max(0, Math.min(1, v));          // clamps 999 and -5
}

/**
 * Validate a raw model response into a Civilization, or return null.
 *
 * Returning null is not a failure path to be avoided — it is the normal outcome
 * for anything unexpected, and the caller keeps its procedural record.
 */
export function validateCultureResponse(
  raw: string, base: Civilization,
): Civilization | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  // Models like to wrap JSON in prose or a fenced block. Take the outermost
  // object and ignore the rest.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); }
  catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const o = parsed as Record<string, unknown>;

  // Enums must match exactly. This is what stops an injected instruction string
  // becoming a government.
  const government = o['government'] as Government;
  const ideology = o['ideology'] as Ideology;
  if (!GOVERNMENTS.includes(government)) return null;
  if (!IDEOLOGIES.includes(ideology)) return null;

  const rv = o['values'];
  if (rv === null || typeof rv !== 'object' || Array.isArray(rv)) return null;
  const v = rv as Record<string, unknown>;
  const keys: Array<keyof CultureValues> =
    ['militarism', 'piety', 'curiosity', 'collectivism', 'xenophobia'];
  const values = {} as CultureValues;
  for (const k of keys) {
    const n = num01(v[k]);
    if (n === null) return null;               // missing or non-numeric
    values[k] = n;
  }

  const ra = o['architecture'];
  if (ra === null || typeof ra !== 'object' || Array.isArray(ra)) return null;
  const a = ra as Record<string, unknown>;
  const style = capped(a['style'], MAX_SHORT);
  const material = capped(a['material'], MAX_SHORT);
  const settlementForm = capped(a['settlementForm'], MAX_SHORT);
  if (!style || !material || !settlementForm) return null;

  const selfDescription = capped(o['selfDescription'], MAX_PROSE);
  const foundingMyth = capped(o['foundingMyth'], MAX_PROSE);
  const epithet = capped(o['epithet'], MAX_SHORT);
  if (!selfDescription || !foundingMyth || !epithet) return null;

  return {
    ...base,
    government, ideology, values,
    architecture: { style, material, settlementForm },
    selfDescription, foundingMyth, epithet,
    origin: 'llm',
  };
}

/**
 * Generate culture, falling back to the record already in hand.
 *
 * Never throws and never returns null: the caller always ends up with a usable
 * civilisation.
 */
export async function generateCulture(
  base: Civilization,
  genome: GenomeSummary,
  civName: string,
  techTier: string,
  gemini: GeminiService | null,
): Promise<Civilization> {
  if (!gemini || gemini.offlineMode) return base;
  try {
    const raw = await gemini.sendPlayerMessage(
      buildCulturePrompt(genome, civName, techTier), '');
    return validateCultureResponse(raw, base) ?? base;
  } catch {
    return base;
  }
}
