# Camera, input, lighting and the HUD

Wellfire: `src/game.js` sections `renderer, scene, light`, `HUD`, `minimap`, `input`, and the camera and lighting
parts of `frame()` in `main loop`; HUD markup and CSS in `src/index.html`.

## Renderer and lights

```js
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
const sky = DAY.clone()
scene.background = sky
scene.fog = new THREE.Fog(sky, 40, 110)
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 200)
const hemi = new THREE.HemisphereLight('#dfefff', '#4a5a30', 1.3)
const sun = new THREE.DirectionalLight(SUN, 2.2)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 })
scene.add(hemi, sun, sun.target)
// each frame: the sun and its shadow box follow the player
sun.position.set(target.x + 20, target.y + 40, target.z + 10)
sun.target.position.copy(target)
```

Resize: `renderer.setSize(innerWidth, innerHeight)`, update the camera aspect and projection, on `resize` and at load.

## Day and night

A ~3-minute cycle (period `2π × 30` s), starting mid-morning when play begins:

```js
day = clamp(Math.cos((t - morn) / 30 + 0.6) * 0.8 + 0.6, 0, 1)   // 1 noon .. 0 night
sky.lerpColors(NIGHT, DAY, day); scene.fog.color.copy(sky)
scene.fog.near = 6 + day * 34; scene.fog.far = 40 + day * 70     // the dark closes in
sun.color.lerpColors(MOON, SUN, day); sun.intensity = 0.2 + 2.2 * day  // a faint blue moon at night
hemi.intensity = 0.03 + day * 1.27
```

- Full night is near-black (`#03050c`), so **what glows is what shows**: self-lit `!` colours (eyes, windows, flames,
  coins) and a torch. A village can keep a floor on the hemisphere light (lamplit).
- **Torch light**: a `PointLight('#ff9a40', 0, 14, 1.5)` at the flame bone's world position, intensity
  `(4 + 26 * (1 - day)) * (1 + sin(t*21)*0.1 + sin(t*37)*0.07)` (two sines flicker).
- Music follows the same `day` (audio.md). Game stages can tint `DAY`, `NIGHT` and a light multiplier, lerped in over
  ~2 s so a change fades rather than snaps.
- Underground: day 0, no sun, black sky; with a lit torch the fog closes to 3-18 units. With none, the hemisphere light
  rises to 0.5 and the fog closes to 0.5-3 (walls keep a faint even glow within arm's reach), and the cold costs 1 health
  every `caves.darkHurt` seconds.

## Chase camera

The camera stays behind the hero and swings round with a short lag:

```js
let a = player.dir + Math.PI - camYaw
camYaw += Math.atan2(Math.sin(a), Math.cos(a)) * Math.min(1, dt * 4)      // close 4x the angle gap per second
const back = riding ? 1.35 : camera.aspect < 1 ? 1.3 : 1                     // further back riding and on portrait phones
fwd.set(Math.sin(camYaw) * 7 * back, 0, Math.cos(camYaw) * 7 * back).add(target)
fwd.y = Math.max(target.y + 4.8 * back, height(fwd.x, fwd.z) + 1.5, WATER + 0.6) // over the ground behind, never under water
camera.position.lerp(fwd, Math.min(1, dt * 8))
camera.lookAt(target.x - Math.sin(camYaw) * 3, target.y + 0.8, target.z - Math.cos(camYaw) * 3) // 3 units ahead, waist height
```

- Snap (factor 1) on the first frames and when switching between rooms and outdoors.
- A slight downward angle that shows the ground ahead and monsters in front instead of the hero's back.
- Fixed views (a house's cutaway room) keep a fixed camera and screen-relative moves.
- Cutscene cameras (aiming a beam, the ending's light show) take over by skipping this block.

## First person

- Toggle with C; forced in caves. The camera sits at the head bone's world position, 0.3 forward, looking along the
  facing tilted by `pitch` (clamped ±1.3). Riding, it rides out in front of the mount's head (1.1× its size ahead).
- Switch lens on change: fov 90 / near 0.05 in first person, 45 / 0.5 otherwise
  (`camera.fov = …; camera.near = …; camera.updateProjectionMatrix()`).
- Hide the head and the left arm (`armL`) so they don't fill the view; the weapon arm stays so swings show. A held torch is
  shown as a camera-child mesh at the lower left that follows the hidden hand's bob.
- In tight spaces keep the camera itself clear of walls (push it out of each wall box plus 0.2), since the face
  reaches further than the body's collider.

## Input

```js
const keys = {}
addEventListener('keydown', (e) => { keys[e.code] = 1; /* one-shot actions by e.code */ })
addEventListener('keyup', (e) => (keys[e.code] = 0))
let ix = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + stick.x
let iz = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0) + stick.y
```

- Use `e.code` (layout-independent). Action keys fire on keydown (Space/J use, F/Tab swap with `preventDefault` on
  Tab, digits pick tray slots, R ride, C camera, N map, M mute, Esc closes panels).
- When a dialog box is open, Space/Enter/Esc/J only close it.
- **Pointer lock**: a mouse click on the canvas requests it (where free look is allowed); while locked, a click
  attacks and `movementX/Y * 0.0025` turn and pitch. Also accept a held-button drag where the browser refuses to lock.
  Exit the lock when entering a fixed-camera place.
- **Touch**: the first touch that isn't on a button or panel becomes a virtual stick at its start point; offset / 50 px,
  clamped to ±1, feeds `ix`/`iz` (up/down walks, sideways turns). On-screen buttons (HIT, SWAP, RIDE) act on
  `touchstart`. `touchmove` with `{ passive: false }` and `preventDefault()` stops scrolling. On the first touch, show
  the pad, add a body class that lifts the HUD above it, and change the help line to touch wording.
- CSS for touch: `touch-action: none; user-select: none` on body; `user-scalable=no` in the viewport meta.

## The HUD is DOM

HTML and CSS are cheaper and crisper than drawing text in WebGL.

- `const $ = (id) => document.getElementById(id)`.
- Health (and breath, fuel, speed) as bars: a container with a coloured child whose `style.width` is a percentage;
  hide a bar with opacity (and a CSS transition) when full or unused.
- A status line: what's in hand, kills, progress (`✦ n/5`), place name.
- **Toasts**: `say(t)` sets a line's text and runs a Web Animations fade (`el.animate([{opacity:1},{opacity:1,offset:.7},{opacity:0}], 2500)`).
- **Dialog box**: a centred white box (`#say`) with a heading, a line and "Space or tap". While it's open, the frame
  loop returns early (paused) and keys only close it.
- **Pop on change**: `el.animate([{ transform: 'scale(1.4)' }, { transform: 'none' }], 300)` on a tray slot; the purse
  pops to `scale(1.6)` with a colour flash (red and slower, 900 ms, when it drops).
- **Tray**: slots built as `innerHTML` from the bag (icon image, slot number, count badge); taps via one
  `onpointerdown` on the container with `closest('b')` and `data-` attributes.
- A tiny build-ID label in a corner (build-and-ship.md).
- A help line of the controls under the tray; hide HUD pieces on the title screen with opacity.

## The hint line

One always-on line by the tray: what you can do right here (ride, talk, crack the boulder, set the sunstone…) in
gold, or with nothing at hand, the current mission step with an arrow (`⬆` rotated toward the target relative to the
camera). The words live in `models.json` (`hints`), so they can be edited without code.

## Minimap with fog of war

A round 160-px canvas, top right; 2 units per pixel (320×320 units); reveals 8×8-unit cells within 36 units of the
player (more while flying). Wellfire: section `minimap`.

- **State**: `seen`, the set of revealed cells: the only growing state in the whole world (saved compactly; save.md).
- **Tiles**: each explored chunk gets a 20×20-px canvas (`CH / UPP`), painted cell by cell from `height`, `slope`,
  `ground` (×hillshade lit from the north-west, ×brighter with height, forest darker) and `sea()` for water; roads and
  village floors in their own tints. Use `getHexString(THREE.LinearSRGBColorSpace)` so three.js's sRGB lift doesn't
  wash the map out.
- **LRU cache**: a `Map` re-inserted on use, evicting the oldest past a limit that grows to what a map shows
  (`lim = max(lim, shown + 50)`). Build at most ~4 new tiles per draw so revealing or zooming never stalls a frame;
  until a tile exists draw the chunk as one colour dot. Walk an index of explored chunks, not every chunk in view.
- **Compose world-aligned** on a hidden canvas 1.42× the map's size, then draw it rotated by the camera yaw in one
  `drawImage`: up on the map is the way W walks, and tiles never show seams. North-up was tried first and confused
  people, because the camera's default turn made "ahead" point north-west.
- **`chart()`** draws the ground tiles plus a dotted trail of the last 300 steps (one dot per 6 units), the start
  square and village rings (coloured by progress). **`marks()`**, a separate pass, adds a red arrow for facing, upright
  village names (clamped to the rim when off the edge), `N` on the rim and the goal's direction (`✦`). Both maps use
  both.
- **Big map (N or tap)**: full screen, north-up, zoomed to fit everything explored plus hints; pauses the game. The
  same `chart()` and `marks()` draw it.
- Below the map: region name, coordinates, distance from the start.

## Title screen in the live world

No separate scene: at load the game runs with the HUD hidden, the camera circling the start village at dusk, a 3D
title over it (voxel letters: draw the word into a small 2D canvas, read `getImageData`, one instanced box per lit
pixel, coloured by row), a flame of additive cones over the well, sparks from the particle system. Any key, click or
tap (capture-phase listener with `stopImmediatePropagation`) starts the game, its audio and the day clock.
