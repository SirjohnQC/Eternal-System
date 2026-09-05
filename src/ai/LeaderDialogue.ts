import { GeminiService } from './GeminiService';
import { FallbackNarrator } from './FallbackNarrator';
import { Leader, LeaderMemory } from '../simulation/Leader';

interface DialogueResult {
  text: string;
  fromFallback: boolean;
}

function buildDialoguePrompt(leader: Leader, eventContext: string, memories: LeaderMemory | null | undefined): string {
  const memoryBlock = memories && memories.entries.length > 0
    ? `Relevant Memories:\n${memories.entries.slice(-5).map(e => `- ${e}`).join('\n')}`
    : 'No prior memories.';

  const traits = leader.personalityTraits.join(', ');
  const commStyle = leader.communicationStyle.replace(/_/g, ' ');
  const attitude = leader.attitudeTowardGod.replace(/_/g, ' ');

  return `You are roleplaying a civilization leader speaking directly to a divine being (the player god).

Leader: ${leader.name}, ${leader.role} of ${leader.faction}
Species: ${leader.species}
Ideology: ${leader.ideology}
Personality: ${traits}
Communication Style: ${commStyle}
Attitude Toward God: ${attitude}
Intelligence: ${leader.intelligenceLevel}/10, Ambition: ${leader.ambitionLevel}/10, Faith: ${leader.faithLevel}/10, Fear: ${leader.fearLevel}/10

${memoryBlock}

Current Situation: ${eventContext}

Instructions:
- Stay fully in character. Speak as if addressing a powerful god.
- Tone must reflect personality traits and communication style.
- Refer to past memories when relevant.
- Keep response concise (2–4 sentences).
- Avoid modern slang unless civilization is technologically advanced (Space Age+).
- Do not break character. No meta commentary.

Generate the message this leader would say to their god right now.`;
}

export async function generateLeaderDialogue(
  leader: Leader,
  eventContext: string,
  memories: LeaderMemory | null | undefined,
  geminiService: GeminiService | null,
  fallbackNarrator: FallbackNarrator,
): Promise<DialogueResult> {
  if (geminiService !== null && !geminiService.offlineMode) {
    try {
      const prompt = buildDialoguePrompt(leader, eventContext, memories);
      const text = await geminiService.sendPlayerMessage(prompt, '');
      return { text, fromFallback: false };
    } catch {
      // fall through to fallback
    }
  }

  const result = fallbackNarrator.generateCivilizationMilestone(leader.faction, eventContext);
  const text = `${result} — ${leader.name}, ${leader.role} of ${leader.faction}`;
  return { text, fromFallback: true };
}

export async function generateMemoryEntry(
  leader: Leader,
  eventContext: string,
  _geminiService: GeminiService | null,
  _fallbackNarrator: FallbackNarrator,
): Promise<string> {
  // Memory entries use a simple template to avoid debounce conflicts with the main dialogue call
  return `${eventContext.slice(0, 80)} — ${leader.name}`;
}
