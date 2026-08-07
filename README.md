# weather-app

Recreates the iOS Weather app's animated backgrounds in Expo, driven by the
scene data extracted from the app bundle's `Mica/` directory.

## How it works

Apple ships 537 `.caml` files — one per weather condition × day/night × device
size. They are plain Core Animation XML: layer trees, tiled scrolling images,
and `CAEmitterLayer` particle systems with full cell parameters and behaviors.
Everything needed to redraw a scene is in the file; nothing is hidden in code.

`tools/caml_to_scene.py` converts one condition into a compact runtime JSON and
copies the sprites it references. `src/engine/` renders that JSON with
react-native-skia.

```
tools/caml_to_scene.py       .caml -> runtime scene JSON + sprites
src/engine/types.ts          scene/emitter/cell shapes
src/engine/emitter.ts        CAEmitterCell-equivalent simulation (worklets)
src/engine/CellLayer.tsx     one cell -> one Skia Atlas draw call
src/engine/TileLayer.tsx     tiled/scrolling image layers
src/engine/states.ts         LKState resolution (Full / Mini / Landscape)
src/engine/WeatherScene.tsx  composes a scene, scales it to the device
src/engine/assets.ts         static registry Metro can resolve
```

## Adding a condition

```sh
python3 tools/caml_to_scene.py ../Extracted_IOS_Files/Mica snow_night
```

Then register the scene and any new sprites in `src/engine/assets.ts` — Metro
needs static `require` paths, so this step can't be automatic.

Available conditions (42): blizzard, blowingSnow, breezy, clear, cloudy,
drizzle, dust, flurries, fog, frigid, hail, haze, heavyRain, heavySnow, hot,
hurricane, isolatedThundershowers, isolatedThunderstorms, mixedRainAndSleet,
mixedRainAndSnow, mixedRainfall, mixedSnowAndSleet, mostlyClear, mostlyCloudy,
mostlySunny, partlyCloudy, rain, rainbow, scatteredShowers,
scatteredSnowShowers, scatteredThunderstorms, severeThunderstorm, showers,
sleet, smoke, snow, snowShowers, sunny, thunderstorm, tornado, tropicalStorm,
windy — each as `<condition>_day` / `<condition>_night`, or bare for the
time-independent ones (`clear`, `hot`, `mostlySunny`, `rainbow`).

## Things worth knowing about the format

**The design space is y-up.** Scenes are authored at a fixed 640×1136 with a
bottom-left origin, held by a layer named `Rotation` that is uniformly scaled to
cover the device. The converter flips to y-down. This is confirmed by the `Mini`
state, which culls the rain emitter to design y 846..2046 — the top 290px of the
screen once flipped, i.e. the collapsed header.

**Emission direction comes from the container, not the cells.** No cell carries
an `emissionLongitude`, so all travel direction comes from the `Rotation` layer
the app turns at runtime. That is also how the app tilts precipitation with
wind: change `scene.rotation` (π/2 is straight down) and rain slants.

**There are no gradient layers.** Zero `CAGradientLayer` instances across all
537 files — skies ship as pre-rendered PNGs, so `App.tsx` supplies a flat
backdrop behind the scene.

**Cull rects use ±DBL_MAX for "unbounded".** An axis Apple doesn't want clipped
is stored as ±1.797e308 rather than omitted, so flipping it arithmetically
collapses it to zero and culls the entire scene. The converter special-cases it.

**The visible band falls out of the cull rects.** `WeatherScene` derives the
region of design space a state actually shows by clipping every emitter's cull
rect to the canvas, then aligns that band's bottom to the visible height. No
state needs special-casing: `Full`'s rects are wider than the canvas so it
yields the whole scene, while `Mini`'s clip to the collapsed header strip. That
is what lets `App.tsx` drive the collapse straight from scroll position.

**States are real animation data.** Each scene carries `Full`, `Mini` and
`Landscape` as key-path overrides against layer ids, with spring stiffness and
damping values suitable for feeding straight into Reanimated.

## Simulation model

Apple's emitters are steady-state: a constant birth rate feeding a fixed
lifetime. So instead of mutable particle state, each particle index owns a
deterministic seed and its entire life is a pure function of the clock. Each
atlas slot is evaluated independently, straight from the clock — there is no
cross-frame state for Reanimated to serialize, nothing to compact when a
particle dies, and no per-frame allocation. The field is already full on the
first frame.

The tradeoff: one-shot bursts aren't modelled. Continuous precipitation, cloud
drift and wind all work; the 12 lightning bolts in `thunderstorm_night` need a
stateful pass with `CAEmitterCell.beginTime` / `repeatCount` honoured.

Implemented: birth rate, lifetime (+range), velocity (+range), emission angle
and range, x/y acceleration, scale (+range, +speed), alpha (+range, +speed),
spin (+range), cull rects, `valueOverLife` and `valueOverDistance` alpha
curves, and `wave` displacement. Not yet: `attractor` and `colorOverLife`
behaviors, sprite-sheet frame animation (`contentsFrameCount`), and `alignToMotion`.

## The modern (VFX) backgrounds

`VFX/` in the bundle holds the iOS 15+ system: a 610-entity ECS scene graph for
Apple's private VFXCore engine plus ~460 cloud textures. The scene defines the
machinery and exposes 187 named parameters (sky gradient, sun angle, five cloud
layers, precipitation, lightning, stars) but ships **no values** — the
per-condition presets are compiled into the `Weather` binary. Recreating that
path means reimplementing an undocumented particle runtime, which is why this
project builds on the `.caml` set instead.
