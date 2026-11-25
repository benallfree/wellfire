# World layers: villages and roads in the seeded world

The endless world is a pure function of `SEED` and coordinates. Villages and roads join it as two more pure layers
stacked on the terrain, so the same seed gives the same settlements and routes wherever you walk, and nothing about
them is stored.

```
terrain(x, z)       hills, mountains, lakes, rivers           (the base layer)
settlement layer    site(gi, gj): one village or none per big cell
road layer          links(gi, gj): roads owned by a cell, each a bent polyline between two village edges
height(x, z)        base -> graded by nearby roads -> levelled by nearby villages
ground(x, z)        colour; road strips tinted dirt
```

## Settlement layer

The world is cut into **280×280-unit cells** (7 chunks), offset so the start sits in the middle of cell (0, 0).
`site(gi, gj)` asks `hash(gi, gj)` whether the cell holds a village (about 60%), then tries up to four jittered spots
in the middle 60% of the cell and keeps the first that is dry and gentle: eight samples on a ring just outside the
village, all above water, less than 6 units from lowest to highest. Rejection uses `terrain()`, the terrain before
villages and roads, so the test never depends on itself. A cell's answer also fixes the village's radius (12–18),
house count, name (two seeded syllables, e.g. "Thornwick") and seed for houses and townsfolk.

Cell (0, 0) always has a village: the old ring search 27–37 units from the start point, so a village is still in
sight when you begin. Jitter keeps villages at least ~110 units apart, so their circles never touch.

Any code can ask "which villages are near (x, z)" by calling `site()` for the 3×3 cells around it. Answers are
memoised in a small cache that is simply cleared when it grows large: they are pure, so rebuilding is always safe.

**Options weighed.** A per-chunk `hash < 0.01` (the README's earlier sketch) gives no control over spacing: villages
can land in neighbouring chunks or overlap, and roads then need a global search. Poisson-disc sampling spaces well
but needs either global state or a multi-pass tiling. A jittered coarse grid gives guaranteed spacing, a fixed
neighbourhood to look at, and one hash per cell. Chosen: the jittered grid.

## Road layer

Villages in neighbouring cells (8-neighbourhood) are joined when the pair passes a **relative-neighbourhood test**:
no third village C is closer to both of them than they are to each other (`max(|AC|, |BC|) < |AB|` rejects A–B).
This keeps the short, natural links, never crosses roads, and keeps the network connected among close villages. The
candidates for C come from the 5×5 cells around the pair's midpoint, a set both ends compute identically, so A and B
always agree whether their road exists.

Each road is **owned by one cell**: the one whose village is the "earlier" end (the other end lies east, south-west,
south or south-east). `links(gi, gj)` returns the roads a cell owns, always built in the same direction, so the
path's bends come out the same no matter which chunk asks. A point only needs the roads owned by the 5×5 cells
around it.

The path runs from A's fence to B's fence as a polyline with a vertex every ~16 units. Interior vertices are pushed
sideways by 1-D noise seeded from the road, scaled by `sin(πt)` so both ends leave the gates straight. Roads that
would run more than a quarter under water are dropped; shorter crossings become raised causeways (see grading).
Each vertex stores its grade height: the village's floor at the two ends, `max(base, water + 0.6)` in between.

The start point gets a short spur road to the home village, so the first thing you see leads somewhere.

**Options weighed.** "Link to the k nearest" is not symmetric (A picks B, B doesn't pick A); a union of both choices
fixes that but still crosses roads. Gradient-following or A* paths look best but cost far more code and CPU, and A*
across chunk seams needs state. A noise-bent polyline is a few lines, cheap to query, and identical from either end.
Chosen: relative-neighbourhood graph + noise-bent polylines.

## Height: one function, no seams

`height(x, z)` stays the single source of truth for terrain, colliders, actors, scenery and the minimap:

1. `h = terrain(x, z)`.
2. **Road grading:** find the nearest road segment; within the road's half-width (1.6) the height is the road's
   grade there (interpolated between vertices), blending back to `h` over 4 units with a smoothstep. This levels the
   road across its width and carries it over small water as a causeway.
3. **Village levelling:** within a village circle the height is the village floor, blending out over 8 units
   (the existing `flatten()`), applied after roads so a road meets the gate at the village's floor exactly.

Because every step is a pure function of `(x, z)`, two chunks sampling the same edge vertex get the same value, so
seams match as they already did. To keep it fast, each 40-unit chunk area gets a small cached context: the villages
and road segments that can reach it. `height()` does one map lookup and loops over a handful of segments.

Scenery skips road strips and village circles. Road strips are tinted dirt in `ground()`, which also colours the
minimap, so roads show on the map as soon as their cells are revealed. No signposts yet: the fence gates line up with
the roads, which reads well enough, and a signpost model would cost bytes for little play.

## Villages streamed with chunks

Building a village (houses, rooms, fence, well, townsfolk) happens when the player comes within 150 units of its
centre; it is disposed of (meshes, materials, actors) past 200 units, unless the player is inside one of its rooms.
One shared collider walks the built villages: monsters are pushed out of every village circle and drop the chase
inside one, the player stows the weapon in any village, and spawning avoids every site (a pure query, built or not).
Fence gates face the roads that leave the village (or one seeded direction for a village with none).

## What is remembered

Nothing new. The minimap's revealed-cell set `seen` is still the only growing state: a village appears on the map
(its circle and name) once its centre cell is revealed, and roads appear with the ground they cross. Site, road and
chunk-context caches are bounded and rebuilt from the seed on demand.
