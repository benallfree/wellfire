# Audio: music as a JSON score, sound effects as one-liners

No samples, no audio files. Wellfire: `src/score.json` (the music), `src/music.js` (compiler, instruments, sequencer,
jukebox), and the `sound` section of `src/game.js` (effects). The music module, score and hooks cost ~1,044 bytes at
-1 when added (~13 KB raw); the JSON score packed smaller than its old line-based form (392 → 265 bytes alone).

## Why this format

ZzFXM and Soundbox store patterns as number arrays: compact for zip, near-binary for surprisal. Tracker grids read well
but spell every note; full ABC is a lot of parser. Take the **tracker grid** (one token per step, voices aligned),
**ABC's note letters**, and a **chord track** from lead sheets: bass and arpeggio lines are written as chord tones, so
one short line fits any progression and a new section needs only chords and a melody.

## The score

```json
{
  "tempo": { "bpm": 104, "stepsPerBeat": 2, "beatsPerBar": 4 },
  "mix": 0.6,
  "order": { "day": ["A", "A", "B", "A"], "night": ["N", "N", "M", "N"] },
  "voices": {
    "bass": { "wave": "bass", "octave": 2, "volume": 0.036, "attack": 0.005, "release": 0.12, "reverb": 0.1 },
    "arp": { "wave": "pluck", "octave": 4, "volume": 0.24, "attack": 0.002, "release": 1.2, "bright": 0.55, "pan": -0.35, "calm": true },
    "boing": { "wave": "marimba", "octave": 4, "volume": 0.27, "attack": 0.002, "release": 0.5, "monster": "slime" }
  },
  "allSections": { "boing": "1,4 . . 1,4 . . 3,5 ." },
  "sections": {
    "A": { "chords": "C G Am F", "parts": { "lead": "e . g . c6 - b . | …", "bass": "1 . . 1 3 . 1 .", "pad": "* - - - - - - -", "hat": ". x . x . x . x,x" } },
    "B": { "base": "A", "chords": "F G Em Am", "parts": { "lead": "…" } }
  }
}
```

- `order`: sections by day and after dark, looping. `allSections`: parts in every section (the monster parts).
- `sections`: `chords` (one per bar; `"C,G"` splits a bar), `parts` (voice → pattern), optional `base` to inherit
  parts. A pattern shorter than the section repeats.
- Voice keys: `wave`, `octave`, `volume`, `attack`, `release`, optional `filter` (Hz), `pan`, `reverb` (send, default
  0.25), `chorus`, `bright`/`sustain` (pluck), and `calm: true` (ducks while monsters are near) or
  `monster: "<kind>"` (silent until that kind is near).

Pattern tokens (space separated): `c f# bb a4` notes (digit = octave); `1`..`9` chord tones counted up from the root
(1 root, 2 third, 3 fifth, 4 root an octave up…); `*` the whole chord; `x`/`o` drum hits (`o` louder); `-` hold; `.`
rest; `a,b` split one step (or bar) evenly; `|` bar line, ignored. Chords: root, optional `#`/`b`, `m`, `7`.

## Compiler and sequencer

- `score(json)` parses once and compiles every section into per-step event lists `{ v: voice, t, d, f: [Hz…], acc }`
  with notes already resolved to frequencies, so the runtime never parses.
- `sequencer(S, ac, out)`: the classic **lookahead scheduler**: a `setInterval` every 50 ms schedules the steps
  starting in the next 250 ms on the audio clock (sample-accurate, seamless loops). If it falls behind (background
  tab), skip ahead rather than burst.
- **Day/night**: when the light drops (`day < 0.35`), switch to the night order **at the next bar line**, same bar
  position; a master low-pass follows `1200 + day * 6000` Hz. The tempo never changes.
- **Monster parts**: each voice tagged with a kind fades in while one of that kind is within 14 units (fast in, slow
  out: the game eases a 0..1 `near[kind]`), so you hear what's coming. `calm` voices duck while anything is near. Keep
  them mid and high: a bass-heavy fight layer was inaudible on laptop speakers.
- **Humanize**: up to 6 ms timing slop, ±12% velocity with lighter off-beats, a few cents of pitch drift (drums ±30).
- **Master chain**: night low-pass → 30 Hz high-pass (rumble and DC) → compressor (3:1 from −20 dB) → `mix`. One
  shared convolution reverb whose impulse is generated decaying, darkening noise; per-voice pan and reverb send; an
  optional ensemble chorus (two LFO-swept delays panned apart).
- The same function can render into an `OfflineAudioContext` to check levels and seams without listening.

## Instruments (each a small recipe)

| wave | how |
|---|---|
| `flute` | a few soft harmonics, a breath-noise chiff on the attack, vibrato that fades in on held notes |
| `pluck` | Karplus-Strong: a noise burst in a one-period delay line averaged every pass, fractional-delay tuning |
| `bell` | inharmonic partials (1, 2, 3.01, 4.17, 5.43), high ones dying first, a beating copy of the fundamental |
| `strings` | three detuned saws, a low-pass opening over the slow attack, shared chorus |
| `brass` | two saws scooping up into pitch through a low-pass that blares open and settles |
| `bass` | saw + sine under a filter that snaps shut |
| `marimba` | a mallet sine whose pitch drops into place, plus a fast-dying fourth partial |
| `kick` / `taiko` | a pitch-swept sine with a noise click (kick) or dark skin noise (taiko) |
| `snare` / `hat` | a two-mode body plus high-passed noise; hats are high-passed noise with the release as decay |

Struck and plucked sounds are rendered once per pitch into a cached `AudioBuffer`; every pitch the score uses is
pre-rendered, one per scheduler tick, so a first note never stalls a frame. Held sounds are live oscillator graphs a
few nodes deep. A tick averages well under 1 ms.

## Jukebox (startup, mute)

- Create the `AudioContext` on the first `keydown`, `pointerdown` or `touchstart` (browsers require a gesture).
- Mute suspends the context (so the scheduler pauses too) and is remembered in localStorage.
- `mood(day, near)` passes the game state to the sequencer each frame.

## Sound effects

All synthesized on the fly, each wrapped in `try {}` and skipped when muted or before audio starts:

- `beep(f, d = 0.1, type = 'square', vol = 0.06, slide = 0.5)`: an oscillator whose pitch and gain ramp
  exponentially over `d`. Hits, swings, chings (`1568` then `2093` 60 ms later), deaths, thunks.
- `voice(points, vol, { vib, hiss, at })`: a sine gliding through `[seconds, Hz]` points, optional vibrato LFO and
  breath (noise through a band-pass following the note). Whistles, a hawk's call, a horse's whinny.
- `splash(vol)`: half a second of fading noise through a falling low-pass.
- Fanfares: a few `beep`s on `setTimeout` steps.
