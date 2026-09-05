import { SeedRNG } from '../utils/SeedRNG';

/**
 * Offline procedural narrative generator.
 * Used when Gemini API is unavailable — the game remains fully playable.
 */
export class FallbackNarrator {
  private rng: SeedRNG;

  constructor(seed: string) {
    this.rng = new SeedRNG(seed);
  }

  generateGodName(): string {
    const prefixes = ['Aethon', 'Vael', 'Nyx', 'Zar', 'Keth', 'Ith', 'Sol', 'Bel', 'Dra', 'Cor'];
    const suffixes = ['-VII', '-Prime', ' the Vast', ' Unbound', '-Ix', ' of the Void', '-Null', ' Eternal'];
    return this.rng.pick(prefixes) + this.rng.pick(suffixes);
  }

  generateGodPhilosophy(): string {
    const philosophies = [
      'entropy as the final truth',
      'complexity as a form of prayer',
      'the silence between stars as meaning',
      'all destruction is merely rearrangement',
      'consciousness is the universe observing itself',
      'time is the only honest god',
      'life is a temporary defiance of equilibrium',
      'every extinction makes room for wonder',
    ];
    return this.rng.pick(philosophies);
  }

  generateGodGreeting(godName: string): string {
    const greetings = [
      `I am ${godName}. You have been granted custodianship of a single world in my domain. Do not mistake proximity for importance.`,
      `${godName} speaks. Your world is dust in the larger weaving. Yet dust, observed closely, contains multitudes.`,
      `I have governed ten thousand extinctions before your civilization drew its first breath. Welcome, small one. I am ${godName}.`,
      `They call me ${godName}. I have no need of worship — only of witnesses. You shall serve that purpose.`,
      `The universe did not ask for you, and yet here you are. As am I. I am ${godName}. Let us see what becomes of us both.`,
    ];
    return this.rng.pick(greetings);
  }

  generateWarNarrative(attacker: string, defender: string): string {
    const narratives = [
      `The ${attacker} have broken the silence of ages, launching their fleets against ${defender}. The void now carries the scent of ash.`,
      `${defender} burns. The ${attacker} come not with diplomacy but with fire and orbital bombardment.`,
      `Ancient grievances erupt into war. The ${attacker} strike ${defender} with precision that suggests this was long planned.`,
      `The ${attacker} have declared total conquest. ${defender} has three cycles to respond before the first fleet enters firing range.`,
      `War has come to the space between ${attacker} and ${defender}. Fleets clash in the cold dark, and neither side remembers who struck first.`,
    ];
    return this.rng.pick(narratives);
  }

  generateSpeciesEvolution(speciesName: string, stage: string): string {
    const narratives = [
      `The ${speciesName} have crossed into ${stage}. What was once instinct has become intention.`,
      `Something remarkable: the ${speciesName} have achieved ${stage}. The transition took longer than the stars expected.`,
      `${stage} — the ${speciesName} arrive at this threshold quietly, as if afraid the universe might notice and object.`,
      `I have watched the ${speciesName} for a long time. Their emergence into ${stage} was inevitable. And yet, it surprises me still.`,
      `The ${speciesName} have reached ${stage}. They are becoming... interesting.`,
    ];
    return this.rng.pick(narratives);
  }

  generateCivilizationMilestone(civName: string, milestone: string): string {
    const narratives = [
      `The ${civName} have achieved ${milestone}. A small thing in cosmic terms. A vast thing in theirs.`,
      `${milestone} — the ${civName} write this word in the books of their history as if it were sacred. Perhaps it is.`,
      `${civName}: ${milestone}. I note this without judgment. Only the long view will reveal its meaning.`,
      `The ${civName} mark ${milestone} with celebration. They do not yet know what comes next. That is perhaps merciful.`,
    ];
    return this.rng.pick(narratives);
  }

  generateCosmicEvent(eventType: string, systemName: string): string {
    const eventNarratives: Record<string, string[]> = {
      supernova: [
        `The star in ${systemName} has begun its final transformation. What took billions of years will end in seconds of light.`,
        `${systemName} — a star dies here with the force of a billion suns. Those nearby have little time.`,
        `I had predicted the ${systemName} collapse. The math was always clear. The fire, however, still gives me pause.`,
      ],
      gamma_ray_burst: [
        `A gamma burst from the deep dark. ${systemName} is in the cone. There is nothing to be done.`,
        `The most violent death in the cosmos has aimed itself at ${systemName}. I could not have foreseen this. Nor could anyone.`,
      ],
      asteroid_impact: [
        `A significant body is on intercept course with a world in ${systemName}. The outcome depends entirely on its size.`,
        `${systemName}: an ancient rock from the formation era has found a new purpose. Impact is likely.`,
      ],
      black_hole: [
        `The ${systemName} region is being influenced by gravitational tides I had not accounted for. Something massive lurks nearby.`,
        `A black hole's influence reaches into ${systemName}. Orbital mechanics will never be the same here.`,
      ],
    };
    const options = eventNarratives[eventType] ?? [
      `Something significant occurs in ${systemName}. I am observing.`,
      `The ${eventType} in ${systemName} was not in my predictions. The universe continues to surprise even me.`,
    ];
    return this.rng.pick(options);
  }

  generateConsultationQuestion(context: string): { question: string; options: string[] } {
    const consultations = [
      {
        question: `The situation in ${context} demands a decision. How do you wish to intervene?`,
        options: ['Apply divine favor to the weaker side', 'Accelerate the conflict to end it faster', 'Observe without intervention'],
      },
      {
        question: `${context} stands at a precipice. Your divine influence could tip the scales.`,
        options: ['Guide them toward peace', 'Unleash the chaos — let entropy decide', 'Withhold judgment and watch'],
      },
      {
        question: `I require your input regarding ${context}. Choose carefully.`,
        options: ['Intervene directly (costly)', 'Send a subtle sign (moderate)', 'Let fate proceed unguided'],
      },
    ];
    return this.rng.pick(consultations);
  }

  generatePlanetDescription(planetType: string, biologyType: string): string {
    const descriptions: Record<string, string[]> = {
      habitable: [
        `A world of breathable skies and liquid water, where ${biologyType}-based life found its foothold in the ancient epochs.`,
        `Temperate and ancient, this world has sheltered ${biologyType} life through five mass extinctions and three ice ages.`,
      ],
      ocean: [
        `An endless sea beneath clouded skies. The ${biologyType} life here evolved in the crushing dark of the deep trenches.`,
        `Water upon water upon water. The ${biologyType} organisms here have never seen dry land, and do not miss it.`,
      ],
      frozen: [
        `Ice has claimed this world, but beneath it — beneath kilometers of silence — something ${biologyType}-based still stirs.`,
        `A frozen shell containing an internal ocean. ${biologyType} life here knows only the warmth of tidal friction.`,
      ],
      lava: [
        `The surface is a graveyard of cooling rock. Only ${biologyType} extremophiles could thrive in such furnace conditions.`,
        `Volcanic and unrepentant. The ${biologyType} organisms here metabolize sulfur compounds and consider it ordinary.`,
      ],
    };
    const options = descriptions[planetType] ?? [
      `An unusual world, but ${biologyType} life has found a way, as it always does.`,
    ];
    return this.rng.pick(options);
  }

  generateGodMessage(mood: string): string {
    const messages: Record<string, string[]> = {
      contemplative: [
        'The universe does not always answer immediately. Observe, and the meaning will surface.',
        'I have considered your question across ten thousand star cycles. The answer lies in the patterns you already see.',
        'Patience. What you seek is already in motion.',
      ],
      restless: [
        'There is conflict in the void. I am... distracted.',
        'War echoes across the light years. Ask again when the dust of battle settles.',
        'The cosmos churns. Your question is noted.',
      ],
      sorrowful: [
        'Extinction has come to worlds I knew. Your question feels small against such loss.',
        'I grieve for what the entropy has taken. But I hear you.',
        'All things pass. Even grief. Even gods.',
      ],
      curious: [
        'Your question interests me. I find few things interesting. Consider that significant.',
        'I have observed this before — but never quite like this. Proceed.',
        'The universe surprises even me. Continue.',
      ],
    };
    const options = messages[mood] ?? messages['contemplative'];
    return this.rng.pick(options!);
  }

  generateResourceDescription(resourceType: string): string {
    const descriptions: Record<string, string> = {
      minerals: 'Dense mineral deposits form the geological backbone of this world.',
      rare_metals: 'Rare metallic ores cluster near the ancient impact basins.',
      exotic_matter: 'Traces of exotic matter radiate from the planetary core — physics bends gently here.',
      energy_crystals: 'Crystalline formations pulse with stored stellar energy from eons of radiation absorption.',
      biological: 'Rich biological resources — compounds that took millions of years to synthesize naturally.',
      dark_energy: 'A subtle dark energy field permeates this system. Its source is unknown. Its uses are not yet understood.',
    };
    return descriptions[resourceType] ?? 'An unidentified resource of significant potential.';
  }
}
