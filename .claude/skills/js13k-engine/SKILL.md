---
name: js13k-engine
description: How to build a js13k-style browser game and its engine from scratch when the size measure is surprisal (an LLM compressor), using what the Wellfire 3D game learned. Use when starting a new js13k game, adding an engine system (seeded endless terrain, chunk streaming, instanced scenery, text models compiled to three.js rigs, actors with collision, chase or first-person camera, input, minimap, HUD, save, synthesized music), deciding where data lives, or deciding whether a refactor or an engine split is worth its bytes. Also use before measuring size or proposing size cuts.
---

# js13k engine: build it fresh, the surprisal way

This skill is a **recipe book, not a library.** It describes an engine and game architecture that worked (Wellfire: a
3D third-person action game with an endless seeded world, rigged creatures, villages, caves, mounts and music, in one
HTML file under a 13,312-byte budget) and the lessons that keep it small. You write the engine inline, in the game's
own names, every time. Do not extract a shared library: a measured engine split cost bytes and bought nothing for the
shipped page (see "Why no library" below).

## The one idea

Surprisal charges for what a language model can't predict, not for raw bytes. So:

- **Write the most ordinary, readable, conventional code and data.** Real names (`player`, `height`, `Math.hypot`),
  normal whitespace, idiomatic three.js. Readable source *is* the compact form.
- **Comments are free**: the build strips them. Write as many as help; they never ship.
- **Data is pretty JSON with named keys** (`JSON.stringify(x, null, 2)`). It beat a custom DSL, minified JSON and YAML.
- **Never minify, mangle, golf or refactor for size.** Every measured attempt made the output bigger or broke even.
- **Spend the budget on content**: the lever is which features ship, not squeezing.

The numbers behind each rule are in [references/compression.md](references/compression.md). Read it before any size
work.

## How to use this skill

1. **Starting a game:** read this file, then [references/build-and-ship.md](references/build-and-ship.md) (the
   one-file build, comment stripping, size tooling) and [references/models.md](references/models.md) (the
   text-model "language + JIT"). Set up the build and a model compiler first; everything else hangs off them.
2. **Adding a system:** open the matching reference below. Each gives the design, the parameters that worked, a short
   code sketch of the pattern, the pitfalls we hit, and where Wellfire does it (`src/game.js` section headers are
   `// ---------- name ----------`, so search for them).
3. **Write it inline** in the game's single code file (or a few files the build concatenates), at the place it's used.
   Don't add factories, hook objects or wrapper modules for reuse.
4. **Verify in the browser** through a `window.game` debug handle (see [references/process.md](references/process.md)):
   determinism, seams, memory, frame time, no console errors.
5. **Measure only when asked**, at the level asked, with the commands in
   [references/build-and-ship.md](references/build-and-ship.md). Never pipe surprisal's live output.

## Reference index

| file | covers |
|---|---|
| [compression.md](references/compression.md) | every surprisal measurement: per-byte costs, what helped, what hurt, how to estimate, how to measure |
| [build-and-ship.md](references/build-and-ship.md) | one HTML file, concatenation, comment stripping, three.js from a CDN, build ID, debug handle, `ship` / `fit` / `baseline`, budget config, serve, deploy |
| [models.md](references/models.md) | the JSON model format (vars, bones, parts, holds, clips, mirroring, repeat, chance, expressions), the compiler, posing, baking for instancing, sockets, self-lit colours, gameplay data in models, icons rendered from models, dev viewer, IK-generated clips |
| [world.md](references/world.md) | seeded endless terrain: integer hash, value noise, fBm, domain warp, regions, ridges, lakes, rivers, shore shaping, safe start, settlement grid, road graph, one `height()`, ground colour and hillshade, water |
| [chunks-and-scenery.md](references/chunks-and-scenery.md) | chunk streaming, deterministic per-chunk content, shared InstancedMesh pools, colliders, player changes to a generated world (felled trees, broken rocks), per-chunk rolls, things that leave with their chunk, streaming bigger set pieces |
| [actors-and-ai.md](references/actors-and-ai.md) | the Actor (rigged model + movement + collision + animation), habitats, blockers, gait, one-shot clips and hit timing, hurt and knockback, monster AI, spawning and crowd scaling, health bars, particles, drops and pickups, mounts |
| [camera-input-hud.md](references/camera-input-hud.md) | chase camera, first person, pointer lock, keyboard and touch stick, day/night lighting and fog, torch light, the DOM HUD, toasts and dialog boxes, tray icons, fog-of-war minimap and big map, the hint line, title screen |
| [audio.md](references/audio.md) | music as a JSON score compiled to WebAudio (chord tracks, synthesized instruments, lookahead sequencer, day/night and monster parts) and one-line sound effects |
| [save.md](references/save.md) | localStorage wrapped with read-back, what to store (only what can't be derived), keyed change sets with expiry, compact formats, throttled saves, migrations |
| [set-pieces.md](references/set-pieces.md) | interiors as a fade-and-warp into a cutaway room underground, seeded maze dungeons, procedural canvas textures, see-through occluders, far objects drawn near (beams to a star), voxel text titles |
| [process.md](references/process.md) | how to work: verification in the browser, determinism and memory checks, commit messages with raw byte deltas, measuring etiquette, what to write down |
| [pitfalls.md](references/pitfalls.md) | every bug that cost us time, with the rule it taught |

## Architecture at a glance

```
src/index.html    page shell: CSS, HUD markup, import map for three.js, placeholders the build fills
src/models.json   every model, skeleton and clip, plus tuning tables (pretty JSON, named keys)
src/score.json    the music (pretty JSON; note patterns as strings)
src/compiler.js   model JSON -> three.js rigs (~230 lines: shapes, transforms, mirroring, bones, clips, bake)
src/music.js      score JSON -> WebAudio (instruments, sequencer, jukebox)
src/game.js       everything else, in sections: renderer -> world -> chunks -> actors -> HUD -> minimap ->
                  player -> creatures -> villages -> particles -> drops -> goals -> sound -> input -> combat -> loop
tools/build.mjs   strips comments, concatenates the JS, inlines the JSON: dist/index.html (the shipped file)
tools/strip.mjs   the comment stripper (string, template and regex aware)
tools/ship.mjs, fit.mjs, roadroll.mjs, serve.mjs   size checks, the js13k baseline, a static server
```

- **No binary assets anywhere.** Models are text, compiled at load. Music is text, synthesized. Textures (if any) are
  drawn into canvases in code. Icons are rendered from the models at startup.
- **three.js comes from a CDN** through a pinned import map and doesn't count. Lean on it hard: its primitive
  geometries, lathe, extrude, merging and instancing are what keep the model compiler tiny.
- **The world is a pure function of a seed and coordinates.** Nothing generated is stored; only player changes are.
- **One `height(x, z)`** is the single truth for ground, colliders, actors, scenery, drops, camera and minimap.
- **One frame loop** (`frame()`) runs input, player, creatures, effects, lighting, music mood, camera, streaming,
  minimap, then renders. Systems are plain functions it calls in order.

## Rules for writing the engine

These are the habits that kept Wellfire predictable for the compressor and easy for an agent to extend:

- **Section headers and lots of comments.** `// ---------- villages: houses round a square ... ----------` then the
  why of each block. They're stripped; they're how the next agent finds its way.
- **Pure functions for anything generated** (`terrain`, `site`, `links`, `shape`, `den`): same input, same output, so
  they can be memoised with a cache that's simply cleared when it grows, and chunk seams match.
- **Tuning numbers in `models.json`** when a designer would tweak them (`wilds`, `rocks`, `caves`, `stages`, `hints`,
  `talk`, `health`), as named keys. Small fixed tables can stay in code: moving data between JS and JSON nets about
  zero bytes, so put it where it reads best.
- **Gameplay data on the model** (`"dmg": 6`, `"reach": 2.3`, `"anim": "chop"`, `"gold": 2`): an item or creature is
  defined by its block, and the code reads `m.vars`.
- **Plain module state and plain functions.** `let gold`, `const foes = []`, `function spawn()`. Classes only where
  there are many instances with behaviour (Wellfire has one: `Actor`).
- **Mutate three.js objects in place** and reuse scratch vectors and colours (`const fwd = new THREE.Vector3()`); clamp
  `dt` to 0.05.
- **Dispose of what you build** when it leaves: geometries and per-instance materials of despawned actors, replaced
  props, unloaded chunks, left dungeons. Check `renderer.info.memory` (see process.md).
- **Ship the debug handle only if you accept ~58 bytes**; otherwise cut it from the shipped build (build-and-ship.md).

## Why no library

Measured on Wellfire at surprisal -1 (2026-11-27, root `docs/surprisal-3d-warrior/engine-split.md`):

| build | raw | -1 | delta |
|---|---:|---:|---:|
| one file, written inline (main) | 294,428 | 17,796 | |
| engine modules behind factory APIs (`chunker({...})`, `actors({...})`) | +791 | 17,911 | **+115** |
| same split, "fragment style" (engine files are top-level code calling game names) | +95 | 17,854 | **+58** |

The factory plumbing (hook objects, parameter lists, destructured returns) is all identifiers, about 0.15 compressed
bytes per raw byte, twice ordinary code. Even with no plumbing, moving code away from where it's used costs a little.
A skill costs the page nothing: the agent reads it and writes the code in place.

## Checklists

**New game:**
- [ ] `index.html` shell with an import map pinning three.js, `<!--MODELS-->`, `<!--SCORE-->`, `<!--CODE-->` slots
- [ ] `tools/build.mjs` + `tools/strip.mjs`; build ID in a corner; `npm start` = build + serve
- [ ] `package.json` `"size": { "level", "headroom", "budget": 13312 }`, `ship` and `fit` scripts
- [ ] model compiler + one model + `viewer.html`; seeded `rng`
- [ ] renderer, scene, hemisphere + shadowed sun following the player, fog, resize
- [ ] `height(x, z)`; chunks; one actor that walks on it; chase camera; keyboard + touch
- [ ] `kept`/`keep` save helpers; `window.game` debug handle
- [ ] audio unlocked on the first gesture; mute remembered

**New system:**
- [ ] Pure where it can be (seeded, memoised); state only for player changes
- [ ] Tuning in `models.json` with named keys if someone will tweak it
- [ ] Section header and comments
- [ ] Disposes of what it creates; bounded caches
- [ ] Checked in the browser: works, deterministic, no leak, no console errors
- [ ] Raw byte delta in the commit message (estimate compressed at ~0.07/byte for code, ~0.015-0.05 for JSON)

**Before proposing size cuts:** read compression.md. Cut features (they're the only lever), not names or structure.
