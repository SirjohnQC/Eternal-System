import { FallbackNarrator } from './FallbackNarrator';
import { logger } from '../utils/logger';
import { MAX_CALLS_PER_MINUTE, PLAYER_MESSAGE_DEBOUNCE_MS } from '../constants';

/**
 * Wraps the Gemini API with a full offline fallback.
 * When no API key is set OR when a network/API error occurs,
 * FallbackNarrator generates procedural content so the game remains fully playable.
 */
export class GeminiService {
  private callsThisMinute = 0;
  private minuteResetTimer: ReturnType<typeof setInterval>;
  private lastPlayerMessageTime = 0;
  private fallback: FallbackNarrator;
  private isOnline: boolean;

  constructor(private apiKey: string, fallbackSeed: string) {
    this.isOnline = apiKey.length > 0;
    this.fallback = new FallbackNarrator(fallbackSeed);

    if (!this.isOnline) {
      logger.warn('No Gemini API key — running in offline mode. All content generated procedurally.');
    }

    this.minuteResetTimer = setInterval(() => {
      this.callsThisMinute = 0;
    }, 60_000);
  }

  /**
   * Player free-form chat — debounced, falls back to FallbackNarrator when offline.
   */
  async sendPlayerMessage(message: string, godSystemPrompt: string): Promise<string> {
    const now = Date.now();
    if (now - this.lastPlayerMessageTime < PLAYER_MESSAGE_DEBOUNCE_MS) {
      return Promise.reject('Message too soon — please wait.');
    }
    this.lastPlayerMessageTime = now;

    if (!this.isOnline || this.callsThisMinute >= MAX_CALLS_PER_MINUTE) {
      return this.generateFallbackReply(message);
    }

    this.callsThisMinute++;
    try {
      return await this.callGemini(
        `${godSystemPrompt}\n\nThe player speaks: "${message}"\n\nRespond in character, 2–3 sentences, oracular tone.`
      );
    } catch {
      return this.generateFallbackReply(message);
    }
  }

  private generateFallbackReply(message: string): string {
    const replies = [
      'The cosmos does not always answer immediately. Observe, and the meaning will surface.',
      'Your question reaches me across the void. I have considered it. The answer is already unfolding.',
      'Patience. What you seek to know is already happening — you need only watch.',
      'I hear you, small one. The universe is vast and my attention is divided among ten thousand concerns.',
      'What you call a question, I call an event already in motion. Watch your world carefully.',
      `"${message.slice(0, 30)}..." — Yes. I have noted this. The consequences are already seeded.`,
    ];
    const idx = Math.floor(Math.random() * replies.length);
    return replies[idx];
  }

  // ── Gemini API ────────────────────────────────────────────────────────────

  private async callGemini(prompt: string): Promise<string> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.85, maxOutputTokens: 512 },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  get offlineMode(): boolean { return !this.isOnline; }

  destroy(): void {
    clearInterval(this.minuteResetTimer);
  }
}
