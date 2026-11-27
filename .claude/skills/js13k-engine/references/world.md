# A seeded, endless world

There is no edge and no stored map. The world is a **pure function of `SEED` and coordinates**: any place regenerates
identically on every visit and every page load. Only player changes are stored (save.md). Wellfire: `src/game.js`
sections `world` and `settlements and roads`; design notes in `docs/world-layers.md`.

```
terrain(x, z)       base: warp, hills, knolls, ridged mountains, lake basins, rivers   (pure, the base layer)
shore(h)            depth remap: a wading shelf, then a drop-off                          (pointwise, seam-safe)
site(gi, gj)        settlement layer: one village or none per 280-unit cell              (memoised)
links(gi, gj)       road layer: roads owned by a cell, noise-bent polylines              (memoised)
shape(cx, cz)       per-chunk context: villages and road segments that can reach it      (memoised)
height(x, z)        shore(terrain) -> graded across roads -> levelled under villages     (the single truth)
ground(c, x, z)     colour: road dirt, sand, foam, grass blends, dirt, rock, snow        (terrain and minimap)
region(x, z)        meadow / forest / rocky hills / lakes, from two slow fields
```

## Randomness

```js
// integer hash: exact at any coordinate (a sin() hash loses precision far out)
const hash = (x, z, s) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1) ^ Math.imul(s, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
// value noise: corner hashes blended with a smoothstep
const noise = (x, z, s) => {
  const ix = Math.floor(x), iz = Math.floor(z)
  let fx = x - ix, fz = z - iz
  fx *= fx * (3 - 2 * fx)
  fz *= fz * (3 - 2 * fz)
  const a = hash(ix, iz, s), b = hash(ix + 1, iz, s), c = hash(ix, iz + 1, s), d = hash(ix + 1, iz + 1, s)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
const smooth = (a, b, v) => ((v = Math.min(1, Math.max(0, (v - a) / (b - a)))), v * v * (3 - 2 * v)) // a > b runs backwards
// fBm: each octave twice as fine, half as strong, and turned ~37° so nothing lines up with the grid
const fbm = (x, z, s, o = 4) => {
  let t = 0, a = 0.5
  for (let i = 0; i < o; i++, [x, z] = [x * 1.6 - z * 1.2, x * 1.2 + z * 1.6], a /= 2) t += noise(x, z, s + i) * a
  return t / (1 - 2 * a)
}
```

- **Give every layer its own seed offset** (`SEED + 1` wet, `SEED + 2` rough, `SEED + 4` chunk scenery, `SEED + 5`
  sites…). Write the offsets down in comments; reusing one couples two layers.
- **`hash(x, z) == hash(-x, -z)` for odd x and z** with this mixer. Anything keyed by cell coordinates that must
  differ between mirror cells (village sites, herd rolls) goes through `h2 = (i, j, s) => hash(i * 2, j * 2 + 1, s)`.
- Per-thing generators: `rng((hash(cx, cz, SEED + 4) * 4294967296) | 0)` gives a mulberry32 stream for one chunk,
  village or cave.
- **Draw a fixed number of random values per candidate**, whether or not anything is placed there. Then a skipped
  candidate (felled, in a village, under water) never shifts what comes after it, and results never depend on build
  order. When adding a draw to an existing generator, add it in a way that keeps old draws in place (or accept that
  the world changes, and say so in the commit).

## Memoising pure layers

```js
const memo = (f, max = 3000, m = new Map()) => (...a) => {
  const k = a.join()
  if (!m.has(k)) {
    if (m.size > max) m.clear() // pure answers: rebuilding is always safe
    m.set(k, f(...a))
  }
  return m.get(k)
}
```

Plus a one-entry cache for the hottest lookup (the chunk context of the last point asked about), since neighbouring
samples share it.

## Regions

Two slow fields pick a region, each about a quarter of the world:

```js
const wet = (x, z) => noise(x * 0.004, z * 0.004, SEED + 1)
const rough = (x, z) => noise(x * 0.003, z * 0.003, SEED + 2)
const region = (x, z) => (wet(x, z) > 0.66 ? 3 : rough(x, z) > 0.58 ? 2 : wet(x, z) > 0.47 ? 1 : 0) // meadow, forest, rocky hills, lakes
```

Regions drive flora, creature mix, crowd size, pay, mount kinds and ground tint, all from small per-region tables
(`FLORA`, `FOES`, `CROWD`, `PAY`, `MOUNTS`).

## Terrain layers

All cheap value-noise math, in `terrain(x, z)`:

1. **Domain warp**: sample at `u = x + (noise(x*.01, z*.01, S+20) - .5) * 70` (and `v` likewise) so features don't line
   up with the grid.
2. **Rolling hills**: 4-octave fBm at 0.012, amplitude by region (±5 meadow, ±7 forest, more in the highlands).
3. **Knolls**: 2 octaves at 0.035, ±5. Small enough to read from a close follow camera; big hills alone looked flat.
4. **Mountain ranges**: where `rough` is high, a highland mask fades in 3 octaves of ridged noise
   (`n = 1 - |2·noise - 1|`, then `n²`), up to ~40 units.
5. **Lake basins**: where `wet` is high, sink up to 9 units.
6. **Rivers**: where a very slow, separately warped noise crosses 0.5, carve a narrow band below the water
   (`smooth(0.01, 0.07, |noise - 0.5|)` as the river mask). They wind for kilometres through lowlands, never across
   mountains, and join lakes. **Fords**: where another slow noise is high, the river bed rises to just under the
   surface so mounts (which won't wade deep) can cross.
7. **A safe start**: within ~150 units of the origin, fade out lakes and rivers (`near = smooth(160, 90, d)`); fade
   mountains in from 35 to 90 units; flatten hills on a pad within 10-35 units. Then search outward on a spiral for the
   first dry point as `home`.

Measured over 6×6 km: 64% of land under slope 0.3, 35% 0.3-1, nothing over 1.5, heights −10 to 40, water ~35%.

**Shore shaping** after terrain, pointwise on depth below `WATER`: `d * (0.7 + smooth(0.8, 2.5, d) * 1.5)`. The first
~0.8 units become a wading shelf, then the bed drops off to ~2.5× its base depth: walking out goes ankle, knee, waist,
then swimming. It's pure in the base height, so seam-safe and nearly free.

## Settlements and roads

- **Jittered coarse grid**: 280-unit cells centred on `home`. `site(gi, gj)` (memoised, seeded by `h2`): ~60% of
  cells hold a village; try up to 4 jittered spots in the middle 60% of the cell; keep the first that is dry and
  gentle (8 samples on a ring at the village radius; any sample below `WATER + 1` rules the spot out; less than 6 units from low to high).
  **Test against `terrain()`, not `height()`**, so the test never depends on itself. Cell (0, 0) always has one,
  27-37 units from the start, so a village is in sight at once. The site also fixes radius (12-18), name and a seed
  for houses and townsfolk. Jitter keeps villages ~110+ units apart. (Rejected: per-chunk `hash < p`, which can't
  control spacing; Poisson discs, which need global state.)
- **Names from the cell alone**: each name part steps along its list by a fixed stride per cell
  (`l[((gi * a + gj * b) % n + n) % n]`; Wellfire's strides are 19/20, 4/6 and 22/21 on lists of 24, 8 and 24), chosen so
  the whole name doesn't repeat within 24 cells either way and neighbours never share a part. Lists live in `models.json`. Random syllables repeated a lot.
- **Roads: a relative-neighbourhood graph.** Join villages in neighbouring cells (8-neighbourhood) unless a third
  village C is closer to both ends than they are to each other. Candidates for C come from the 5×5 cells round the
  pair's midpoint, a set both ends compute identically, so both agree the road exists. Short, natural links, no
  crossings. (Rejected: k-nearest, which is asymmetric and crosses; A*, too much code and state across seams.)
- **Each road is owned by one cell** (the "earlier" end: the other lies E, SW, S or SE), always built in the same
  direction, so its bends come out the same whichever chunk asks.
- **Path**: a polyline from fence to fence with a vertex every ~16 units, pushed sideways by 1-D noise scaled by
  `sin(πt)` so both ends leave the gates straight. Each vertex stores its grade (the village floor at the ends,
  `max(WATER + 0.6, terrain)` between: causeways over shallow water). Drop roads more than a quarter under water. Add
  a short spur from the start to the first village.

## One height function

```js
function height(x, z) {
  const [d, y] = road(x, z) // distance to the nearest road centre line, and the road's grade there
  let h = y + (shore(terrain(x, z)) - y) * smooth(RW, RW + 4, d) // graded level across roads, blending back over 4 units
  for (const t of at(x, z).towns) h = t.y + (h - t.y) * smooth(t.r, t.r + 8, Math.hypot(x - t.x, z - t.z)) // levelled under villages
  return h
}
```

- Every step is pure in (x, z), so two chunks sampling the same edge vertex agree exactly: **zero seam difference**,
  checked on thousands of shared vertices including under roads and water.
- `at(x, z)` returns the memoised context of the 40-unit chunk area (villages and road segments within reach), so
  `height()` is a map lookup plus a short loop: under 0.3 µs on a chunk's vertex grid, ~3 µs on scattered points (1 µs for bare terrain).
- Villages level *after* roads, so a road meets the gate at the village floor.
- `slope(x, z) = [h(x+1) - h(x-1), h(z+1) - h(z-1)]`: the same everywhere, so colours match across seams.
- `depth(x, z) = max(0, WATER - height)`; swimming starts at depth 1 (`SWIM = WATER - 1`).

## Ground colour

`ground(c, x, z, h, slope)` sets a `THREE.Color`, shared by the terrain mesh and the minimap:

- road strips (`road(x, z)[0] < RW`): dirt;
- under water: `sea(c, depth)`, a teal-to-navy lerp by depth, blended toward sand in the shallows; a pale foam band at
  the waterline; sand just above;
- grass blending meadow green → dark forest green (`smooth(.43, .5, wet)`) → dry highland olive (`smooth(.5, .6,
  rough)`), so region borders don't show as hard edges;
- dirt on slopes over ~0.4, rock on slopes over ~0.65 or above ~20 units, snow above ~30 unless steep;
- a small noise `n` wobbles every boundary so none is a contour line.

**Baked hillshade**: the follow camera looks steeply down, and three.js lighting barely shades gentle slopes, so
multiply each vertex colour by `clamp(1 - gx*0.7 - gz*0.35, 0.6, 1.3)` (lit from the sun's side).

## Water

One flat, 60%-opaque plane (600×600) that follows the player at `WATER`: the level is the same everywhere, so one mesh
does it. The bed tint shows through, so depth reads. Water colour on the minimap uses the same `sea()`.

## Scale and feel

- Chunks 40 units, villages every ~280, caves 40-200 units from their village, fog to ~110 by day.
- Gentler near home: crowd and creature fierceness ramp from ~35% and 0.5 at home to full ~400 units out
  (`models.json` `wilds`), so starting over after a fall isn't a swarm.
- Pay rises with distance from the nearest village fence; tougher regions pay more.
