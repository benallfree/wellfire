# Set pieces: interiors, dungeons, far objects, titles

Techniques for the bigger moments, each built from the same parts (models, actors, `height`, blockers) without a second
scene or a loader. Wellfire: `src/game.js` sections `villages`, `caves`, `beacons`, and the title code after `frame()`.

## A village from a seed

`build(T)` for a site `T = { x, z, y, r, seed, k }` (streamed: built within 150 units, disposed past 200):

- `VR = rng(T.seed)`; collect compiled models in a `parts` list for disposal.
- **Gates** wherever a road leaves (angle from the centre to the road's end vertex), or one seeded gate if none;
  `gap(angle, width)` tests whether an angle is in a gate.
- Plaza and well at the centre; dirt paths (a scaled `path` model) from each gate and to each door.
- **Houses** evenly round the square (`5 + (r - 12) / 2` of them), jittered, skipping gate paths, doors facing the well
  (`ry = atan2(T.x - x, T.z - z)`), each a seeded `house` model whose size comes back in its vars.
- **Fence**: one `InstancedMesh` of a baked fence section round the ring, skipping the gates.
- **Townsfolk**: the warrior's skeleton in seeded clothes (`villager`), strolling between door spots and the well,
  stopping to idle. Within talk range the nearest stops and turns to you; Space opens a dialog box (game paused). Roles
  and lines come from `models.json` (`talk`), with `@` replaced by a village name.
- One shared **blocker** walks the built villages: monsters are pushed out of every ring and drop the chase inside;
  houses are boxes (`box(x, z, cx, cz, hw, hd, ry)` pushes a point out of a turned box along the shorter axis). Weapons
  are stowed inside any village (slung on the back, aimed by the item's own shape).
- No new model features were needed: solid house shells and separate rooms meant no hollow boxes or door cut-outs; a
  door is a dark box, a gable an `ext` triangle, a roof slope a box whose angle is an expression.

## Interiors: fade, warp, cutaway

Options weighed: a separate streamed map behind a load door, a lifting roof (needs real interiors inside every shell
and a wall-aware camera), or a cutaway room. Chosen: **a door warp with a fade to black into a cutaway room built
underneath the house** (40 + 15·i units below the ground, where the terrain hides it).

```js
const veil = document.createElement('div')
veil.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .25s'
document.body.appendChild(veil)
let fading = 0
const fade = (fn) => {
  if (fading) return
  fading = 1
  veil.style.opacity = 1
  setTimeout(() => (fn(), (veil.style.opacity = 0), setTimeout(() => (fading = 0), 300)), 260)
}
```

- Same scene, renderer and `Actor` movement; the actor's `floor` is the room's floor. Inside: a fixed camera looks in
  over a low front wall (no occlusion code), the sky goes black, the sun off, the hearth's point light on, fog off.
- Doors open **on foot only** (a flying rider over a doorstep once entered a room mounted and crashed the game).
- Walking back out of the door reverses it and snaps the chase camera behind the hero.

## See-through occluders

A house between the camera and the player fades to 25% opacity: project the house centre onto the camera→player
segment; if the closest point is before the player (`t < 0.98`) and within the house's half-size + 0.6, ease the
material's opacity toward 0.25, else back to 1 (`opacity += (target - opacity) * dt * 8`). Each house has its own
material with `transparent = true`.

## Seeded maze dungeons

Caves are built `depth` (80) units below their entrance, so the world above carries on unseen.

- **Maze**: a perfect maze on a `size × size` grid (6×6) of `cell`-unit cells (5), by recursive backtracker
  (`rng(T.seed + 77)`): a stack, random unvisited neighbour, record openings as bits per cell (1 east, 2 south) on the
  lower-indexed cell. Full of dead ends; the same every visit.
- **Far end**: breadth-first search from the mouth cell; the last cell dequeued is the farthest. Keep the `from` map:
  the cell before it is where the guard packs in.
- **Walls**: panels between grid corners that **stop 0.3 short of each corner, with a 0.6 post on every corner a panel
  touches**. Overlapping boxes left coplanar faces that z-fought at every joint. Walls are `[x, z, halfW, halfD]` boxes,
  used for collision (a blocker), line of sight (`clear()`) and keeping the first-person camera off them.
- **Textures without assets**: `rock(colour)` draws a 64-px canvas (base colour, 40 soft patches at 25% alpha, 500 grit
  flecks, 6 hairline cracks), as a `CanvasTexture` with `RepeatWrapping` and `SRGBColorSpace`. `slab(w, h, d)` is a
  `BoxGeometry` whose UVs are scaled per face so the texture tiles every 2 units instead of stretching. One floor
  sheet and one roof sheet over the whole maze.
- **The way out**: a plane beyond the mouth with vertex colours (sky above, ground below) in an unfogged basic
  material, lerped from day glare to moonlit blue, plus a point light spilling in.
- **Inside**: the surface's creatures are recycled away; nothing spawns; dwellers stand on the cave floor with
  `fits: () => 1`; the treasure's guard must all die before it can be taken; taking it wakes every creature left.
  First person always; no minimap; a light that's only your torch. Leaving disposes of the cave's geometry and puts
  the player a few steps outside the mouth (not on it, or you walk straight back in), facing home.

## Far objects drawn near

Beams from five far villages must show from anywhere, but the camera's far plane is 200. Draw each beam **moved toward
the camera and shrunk by the same factor**: `s = min(1, 12 / distance)`, `position = lerp(camera, base, s)`, scale by
`s`; the picture is unchanged (same angle subtended) but it fits inside the frustum. Fatten with distance
(`max(1, d / 80)`) so it stays visible. The star is drawn at `camera + direction * 150` (a direction, as if infinitely
far), and a locked beam runs to the star's drawn position so its tip sits on it from every viewpoint. Basic materials,
`fog: false`, `depthWrite: false`, transparent. The full model at the base only within 150 units (disposed past 170).

## Aiming at a direction

The goal is to point beams at a seeded star (azimuth and elevation from `hash`). The camera stands behind the beam's
base and looks along it; A/D turn, W/S tilt, the locked mouse tilts. Within a lock zone (~7°, 0.12 rad) the beam snaps
exactly onto the target, turns gold, chimes and stays locked. Store `[azimuth, polar angle, locked]` per site; a saved
beam inside the zone locks on load.

## Titles and endings without assets

- **Voxel text**: draw the word into a small 2D canvas (`font = '900 13px serif'`), read `getImageData`, and place
  one instanced box per pixel whose alpha > 99, coloured by row (`setHSL(0.15 - y * 0.011, 1, 0.55)`).
- **Flame**: 12 additive-blended cones (`ConeGeometry(0.9, 1, 5)`, `AdditiveBlending`, `depthWrite: false`) whose
  heights flicker with sines, spinning, plus particle sparks.
- **End screen**: an HTML box listing what the player did (places in order, gold, kills, distance), with a light show
  first: beams pulse and cycle hue, the star swells, the sky flushes, sparks burst.
