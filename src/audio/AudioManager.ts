/**
 * AudioManager — lazy-loading audio system for Eternal Systems.
 * All files are optional: missing files fail silently (no errors thrown).
 * AudioContext is created on first user gesture (browser autoplay policy).
 */

const STORAGE_KEY = 'eternal_audio_settings';

export interface AudioSettings {
  masterVolume: number;  // 0–1
  musicVolume: number;   // 0–1
  sfxVolume: number;     // 0–1
  muted: boolean;
}

const DEFAULT_SETTINGS: AudioSettings = {
  masterVolume: 0.8,
  musicVolume: 0.55,
  sfxVolume: 0.75,
  muted: false,
};

type TrackId =
  | 'ambient_menu'
  | 'ambient_cosmos'
  | 'ambient_war'
  | 'ambient_bigbang';

type SfxId =
  | 'ui_click'
  | 'ui_confirm'
  | 'notification'
  | 'war_declared'
  | 'cosmic_event'
  | 'revelation'
  | 'discovery'
  | 'dice_roll';

const MUSIC_FILES: Record<TrackId, string> = {
  ambient_menu:    '/assets/audio/music/ambient_menu.mp3',
  ambient_cosmos:  '/assets/audio/music/ambient_cosmos.mp3',
  ambient_war:     '/assets/audio/music/ambient_war.mp3',
  ambient_bigbang: '/assets/audio/music/ambient_bigbang.mp3',
};

// Cosmos playlist — add more files here as you create them.
// Files that don't exist are silently skipped at runtime.
const COSMOS_PLAYLIST: string[] = [
  '/assets/audio/music/ambient_cosmos.mp3',
  '/assets/audio/music/ambient_cosmos_v2.mp3',
  '/assets/audio/music/ambient_cosmos_v3.mp3',
  '/assets/audio/music/ambient_cosmos_v4.mp3',
];

const SFX_FILES: Record<SfxId, string> = {
  ui_click:     '/assets/audio/sfx/ui_click.mp3',
  ui_confirm:   '/assets/audio/sfx/ui_confirm.mp3',
  notification: '/assets/audio/sfx/notification.mp3',
  war_declared: '/assets/audio/sfx/war_declared.mp3',
  cosmic_event: '/assets/audio/sfx/cosmic_event.mp3',
  revelation:   '/assets/audio/sfx/revelation.mp3',
  discovery:    '/assets/audio/sfx/discovery.mp3',
  dice_roll:    '/assets/audio/sfx/dice_roll.mp3',
};

const FADE_TIME = 1.5; // seconds for music crossfade

class AudioManagerClass {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;

  private musicBuffers = new Map<TrackId, AudioBuffer>();
  private cosmosBuffers = new Map<string, AudioBuffer>(); // url → buffer
  private sfxBuffers    = new Map<SfxId, AudioBuffer>();

  private currentSource: AudioBufferSourceNode | null = null;
  private currentTrack: TrackId | string | null = null;

  // Cosmos playlist state
  private cosmosActive = false;
  private lastCosmosUrl: string | null = null;

  settings: AudioSettings;
  private initialized = false;

  constructor() {
    const saved = localStorage.getItem(STORAGE_KEY);
    this.settings = saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
  }

  // ── Init (called on first user gesture) ───────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) {
      void this.ctx?.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.musicGain  = this.ctx.createGain();
      this.sfxGain    = this.ctx.createGain();

      this.musicGain.connect(this.masterGain);
      this.sfxGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      this.applyVolumes();
      this.initialized = true;

      // Browser autoplay policy: context may start suspended.
      if (this.ctx.state === 'suspended') {
        const resume = () => { void this.ctx?.resume(); };
        document.addEventListener('click',      resume, { once: true });
        document.addEventListener('keydown',    resume, { once: true });
        document.addEventListener('touchstart', resume, { once: true });
      }

      void this.preloadSfx();
    } catch {
      // AudioContext unavailable — silent degradation
    }
  }

  private async preloadSfx(): Promise<void> {
    for (const [id, url] of Object.entries(SFX_FILES) as [SfxId, string][]) {
      void this.loadBuffer(url).then(buf => { if (buf) this.sfxBuffers.set(id, buf); });
    }
  }

  private async loadBuffer(url: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const arrayBuf = await resp.arrayBuffer();
      return await this.ctx.decodeAudioData(arrayBuf);
    } catch {
      return null; // file missing or decode error — silent
    }
  }

  // ── Internal: fade out + stop current source ──────────────────────────────

  private fadeOutCurrent(): void {
    if (!this.ctx || !this.musicGain || !this.currentSource) return;
    const src = this.currentSource;
    const now = this.ctx.currentTime;
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(0, now + FADE_TIME);
    setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, FADE_TIME * 1000 + 100);
    this.currentSource = null;
    this.currentTrack  = null;
  }

  // ── Internal: start a buffer as music source ──────────────────────────────

  private startSource(buffer: AudioBuffer, loop: boolean, onEnded?: () => void): void {
    if (!this.ctx || !this.musicGain) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop   = loop;
    src.connect(this.musicGain);

    if (onEnded) src.addEventListener('ended', onEnded, { once: true });

    const now = this.ctx.currentTime;
    this.musicGain.gain.setValueAtTime(0, now);
    this.musicGain.gain.linearRampToValueAtTime(
      this.settings.muted ? 0 : this.settings.musicVolume,
      now + FADE_TIME
    );

    src.start(0);
    this.currentSource = src;
  }

  // ── Music (named tracks) ──────────────────────────────────────────────────

  async playMusic(id: TrackId, loop = true): Promise<void> {
    if (!this.ctx || !this.musicGain) return;
    this.cosmosActive = false; // stop cosmos playlist if a named track is requested

    if (this.currentTrack === id) return;

    // Fade out whatever is currently playing — even if new track fails to load
    this.fadeOutCurrent();
    this.currentTrack = id;

    if (!this.musicBuffers.has(id)) {
      const buf = await this.loadBuffer(MUSIC_FILES[id]);
      if (!buf) return; // file missing — old track already faded out, silence is fine
      this.musicBuffers.set(id, buf);
    }

    // Guard: another track may have been requested while we were loading
    if (this.currentTrack !== id) return;

    this.startSource(this.musicBuffers.get(id)!, loop);
  }

  stopMusic(fadeOut = FADE_TIME): void {
    this.cosmosActive = false;
    if (!this.ctx || !this.musicGain || !this.currentSource) return;
    const src = this.currentSource;
    const now = this.ctx.currentTime;
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(0, now + fadeOut);
    setTimeout(() => { try { src.stop(); } catch { /* ok */ } }, fadeOut * 1000 + 100);
    this.currentSource = null;
    this.currentTrack  = null;
  }

  // ── Cosmos Playlist ───────────────────────────────────────────────────────
  // Picks a random cosmos track, plays it to completion, then picks another.
  // Skips files that fail to load. Falls back to looping ambient_cosmos.mp3
  // if all variants are missing.

  async playCosmosPlaylist(): Promise<void> {
    if (!this.ctx || !this.musicGain) return;
    this.cosmosActive = true;

    // Stop whatever is playing now
    this.fadeOutCurrent();

    await this.playNextCosmosTrack();
  }

  private async playNextCosmosTrack(): Promise<void> {
    if (!this.cosmosActive || !this.ctx || !this.musicGain) return;

    // Build candidate list — exclude the track that just played
    const candidates = COSMOS_PLAYLIST.filter(url => url !== this.lastCosmosUrl);
    // Try candidates in random order
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);

    for (const url of shuffled) {
      let buffer = this.cosmosBuffers.get(url) ?? null;
      if (!buffer) {
        buffer = await this.loadBuffer(url);
        if (buffer) this.cosmosBuffers.set(url, buffer);
      }
      if (!buffer) continue; // file missing — try next

      if (!this.cosmosActive) return; // playlist was stopped while loading

      this.lastCosmosUrl = url;
      this.currentTrack  = url;
      this.startSource(buffer, false, () => {
        // Track ended naturally — pick the next one
        if (this.cosmosActive) void this.playNextCosmosTrack();
      });
      return;
    }

    // All variants missing — loop the base track as a safe fallback
    await this.playMusic('ambient_cosmos', true);
  }

  // ── SFX ──────────────────────────────────────────────────────────────────

  playSfx(id: SfxId): void {
    if (!this.ctx || !this.sfxGain || this.settings.muted) return;
    const buffer = this.sfxBuffers.get(id);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.sfxGain);
    src.start(0);
  }

  // ── Volume ────────────────────────────────────────────────────────────────

  setMasterVolume(v: number): void {
    this.settings.masterVolume = Math.max(0, Math.min(1, v));
    this.applyVolumes();
    this.saveSettings();
  }

  setMusicVolume(v: number): void {
    this.settings.musicVolume = Math.max(0, Math.min(1, v));
    this.applyVolumes();
    this.saveSettings();
  }

  setSfxVolume(v: number): void {
    this.settings.sfxVolume = Math.max(0, Math.min(1, v));
    this.applyVolumes();
    this.saveSettings();
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.applyVolumes();
    this.saveSettings();
  }

  private applyVolumes(): void {
    if (!this.masterGain || !this.musicGain || !this.sfxGain) return;
    const m = this.settings.muted ? 0 : 1;
    this.masterGain.gain.value = this.settings.masterVolume * m;
    this.musicGain.gain.value  = this.settings.musicVolume;
    this.sfxGain.gain.value    = this.settings.sfxVolume;
  }

  private saveSettings(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
  }
}

export const AudioManager = new AudioManagerClass();
