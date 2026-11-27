# Wellfire

**Play:** https://benallfree.github.io/wellfire/

A small js13k-style three.js action game: a warrior roams an endless seeded world of meadows, forests, rocky hills
and lakes, fights slimes, goblins, spiders, bats and eels, rides steeds, drakes and a roc, rows a boat, and relights the
beacons on five villages' wells to blind the star that watches from the sky.

The experiment behind it: what if js13k measured entries with [surprisal](https://github.com/benallfree/surprisal), a
language-model compressor, instead of zip? Then readable source *is* the compact form, so nothing is minified or
mangled, and every model, animation and song is plain text compiled in the page at load. The game is checked against the
13,312-byte budget under surprisal and against the best conventional pipeline (terser, roadroller, Zopfli zip).

| | |
|---|---|
| ![A lit torch swing at night: flame bits and a burning slime](docs/night-fight.jpg) | ![Rowing at night with the torch in the bow post](docs/boat-torch-night.jpg) |

<sub>Screenshots are from earlier builds; the HUD and help line have changed since.</sub>

## Quick start

```bash
npm install
npm start           # builds dist/index.html and serves it at http://127.0.0.1:8713 (PORT to change)
npm run ship        # build, js13k baseline, then surprisal -3 --compare against the budget
npm run ship -- -6  # the same at another surprisal level (-0..-9)
npm run baseline    # build and pack the baseline only: terser -> roadroller -> advzip
```

three.js comes from a pinned CDN, so you need a network connection. The baseline needs `advzip`
(`brew install advancecomp`). `ship` uses `/Volumes/Code/repos/surprisal/bin/surprisal` unless `SURPRISAL` points
elsewhere. `/tools/viewer.html` (dev only) shows any model, seed, clip or held item, e.g.
`?m=goblin&seeds=1,2,3&clip=walk`, and the page exposes `window.game` for the console.

## Controls

| key | does |
|---|---|
| W/S or ↑/↓ | walk forward and back (on a mount: run and back up; holding a beam: tilt it) |
| A/D or ←/→ | turn; in first person, strafe |
| C | toggle first person. Click to lock the mouse: it then looks around and a click attacks; Esc lets go. Caves are always first person |
| Space or J | use what's in hand: swing a weapon, drink a potion, blow the whistle, throw wood, flint or the boat; at a well, set or take the beam |
| F or Tab | swap to the next item |
| 1–8 | pick a tray slot (sword, axe, torch, wood, flint, boat, potion, whistle) |
| 0 | crafting (in a village) |
| R | ride or leave a mount, board or leave the boat, let go of a beam |
| N | the big map (Esc closes it) |
| M or ♪ | sound on and off |

On a touch screen: drag anywhere (up/down walks, sideways turns), the HIT, SWAP and RIDE buttons, and tap a tray slot.

## The game

- **Getting by.** Health comes back in villages, not in the wilds; out there you eat berries from bushes (a tenth of
  your health, regrowing in 4 minutes) or drink potions. Kills spill gold; swinging the axe fells trees for wood and
  breaks rocks for coins and, rarely, flint. In a village you craft: a torch from a wood and a flint, plus wood,
  flint, a boat, potions and the roc's whistle for gold and wood. Townsfolk talk.
- **Night.** A 3-minute day. Nights are near-black, so the torch matters: lit, it lights the way, sets monsters
  alight and scares slimes and spiders back (bats are drawn to it), and it burns down.
- **Caves.** Each village has a cave out in its wilds, sealed by a boulder that takes 8 axe blows. Inside, with a lit
  torch, is a seeded 6×6 maze of dead ends with roamers, and in its farthest cell a sunstone guarded by six
  creatures and a boss. The sunstone is yours once the whole guard is dead. A village's sage says where its cave is.
- **Wells and beams.** At a village well, Space sets a torch and a sunstone in its beacon and hands you the beam: turn
  and tilt it until it snaps gold onto the star. A `✦` on the minimap rim shows the star's way.
- **Sky stages.** Each locked beam turns the sky a new colour (green, violet, orange, red) and makes the wilds harder:
  tougher, faster, keener creatures in bigger crowds, paying more gold. Caves add one guard and one roamer per locked
  beam.
- **Near home** (Oakdale, where you start and wake after a fall) the wilds are thinner and tamer, ramping to full
  strength 400 units out.
- **Getting around.** Steeds and drakes roam the wilds to be ridden (a drake breathes fire); the boat crosses water;
  the whistle calls a roc that flies high and fast on its stamina, out of every creature's reach, and leaves after
  each flight.
- **The end.** Five beams on the star start a light show and the end screen; the world goes on after.

Progress (the map, felled trees and rocks, opened caves, sunstones, beams, the bag) is saved in `localStorage`.

## How it's built

- **Models are text.** `src/models.json` holds every model, skeleton and animation clip as pretty-printed JSON:
  primitives (box, ball, cylinder, lathe, extrude) on bones, with mirroring, seeded ranges and picks, so each creature
  block is a generator of endless variants. `src/compiler.js` turns them into rigged three.js meshes at load (one
  merged mesh per bone, no skinning). Gameplay tuning lives in the same file: `health`, `stages`, `wilds`, `rocks`,
  `berrybush`, `caves`, `tray` (slots and recipes), `talk`.
- **Music is text too.** `src/score.json` is compiled and synthesized with WebAudio by `src/music.js`. There are no
  binary assets: no textures, meshes or audio files.
- **One file.** `tools/build.mjs` concatenates `compiler.js`, `music.js` and `game.js`, strips comments
  (`tools/strip.mjs`; they stay in the source), and inlines both JSON files into `dist/index.html`.
- **Data as pretty JSON**, not a custom DSL: it packs smaller under surprisal despite being bigger raw
  ([docs/json-vs-dsl.md](docs/json-vs-dsl.md)).
- **Build tag.** The build stamps its commit (plus `+` for uncommitted changes in `src/`) in the page's bottom-right
  corner, to tell a cached page from the latest.
- three.js r170 (`three@0.170.0`) loads from jsDelivr through a pinned import map and doesn't count toward the budget.

## Size

Last measured on `main` at `ee8a327` with `npm run ship -- -6`:

| pipeline | bytes | of 13,312 |
|---|---:|---:|
| surprisal `-6` (`dist/index.13k`) | **13,090** | 98.3% |
| terser + roadroller + advzip (`dist/roadroller/index.zip`) | 38,099 | 286% |

To re-measure, run `npm run ship` (level `-3`) or `npm run ship -- -N` for level N. The surprisal step takes a few
minutes on the GPU; the baseline about 15 seconds. `ROADROLLER_O` and `ADVZIP_ITER` tune the baseline. `npm run size`
prints a fuller report across formats.

## Deploy

`.github/workflows/pages.yml` builds `dist/` and publishes it to GitHub Pages on every push to `main` (or by hand via
workflow dispatch). The deploy step occasionally fails on GitHub's side with "No artifacts named github-pages";
re-running the job fixes it.

## History

[docs/postmortem.md](docs/postmortem.md) is the full development journal: every feature as it was built, the design
choices and the experiments, with costs and measurements as they were at the time. Related write-ups:
[json-vs-dsl](docs/json-vs-dsl.md), [refactor-size](docs/refactor-size.md), [goal-ideas](docs/goal-ideas.md),
[world-layers](docs/world-layers.md).
