# Pitfalls: bugs that cost time, and the rule each taught

| symptom | cause | rule |
|---|---|---|
| Legs whirl when a creature speeds up or slows down (300× too fast on a mount 300 s old) | gait phase was `time * speed / run`, so any speed change jumped it by `elapsed × change` | accumulate phase per frame: `step += dt * rate` |
| Mirror-image chunks rolled the same herd (same mount, name, coat) | `hash(x, z) == hash(-x, -z)` for about a third of cells | key cell-level rolls through `h2(i, j) = hash(2i, 2j + 1)`; give each layer its own seed offset |
| Village names repeated a lot (21 repeats among 76 villages) | names from random syllables | derive names from the cell with coprime strides along each part list |
| Reloading while carrying the quest item crashed at load | a string (`felled.carry`) went through the regrow-pruning loop, which tried `delete str[i]` (TypeError in strict mode) | keep non-map keys out of generic loops over a save object, or skip them by type |
| Saves silently stopped after an hour of flying (a beam's lock lost) | the explored-cells set as one string per cell hit the ~5 MB origin quota | compact per-chunk bitmasks; read back every write; show a "Can't save" box once |
| 240 ms frames after a long flight | the minimap tile cache held 150 but the view needed 225, so ~75 tiles rebuilt every frame | caches grow to what's shown; build a few new tiles per frame; iterate an index of explored chunks |
| Every respawn leaked a compiled model | `spawn()` removed despawned monsters from the scene but didn't dispose of geometry and material | dispose of geometry and per-instance materials when anything leaves; check `renderer.info.memory` |
| Item swaps and stowing leaked | `hold()` didn't free the replaced prop | `hold()` disposes of the old prop's geometry (not the shared material) |
| The game froze entering a house | a lookup returned `false`, `false < 12` is true, then `.wait` was set on `false` and threw out of `frame()` | a throw in the frame loop stops the game silently; guard lookups with numeric defaults (`99` for "none") |
| ...and the real cause: flying over a doorstep entered the room mounted | the door test checked only x/z | gate state changes on the full state (on foot only, not seated, not flying) |
| A goblin rolling a mount threw `e is not defined` and stopped the loop | a refactor split `foe()` out of `spawn()` and dropped a variable | after moving code, exercise every branch (rare rolls included) in the browser |
| A short hop on the flying mount never sent it away | "a flight" counted only above 3 units | thresholds for "did it happen" should be low (0.3), separate from gameplay thresholds |
| Townsfolk hovered 0.3 above the ground | the model's legs ended above its root (foot bone too short) | soles at y = 0 in every rig: hip height = thigh + shin + ankle-to-sole |
| The warrior hovered 0.36 above the ground | single-segment legs too short for the hip height | same rule; check placement in the viewer and in the world |
| Cave walls flickered at every joint | overlapping boxes left coplanar faces (z-fighting) | panels stop short of corners; posts fill the corners |
| A point light on the camera blew out walls up close in dark caves | inverse-square falloff near surfaces | for "faint ambient in the dark", raise a hemisphere light and close the fog instead |
| Creatures hit the player through the village fence | blows checked distance only | blows need distance, angle and a clear line, and the player's "safe" state (inside a village) |
| Water read as flat; the player never sank past ankle-deep | an actor clamp at `WATER - 0.35` and uniform water colour | shape the bed (shore remap), tint by depth, sink actors to waist depth, then swim |
| The world looked flat from the follow camera | big hills only; three.js barely shades gentle slopes | add knolls at camera scale; bake hillshade into vertex colours |
| A north-up minimap confused players | the camera's default 45° yaw made "ahead" point north-west | turn the map with the camera; mark north on the rim |
| A bass-heavy fight music layer went unheard | laptop speakers barely play bass | put game-reactive parts in the mid and high range |
| Gold vanished on death and players didn't know why | nothing said so | every penalty gets a message, or drop it |
| (guarded against) inlining code with `String.replace` would mangle any `$&` or `$1` in it | a string replacement interprets `$` patterns | use a replacement function in build scripts (`.replace(slot, () => code)`) |
| Old notes gave per-feature "shipped" sizes that were never measured | estimates written like measurements | label estimates; quote level, commit and date for measurements |
| Two engine files declared the same top-level name | the build concatenates files into one scope | check for duplicate top-level names after adding files (`node --check` on the built script) |
