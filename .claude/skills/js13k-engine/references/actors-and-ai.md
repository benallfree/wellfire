# Actors, combat and creature AI

## The Actor

One class for the player, monsters, mounts and townsfolk: a compiled model plus movement, collision and animation
state. Wellfire: `src/game.js` section `actors`.

```js
class Actor {
  constructor(kind, seed) {
    this.kind = kind
    this.seed = seed
    this.m = make(lib, kind, seed)
    this.g = new THREE.Group()
    this.g.add(this.m.root)
    scene.add(this.g)
    this.pos = this.g.position
    this.vel = new THREE.Vector2() // knockback
    this.dir = 0                   // facing, radians (atan2(dx, dz) convention: 0 faces +z)
    this.speed = 0
    this.time = this.step = 0      // step: the gait's phase, advanced at the current speed
    this.once = null               // a one-shot clip: [name, t]
    this.hp = this.maxHp = 1
    this.flash = 0
    this.burn = 0
  }
  play(name) { if (this.m.clips[name]) this.once = [name, 0] }
  get busy() { return this.once && this.once[1] < this.m.clips[this.once[0]].d }
  move(dx, dz, dt) { /* below */ }
  update(dt, run) { /* below */ }
}
```

### Movement and collision: `move(dx, dz, dt)`

1. Flying (`alt > 3`) skips everything below except the medium test.
2. Scale by the ground: wading slows up to ~45% (`1 - min(0.45, depth * 0.4)`), not while swimming.
3. Add knockback: `x += vel.x * dt`.
4. **Circle colliders**: for each collider list in `around(x, z)`, for each `[tx, tz, r]`, if the point is within
   `r + 0.4` push it out to that distance along the line from the centre. Order-dependent but stable enough at
   game speeds.
5. **Blockers**: a list of functions `(x, z, actor) => [x, z]` run in order. Villages push monsters out of every ring;
   mounts refuse deep water; cave walls are boxes. New systems add a blocker instead of touching `move`.
6. **Habitat**: `actor.fits(groundHeight)` (land creatures `h > WATER - 0.25`, eels deep water only, bats anything).
   If the new spot doesn't fit, slide along the edge (keep the old z, else the old x, else stay put), zero the
   knockback and set `stuck`, so AI can pick a new heading. No code path can push a creature into the wrong medium,
   knockback included.
7. Decay knockback: `vel *= max(0, 1 - dt * 6)`.

### Animation and placement: `update(dt, run)`

```js
this.time += dt
if (this.once) this.once[1] += dt
const k = this.seat ? 0 : Math.min(1, this.speed / run)
this.step += dt * (this.swim ? 0.6 + k * 0.6 : Math.max(0.6, k)) // accumulate; never time * speed
const layers = this.alt > 3 ? [['fly', this.time, 1]]
  : this.swim && this.m.clips.swim ? [['swim', this.step, 1]]
  : [['idle', this.time, 1 - k], ['walk', this.step, k]]
if (this.seat) layers.push(['ride', 0, 1])
if (this.lift) layers.push(['lift', 0, 1])        // an item held over the head
if (this.once) layers.push([this.once[0], this.once[1], 1])
pose(this.m, layers)
this.pos.y = this.floor ?? (this.swim ? WATER - this.swim : Math.max(WATER - 0.9, height(this.pos.x, this.pos.z)))
this.g.rotation.y = this.dir
this.flash = Math.max(0, this.flash - dt * 4)
this.m.mat.emissive.setRGB(this.flash * 0.7 + this.burn * 0.12, this.flash * 0.3 + this.burn * 0.04, this.flash * 0.3)
```

- `floor` overrides the ground (rooms and caves built far below the surface).
- Wading sinks the actor with the bed down to waist depth (`WATER - 0.9`), then swimming floats it at `WATER - swim`.
- The hit flash and burning glow are emissive on the actor's own material (one per instance; see models.md).

## Player control

- Tank controls in the chase camera: ←/→ (or the touch stick's x, or the locked mouse) turn at 2.8 rad/s; A/D strafe;
  W/S walk along the facing, backing at 60%. Speed 6, halved while a one-shot plays, 55% swimming.
- First person: A/D strafe, the mouse turns and pitches, arrows look.
- Move with `player.move((f*sin + r*cos) * k * dt, (f*cos - r*sin) * k * dt, dt)` and set `player.speed` for the gait.
- **Breath** while swimming: 25 s, refills in 4 s on land; then 1 hp every 2 s. Gentle on purpose: it stops the lake
  being a safe room without punishing crossings.
- **Regeneration** by place: fast in a village, none in the wilds (`models.json` `health`); potions and berries heal.
- Falling: after 3 s you get back up at home, with full health. Keep penalties legible: an unexplained gold loss
  confused players and was removed.

## Combat

- **Attack**: play the item's clip (`item.anim`). Except in first person, turn to the nearest live enemy within 4 units and
  about 57° of the facing (`cos(a) > 0.55`), so you only need to roughly face a fight.
- **The blow lands partway through the clip** (45% of the swing): then hit every live enemy within
  `item.reach + enemy.scale * 0.4` and within 1.2 rad of the facing, with a clear line (no wall between).
- **`hurt(e, dmg, from, push)`**: return if `e.safe > 0` (the player gets 0.6 s of grace after each hit); subtract
  hp; flash; knockback `vel = unit(e - from) * push`; burst of cubes in the creature's colour; on death play `death`,
  count the kill, drop loot, beep; else play `hit` unless it would cancel the player's own swing.
- **Damage over time**: burning ticks 1 hp a second for `burn` seconds; burning creatures (not slimes) flee; water
  puts fire out.
- **Line of sight underground**: `clear(ax, az, bx, bz)` tests the segment against each wall box with a slab test;
  used for hits, monster blows and health-bar visibility.

## Creature AI

Each frame, per live monster (Wellfire: the `monsters` block in `frame()`):

1. **Despawn far ones**: beyond 70 units, recycle (`spawn(e)`).
2. **Habitat awareness**: if the straight way to the player is the wrong medium (`!e.fits(height(one step toward
   the player))`), pace up and down the shore facing him (`sin(time * 1.7)` sideways), and after 3-5 s lose interest
   and wander off for 5-9 s. Bats tire after 4 s over water and fly back to the last shore they crossed. Eels only
   chase someone in the water.
3. **Chase** when within sight (12 units × stage × fierceness; bats 24 toward a lit torch), not inside a village, not
   burning, not bored: head straight at the player.
4. **Light fear**: slimes and spiders within 7 units of a lit torch back off to ~5 and circle (`tangent * 0.7`), but
   dare a rush 2 s in every 7. A light buys breathing room, not safety.
5. **Attack** in reach when the cooldown is done: play `attack`, cooldown `(1.8 + R * 1.5) * stage / fierceness`, and
   land the blow at 50% of the clip if still in reach (+0.6), clear line, and the player isn't in a village or flying.
   A rider's mount takes the blow.
6. **Wander** otherwise: every 2-5 s pick a heading (40% chance to stand), at 40% speed; flee while burning.
7. **Separation**: push away from any other live monster within 1 unit (0.5 per neighbour).
8. `move`, set `speed`, and if `stuck`, reset the wander timer so it picks a new way.

Tune creatures with data: per-kind hp, speed and damage (scaled by compiled size, stage and fierceness), `gold` on the
model, region mixes in `FOES`.

## Spawning and the crowd

- **Crowd size**: `(12 + (1 - day) * 10) * CROWD[region] * stage * (homeCrowd + (1 - homeCrowd) * out(x, z))`: more at
  night, busier forests, fewer near home.
- **Spawn a spot first, then a kind that lives there**: a random point 18-48 units from the player; skip villages
  (padded); deep water → eel (4 at most); dry land → the region's mix; shallows → nothing. Up to 99 tries. This one
  function covers respawns, recycling and night crowds.
- **Fierceness** from distance to home (0.5 at home to 1 at `homeRamp`) scales health, damage, sight and attack rate.
- Spawn with probability `dt` per frame while under the crowd size; fill the crowd at load.
- **Death**: play `death`, shrink away from 1.4 s to 2.4 s (`scale = clamp(2.4 - dead, 0.01, 1)`), recycle at 3 s.
- **Disposal**: when recycling, remove the group, dispose of each mesh's geometry and the material. Every respawn
  leaked one compiled model before this was added.

## Health bars

Two planes per hurt monster (back and fill), a child group of the monster so they leave with it; hidden until the first
hit. Shared geometry (`PlaneGeometry(1, 1).translate(0.5, 0, 0)`, growing rightwards) and four shared
`MeshBasicMaterial({ fog: false, depthTest: false, transparent: true })` (back, red, amber, green), `renderOrder` 998/999.
Sized from the model's bounding box once; the fill eases toward the hp fraction (`v += (f - v) * dt * 8`);
billboarded with `quaternion = inverse(parent quaternion) * camera.quaternion`.

## Particles and drops

- **Bursts**: small cubes (`BoxGeometry(0.12)`, shared) with random velocity, gravity 15, life 0.7 s, shrinking.
  Colour by what was hit. Cheap and readable.
- **Ripples**: a flat ring on the water that widens and fades (1 s).
- **Drops**: a kill spills its pay in up to 6 coins (`spill`), each a baked model with a bounce (gravity 15, half
  speed on landing, stop under 1.5), spin, and a pulsing emissive glow. Within 3.5 units they're pulled to the player,
  faster the closer (`min(d, (5 + (3.5 - d) * 5) * dt)`), and pay out under 0.6 with a two-tone ching. Blink after
  40 s, gone at 45 s or when their chunk unloads. In water they sink slowly to the bed, and a swimmer collects them
  at any depth. Thrown items stay put until walked onto.
- **Pay**: model `gold` × size × seeded roll (`hash(seed, kills)`, ×0.7-1.3) × up to 1.6 at night × region × stage ×
  distance from the nearest fence.

## Mounts

Ordinary actors with a `saddle` socket bone and gameplay numbers in vars (run, turn, health, grip, attack damage, reach,
arc, knockback, cooldown, hit timing `at`).

- Found by per-chunk rolls (~1 chunk in 17), kind by region; some goblins spawn riding one and drop it when hit.
- Riding: the rider's hip sits on the saddle in the `ride` pose, the weapon goes on the back, the HUD shows the
  mount's name and health. Reins: A/D turn at 80% of its turn rate, W runs, S backs. Space triggers the mount's own
  attack. The camera pulls back 1.35×.
- Monsters chase the rider but their blows land on the mount. Damage in quick succession (decaying 1/s) past `grip`, or
  the mount dying, throws the rider; it bolts for 3 s.
- Rules as blockers: no mounts in villages, no deeper than a wade.
- A flying mount uses `alt`: above 3 units it ignores colliders and plays `fly`; fog draws back and the minimap's
  sight radius grows with altitude.
