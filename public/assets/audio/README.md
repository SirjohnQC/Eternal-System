# Eternal Systems — Audio Asset Spec
## Format
- **Music**: MP3, 192kbps+, 44.1kHz stereo. OGG fallback optional.
- **SFX**: MP3 or OGG, mono or stereo, normalized to -6dBFS peak.
- Place music in `assets/audio/music/`, SFX in `assets/audio/sfx/`.

---

## Music Tracks (Suno prompts)

### `ambient_menu.mp3`
**Mood**: mysterious, cosmic anticipation, quiet grandeur
**Length**: 2–4 min, seamlessly loopable
**Suno prompt**: *"Dark ambient space music, slow evolving drone, deep bass hum, faint star chimes, no percussion, cinematic and mysterious, loopable, 60 BPM"*

### `ambient_cosmos.mp3`
**Mood**: peaceful observation, vast and timeless, the universe breathing
**Length**: 3–5 min, loopable
**Suno prompt**: *"Deep space ambient, slow evolving pads, gentle cosmic drone, occasional distant choir, no drums, ethereal and vast, loopable"*

### `ambient_war.mp3`
**Mood**: tension, ancient conflict, drums of fate
**Length**: 2–3 min, loopable
**Suno prompt**: *"Dark cinematic ambient, low ominous percussion, tension building, war drums in distance, orchestral dread, loopable"*

### `ambient_bigbang.mp3`
**Mood**: genesis, explosion of creation, overwhelming cosmic power
**Length**: 60–90 sec, plays once (not looped)
**Suno prompt**: *"Epic orchestral crescendo, big bang genesis, starts from near silence builds to massive climax, cosmic choir, cinematic"*

---

## SFX (Suno or other tools)

| File | Duration | Description | Suno hint |
|---|---|---|---|
| `ui_click.mp3` | <0.3s | Button press — crisp, mystical | *"single soft crystal chime tap"* |
| `ui_confirm.mp3` | <0.5s | Genesis / confirm — satisfying | *"ascending two-note crystal tone, affirming"* |
| `notification.mp3` | <0.8s | Feed event / toast ping | *"soft cosmic notification chime, single tone"* |
| `war_declared.mp3` | <1.5s | War start stinger | *"low dramatic war horn sting, brief and ominous"* |
| `cosmic_event.mp3` | <2s | Supernova / asteroid warning | *"deep cosmic impact rumble, single hit"* |
| `revelation.mp3` | <2s | Divine revelation / God sign | *"angelic choir swell, divine shimmer, short"* |
| `discovery.mp3` | <1s | Planet discovered | *"light ethereal discovery chime, uplifting"* |
| `dice_roll.mp3` | ~3s | D20 stat roll — player + God | *(user-created)* |

---

## Integration Notes
The `AudioManager` (`src/audio/AudioManager.ts`) loads files lazily and falls back to silence if a file is missing — so you can add files one at a time as they're created. No code changes needed when adding new audio files.

Volume levels are saved to `localStorage` under `eternal_audio_settings`.
