# weather-app

<p align="center">
  <img src="assets/weatherkit-96x96_2x.png" alt="Apple Weather WebKit Logo">
</p>

Recreates the iOS Weather app's animated backgrounds in Expo, driven by the
scene data extracted from the app bundle's `Mica/` directory.

<p align="center">
  <img src="assets/screenshots.png" alt="App Runtime Screenshots">
</p>

## How it works

The Weather bundle ships **two** background systems. This project uses the
older one, `Mica/`, for reasons covered in [Why Mica and not
VFX](#why-mica-and-not-vfx).

Apple ships 537 `.caml` files — one per weather condition × day/night × device
size. They are plain Core Animation XML: layer trees, tiled scrolling images,
and `CAEmitterLayer` particle systems with full cell parameters and behaviors.
Everything needed to redraw a scene is in the file; nothing is hidden in code.

`tools/caml_to_scene.py` converts one condition into a compact runtime JSON and
copies the sprites it references. `src/engine/` renders that JSON with
react-native-skia.

```
tools/caml_to_scene.py        .caml -> runtime scene JSON + sprites

src/app/                      expo-router routes (_layout, index)
src/components/               screen-level UI
src/constants/                collapse geometry, sky colours

src/engine/                   the renderer, self-contained
  types.ts                    scene/emitter/cell shapes
  emitter.ts                  CAEmitterCell-equivalent simulation (worklets)
  CellLayer.tsx               one cell -> one Skia Atlas draw call
  TileLayer.tsx               tiled/scrolling image layers
  states.ts                   LKState resolution (Full / Mini / Landscape)
  WeatherScene.tsx            composes a scene, scales it to the device
  assets.ts                   generated registry Metro can resolve
```

Routing is expo-router with `src/app` as the routes directory; `@/*` is aliased
to `src/*`. `src/engine/` is kept whole rather than split across
`components/`/`hooks/`: it is a library with one public entry point
(`WeatherScene`) and no knowledge of the app around it.

## Converting scenes

```sh
# every condition, plus a regenerated src/engine/assets.ts
python3 tools/caml_to_scene.py /path/to/Extracted_IOS_Files/Mica --all

# just one
python3 tools/caml_to_scene.py /path/to/Extracted_IOS_Files/Mica snow_night
```

`--all` produces all **77 scenes** (42 conditions × day/night, plus the
time-independent `clear`, `hot`, `mostlySunny`, `rainbow`) and writes the
registry, since Metro needs static `require` paths. Single-condition runs leave
the registry alone, so add the entry by hand or re-run `--all`.

## Things worth knowing about the format

**The design space is y-up.** Scenes are authored at a fixed 640×1136 with a
bottom-left origin, held by a layer named `Rotation` that is uniformly scaled to
cover the device. The converter flips to y-down. This is confirmed by the `Mini`
state, which culls the rain emitter to design y 846..2046 — the top 290px of the
screen once flipped, i.e. the collapsed header.

**Direction resolves in three tiers.** 701 of 903 cells carry no
`emissionLongitude`. An authored angle (cell longitude and/or the emitter
layer's own rotation — the sunny lens flare aims its streak with a
`transform.rotation.z` animation) is used directly, negated on the y-flip. No
angle but *negative* velocity means Core Animation's default +x axis travelled
backwards: every horizontal drifter (smoke, fog, haze, dust, wind debris,
blowing snow, the hurricane bands) is authored as velocity −800-ish along an
unrotated layer. No angle and positive velocity falls back to the container's
downward direction, which the app tilts with wind at runtime: change
`scene.rotation` (π/2 is straight down) and rain slants.

**Scroll keyframes are absolute positions, and tiles are 3D planes.** A tile's
`position.x/y` animation *overrides* its static position attribute (drizzle's
cloud sits at x −895.9 but animates 0 → −768) — the converter rebases the
frame on the animation's start and keeps the slide vector, whose length is a
multiple of the tile image's width; that is what makes the loop seamless.
Several cloud tiles also sit under layers with full perspective
`CATransform3D`s (the drizzle/tornado cloud planes recede toward the horizon)
or scaled/rotated containers (the blizzard snow tiles run at −72.3°). The
converter folds the whole chain into one projective 3×3 per image node,
applied outside the scroll so the slide stays in the layer's own space, exactly
as Core Animation composes it.

**There are no gradient layers, but storms carry a sky colour.** Zero
`CAGradientLayer` instances across all 537 files. The thunderstorm-family
scenes (8 conditions) back themselves with a flat "🔳 Underlying" CALayer whose
`backgroundColor` is the sky — the converter extracts it into
`scene.backgroundColor`. Every other condition ships no backdrop at all, so
`src/constants/sky.ts` supplies a fallback keyed off time of day.

**Some layers exist only inside state records.** `LKStateRemoveElement` comes
in two forms: a reference (`objectId`) to a layer in the base tree, or a fully
serialized `<object>` for a layer that appears *nowhere else* — present by
default, taken out when the state (always `Mini` here) activates, serialized in
full so the state machine can restore it. The hail/sleet keyline bounces, the
star fields in `clear`, the lens flares in `sunny`/`hot`, the rainbow layer in
`mostlySunny`, and the tornado debris all live solely in these records: a
converter that walks only `sublayers` silently drops them from every state,
`Full` included. The converter re-parents each serialized object under its
recorded target (offsets and timing come along) and retargets the removal at a
synthetic id the renderer hides in `Mini`.

**Cells nest.** The keyline bounce emitters use a carrier cell (no image,
velocity ≤ 1, drifting along a line) whose *children* are the visible bouncing
stones. The runtime simulates one level, so the converter folds a child into an
equivalent top-level cell at its steady-state rate — carriers/sec × children
emitted per carrier window — spawning from the carrier's region.

**Accelerations share the y-up frame.** `yAcceleration` is signed in the same
y-up space as the geometry: snow carries +50 (air-resistance lift slowing its
fall) while the hail and sleet bounces carry −2000/−3500 (gravity). The
converter negates it along with the y-flip; copy it through unsigned and snow
speeds up instead of floating while hail falls up.

**Additive layers need the sky inside the canvas.** 377 emitters use
`renderMode="cheapAdditive"`, and additive sprites are authored on black
because black adds nothing. `plus` blending adds alpha too, so over a
*transparent* canvas those sprites add onto transparent black and composite as
opaque black rectangles — a black band across the top of every storm scene.
The sky therefore has to be painted inside the Skia canvas (`<Fill>`), not as a
React Native view behind it, so the additive layers have something to add onto.

**Emission angles negate on the y-flip, and 0 means "unspecified".** 202 cells
carry an explicit `emissionLongitude`, authored in the y-up design space, so
the angle negates along with the geometry. Every non-zero value in the corpus
lands somewhere downward that way: thunderstorm −90° → straight down, blizzard
−162° and tropicalStorm −151° → steep wind-blown slants, the shooting star
−70° → down and to the right. A literal `0` is Apple's tooling writing the
default rather than "point along +x" — `rain_night` omits the attribute
entirely and must still fall — so 0 falls back to the container's downward
direction. Getting this wrong sends blizzard snow flying upward.

**Cull rects use ±DBL_MAX for "unbounded".** An axis Apple doesn't want clipped
is stored as ±1.797e308 rather than omitted, so flipping it arithmetically
collapses it to zero and culls the entire scene. The converter special-cases it.

**The visible band falls out of the cull rects.** `WeatherScene` derives the
region of design space a state actually shows by clipping every emitter's cull
rect to the canvas, then aligns that band's bottom to the visible height. No
state needs special-casing: `Full`'s rects are wider than the canvas so it
yields the whole scene, while `Mini`'s clip to the collapsed header strip. That
is what lets the route drive the collapse straight from scroll position.

**States are real animation data.** Each scene carries `Full`, `Mini` and
`Landscape` as key-path overrides against layer ids, with spring stiffness and
damping values suitable for feeding straight into Reanimated.

## Simulation model

Apple's emitters are steady-state: a constant birth rate feeding a fixed
lifetime. So instead of mutable particle state, each particle index owns a
deterministic seed and its entire life is a pure function of the clock. Each
slot cycles with period `max(lifetime, count/birthRate)` and is alive only
while its age is within its lifetime — that quotient is what gives
low-birth-rate cells their duty cycle: the corner twinkles in `clear` flash
~20% of the time and the shooting star streaks once a minute instead of both
looping continuously. Each
atlas slot is evaluated independently, straight from the clock — there is no
cross-frame state for Reanimated to serialize, nothing to compact when a
particle dies, and no per-frame allocation. The field is already full on the
first frame.

Implemented: birth rate, lifetime (+range), velocity (+range), emission angle
and range, x/y acceleration, scale (+range, +speed), alpha (+range, +speed),
spin (+range), cull rects, sprite-sheet frames (`contentsFrameCount` /
`contentsFramesPerRow` / `contentsFrameMode`), render modes (Apple's
`cheapAdditive` → Skia `plus`), path emitters with `sequential` emission, burst
scheduling (`beginTime` / `duration` / `repeatCount`), and the `valueOverLife`,
`valueOverDistance`, `colorOverLife`, `wave`, `attractor` and `alignToMotion`
behaviors. The attractor is an approximation — a distance-falloff pull rather
than Core Animation's exact force model.

Not implemented: the `light` behavior (35 uses), `emissionLatitude` (the scenes
are effectively 2D), and `CAEmitterCell.particleType` variants beyond sprites.

### Bursts are still stateless

Lightning looked like it would force a mutable simulation, but it doesn't:
Apple's bolts repeat on a fixed cycle, so they stay a pure function of the
clock. A burst cell emits across a short `window` that recurs every `period`,
and `age` is derived from `clock mod period`. Two subtleties matter:

- **Nested time.** Core Animation composes timing down the tree — a child's
  local time is `(parent_time - beginTime) * speed`. Flattening the layer tree
  loses that, so the converter folds it into one `(beginTime, speed)` pair per
  emitter. Without it every bolt inherits phase 0 and the whole storm fires at
  once instead of staggering across 16s, 23s, 24s, 40s…
- **Inherited windows.** A child's active window is clipped by its parent's.
  The bolt branches declare no `duration` of their own, so they must inherit
  the parent bolt's cycle; treated as continuous emitters they glow forever.

A thunderstorm is 62 emitters and 99 cells, of which 60 are path emitters — 12
strikes of roughly 5 branches each, one firing every ~12 seconds.

## Why Mica and not VFX

The extracted bundle contains two separate background systems:

| | `Mica/` | `VFX/` |
|---|---|---|
| era | iOS 14 (Core Animation) | iOS 15+ (VFXCore) |
| contents | 537 `.caml` + 96 PNG | 1 ECS scene graph + ~460 textures |
| parameter values | **inline in the XML** | **absent — compiled into the binary** |
| runtime needed | a `CAEmitterCell` equivalent | Apple's private ECS engine + Metal shaders |

This project is 100% Mica: all 83 sprites are PNGs from that directory, with no
`.ktx`/`.heic` files and none of the `_POS`/`_NEG`/`_ALPHA` triplets that mark
the VFX set.

**Mica is self-describing.** Every value needed to redraw a scene — gradients,
birth rates, velocities, lifetimes, colour ramps, the lightning paths — sits in
readable XML. That is the whole reason this project was tractable.

**VFX is machinery without numbers.** `WeatherCombinedV75_Background.vfx` is a
610-entity ECS scene graph exposing 187 named parameters (`gradientTop`,
`sunAngle`, five cloud layers, `lightningNumberOfBranches`, …) and shipping *no
values for any of them*. The per-condition presets are compiled into the
`Weather` executable — grepping the binary for those parameter names hits
plaintext, so they are in there, just not as data. Using VFX therefore means
both reimplementing an undocumented particle runtime *and* recovering ~187
floats × 77 conditions out of a Mach-O.

### What Mica costs you

VFX genuinely looks better. Its cloud textures ship as POS/NEG/ALPHA triplets —
a pre-baked lighting trick that blends positive- and negative-lit variants by
sun angle, giving clouds that respond to time of day. It also computes the sky
gradient dynamically, whereas Mica ships flat PNG skies (which is why
`src/constants/sky.ts` has to pick a backdrop colour by hand).

### The middle path

You can keep this engine and adopt the VFX *art* without the VFX runtime: swap
in the cloud textures and drive the POS/NEG blend from a sun-angle value you
supply yourself. The textures need KTX/HEIC → PNG conversion first.

### Checked lead: the widget JSONs are a dead end

`PlugIns/WeatherWidget.appex/ClearDay.json` and `RainyDay.json` looked like
they might hold VFX parameter presets. They don't — they are canned *forecast*
fixtures for the widget gallery preview (hourly temps for a town called
Martin, one 120° day labelled "Super Hot"). No VFX parameters anywhere in
them; recovering the presets still means digging them out of the binary.
