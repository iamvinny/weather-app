import type { Behavior, Cell, EmitterNode } from "./types";

/**
 * A CAEmitterCell-equivalent simulation.
 *
 * Particles are evaluated independently per index rather than simulated into a
 * shared buffer: each slot owns a deterministic seed and its whole life is a
 * pure function of the clock. That keeps every worklet pure -- no cross-frame
 * state for Reanimated to serialize, and nothing to compact when a particle
 * dies -- and it extends to bursts too, because Apple's one-shot emitters
 * (lightning) repeat on a fixed period and so are still periodic in time.
 */

/** Ceiling for a continuously emitting cell. */
export const MAX_PARTICLES = 1200;
/**
 * Ceiling for a path emitter. The bolts ask for 1000 sprites each and a
 * thunderstorm has twelve of them; at that budget the UI thread cannot keep
 * 60fps, and the bolt reads the same with far fewer sprites along the path.
 */
export const MAX_PATH_PARTICLES = 220;

/** Deterministic per-particle randomness in [0,1). */
function rnd(i: number, k: number): number {
  "worklet";
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Signed variance in [-1,1), matching Core Animation's `*Range` semantics. */
function spread(i: number, k: number): number {
  "worklet";
  return rnd(i, k) * 2 - 1;
}

/** Piecewise-linear sample of a CAEmitterBehavior value curve. */
function sampleCurve(values: number[], u: number): number {
  "worklet";
  const n = values.length;
  if (n === 0) return 1;
  if (n === 1) return values[0];
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  const x = c * (n - 1);
  const i = Math.floor(x);
  if (i >= n - 1) return values[n - 1];
  return values[i] + (values[i + 1] - values[i]) * (x - i);
}

/** Sample one channel of a flat RGBA keyframe list. */
function sampleRGBA(values: number[], u: number, channel: number): number {
  "worklet";
  const stops = Math.floor(values.length / 4);
  if (stops === 0) return 1;
  if (stops === 1) return values[channel];
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  const x = c * (stops - 1);
  const i = Math.floor(x);
  if (i >= stops - 1) return values[(stops - 1) * 4 + channel];
  const a = values[i * 4 + channel];
  const b = values[(i + 1) * 4 + channel];
  return a + (b - a) * (x - i);
}

export type PreparedCell = {
  count: number;
  lifetime: number;
  lifetimeRange: number;
  velocity: number;
  velocityRange: number;
  angle: number;
  emissionRange: number;
  scale: number;
  scaleRange: number;
  scaleSpeed: number;
  alpha: number;
  alphaRange: number;
  alphaSpeed: number;
  ax: number;
  ay: number;
  spin: number;
  spinRange: number;
  rotation: number;
  originX: number;
  originY: number;
  spanX: number;
  spanY: number;
  r: number;
  g: number;
  b: number;
  cullTop: number;
  cullBottom: number;
  alphaOverLife: number[];
  alphaOverDistance: number[];
  falloff: number;
  scaleOverLife: number[];
  colorOverLife: number[];
  waveForce: number;
  waveFrequency: number;
  attractorX: number;
  attractorY: number;
  attractorForce: number;
  attractorFalloff: number;
  alignToMotion: number;
  /** alignToMotion's own rotation offset (screen-space radians). */
  alignRotation: number;
  /**
   * The `light` behavior, approximated: an alpha gain of ambient + diffuse
   * falling off linearly with distance from the light. Only enabled for cells
   * authored with base alpha 0 — those exist to be revealed by the light
   * (the rain in mixedRainAndSleet); brighter cells keep their authored look.
   */
  lightGain: number;
  lightX: number;
  lightY: number;
  lightAmbient: number;
  lightDiffuse: number;
  lightFalloff: number;
  timeScale: number;
  /**
   * Cycle length of one particle slot. Alive while `age <= life`, dead for
   * the rest of the cycle — this is what gives low-birth-rate cells (the
   * shooting star, the corner twinkles) their duty cycle instead of a
   * permanently full field.
   */
  slotPeriod: number;

  // Burst scheduling. `period` of 0 means the cell emits continuously.
  period: number;
  phase: number;
  window: number;

  // Path emission (emitterShape="path").
  pathX: number[];
  pathY: number[];
  sequential: number;

  // Sprite-sheet frames.
  frameCount: number;
  framesPerRow: number;
  frameW: number;
  frameH: number;
  frameFPS: number;
  /** 0: animate over life, 1: random per particle, 2: sequential per particle. */
  frameMode: number;
};

function findBehavior(behaviors: Behavior[] | undefined, kind: string, keyPath?: string) {
  return behaviors?.find(
    (b) => b.behavior === kind && b.enabled !== false && (!keyPath || b.keyPath === keyPath)
  );
}

function curve(behaviors: Behavior[] | undefined, kind: string, keyPath: string) {
  return findBehavior(behaviors, kind, keyPath)?.values ?? [];
}

/**
 * Resolve a cell against its emitter into flat numbers the worklet can use.
 * `birthScale` folds in state overrides (Mini raises rain birth rates, etc).
 */
export function prepareCell(
  cell: Cell,
  emitter: EmitterNode,
  sceneRotation: number,
  birthScale = 1
): PreparedCell {
  const lifetime = cell.lifetime ?? 1;
  const lifetimeRange = cell.lifetimeRange ?? 0;
  const rate = (cell.birthRate ?? 0) * emitter.birthRate * birthScale;
  // CAEmitterLayer.scale (attribute, LKState override, or the layer's own
  // transform scale) magnifies what the cells draw.
  const mag = emitter.scale || 1;

  const path = emitter.path ?? [];
  const onPath = emitter.shape === "path" && path.length > 1;

  // A looping emitter with a finite duration is a burst: it emits for
  // `cell.duration` local seconds, then goes quiet until the window comes
  // round again. Everything here stays in the emitter's local time.
  const burst = emitter.repeatCount === -1 && emitter.duration > 0;
  const window = burst ? cell.duration ?? 0 : 0;
  const period = burst ? emitter.duration : 0;

  const cap = onPath ? MAX_PATH_PARTICLES : MAX_PARTICLES;
  const demand = burst && window > 0 ? rate * window : rate * (lifetime + lifetimeRange);
  const count = Math.min(cap, Math.max(0, Math.ceil(demand)));

  const wave = findBehavior(cell.behaviors, "wave");
  const dist = findBehavior(cell.behaviors, "valueOverDistance", "color.alpha");
  const attractor = findBehavior(cell.behaviors, "attractor");
  const align = findBehavior(cell.behaviors, "alignToMotion");
  const light = findBehavior(cell.behaviors, "light");
  const lit =
    light && (light.appliesAlpha ?? 0) > 0 && cell.color[3] <= 0.01 ? 1 : 0;

  const [w, h] = emitter.emitterSize;
  const line = emitter.shape === "line";

  // contentsRect gives frame 0's sub-rect in normalized units. A few cells
  // carry pixel values instead; those are not grids, so ignore them.
  const rect = cell.contentsRect;
  const usable = rect && rect.length === 4 && rect[2] <= 1 && rect[3] <= 1;
  const frameCount = cell.contentsFrameCount ?? 0;

  // Emission direction, in three tiers:
  //
  // 1. An authored angle (cell emissionLongitude and/or the layer's own
  //    rotation) negates on the y-flip to screen space. Every non-zero value
  //    in the corpus lands somewhere sensible that way: thunderstorm -90 ->
  //    straight down, blizzard -162 -> a wind-blown slant, the sunny lens
  //    flare's layer rotation -60 -> a streak toward the bottom right.
  // 2. No angle but *negative* velocity means Core Animation's default +x
  //    axis, travelled backwards: every horizontal drifter (smoke, fog, haze,
  //    dust, the wind debris, blowing snow, the hurricane bands) is authored
  //    as velocity -800-ish along an unrotated layer.
  // 3. No angle and positive velocity falls back to the container's downward
  //    direction -- rain_night omits the attribute entirely and must fall.
  //    (Apple's tooling writes a literal 0 with the same intent.)
  //
  // An emissionLatitude of pi flips the direction in-plane (the hail keyline
  // carriers drift -x that way).
  const lon = cell.emissionLongitude ?? 0;
  const off = emitter.angleOffset ?? 0;
  let angle =
    lon !== 0 || off !== 0
      ? -(lon + off)
      : (cell.velocity ?? 0) < 0
        ? 0
        : sceneRotation;
  if (Math.abs(cell.emissionLatitude ?? 0) > 3) angle += Math.PI;

  return {
    count,
    lifetime,
    lifetimeRange,
    velocity: (cell.velocity ?? 0) * mag,
    velocityRange: (cell.velocityRange ?? 0) * mag,
    angle,
    emissionRange: cell.emissionRange ?? 0,
    scale: (cell.scale ?? 1) * mag,
    scaleRange: (cell.scaleRange ?? 0) * mag,
    scaleSpeed: (cell.scaleSpeed ?? 0) * mag,
    alpha: cell.color[3],
    alphaRange: cell.alphaRange ?? 0,
    alphaSpeed: cell.alphaSpeed ?? 0,
    ax: cell.xAcceleration ?? 0,
    ay: cell.yAcceleration ?? 0,
    spin: cell.spin ?? 0,
    spinRange: cell.spinRange ?? 0,
    rotation: cell.rotation ?? 0,
    originX: emitter.emitterPosition[0],
    originY: emitter.emitterPosition[1],
    spanX: w,
    spanY: line ? 0 : h,
    r: cell.color[0],
    g: cell.color[1],
    b: cell.color[2],
    cullTop: emitter.cullRect ? emitter.cullRect[1] : -1e9,
    cullBottom: emitter.cullRect ? emitter.cullRect[1] + emitter.cullRect[3] : 1e9,
    alphaOverLife: curve(cell.behaviors, "valueOverLife", "color.alpha"),
    alphaOverDistance: dist?.values ?? [],
    falloff: dist?.falloff ?? 0,
    scaleOverLife: curve(cell.behaviors, "valueOverLife", "scale"),
    colorOverLife: findBehavior(cell.behaviors, "colorOverLife")?.values ?? [],
    waveForce: wave?.force ?? 0,
    waveFrequency: wave?.frequency ?? 0,
    attractorX: attractor?.position?.[0] ?? 0,
    attractorY: attractor?.position?.[1] ?? 0,
    attractorForce: attractor?.force ?? 0,
    attractorFalloff: attractor?.falloff || 1,
    alignToMotion: align ? 1 : 0,
    // The behavior's rotation is authored y-up; negate like every other angle.
    alignRotation: align ? -(align.rotation ?? 0) : 0,
    lightGain: lit,
    lightX: light?.position?.[0] ?? 0,
    lightY: light?.position?.[1] ?? 0,
    lightAmbient: light?.ambientIntensity ?? 0,
    lightDiffuse: light?.diffuseIntensity ?? 1,
    lightFalloff: light?.falloff || 1000,
    // CAEmitterLayer.speed scales the emitter's whole sense of time.
    timeScale: emitter.speed || 1,
    // A slot re-births every count/rate seconds; when that exceeds the
    // lifetime the particle spends the difference dead. When the demand hit
    // the particle cap the field is denser than authored anyway, so keep
    // every slot fully occupied rather than shortening lives.
    slotPeriod:
      count > 0 && rate > 0
        ? Math.max(lifetime + lifetimeRange, count / rate)
        : lifetime + lifetimeRange,

    period,
    phase: emitter.beginTime + (cell.beginTime ?? 0),
    window,

    pathX: onPath ? path.map((p) => p[0]) : [],
    pathY: onPath ? path.map((p) => p[1]) : [],
    sequential: emitter.mode === "sequential" ? 1 : 0,

    frameCount,
    framesPerRow: cell.contentsFramesPerRow ?? frameCount ?? 1,
    frameW: usable ? rect![2] : 1,
    frameH: usable ? rect![3] : 1,
    frameFPS: cell.contentsFramesPerSecond ?? 0,
    // "sequential" without a frame rate deals each particle the next frame in
    // the sheet, fixed for its whole life (the lens-flare heptagon variants);
    // with a rate it is an ordered animation like the default mode.
    frameMode:
      cell.contentsFrameMode === "random"
        ? 1
        : cell.contentsFrameMode === "sequential" && !cell.contentsFramesPerSecond
          ? 2
          : 0,
  };
}

/** Lifetime of slot `i`, including its per-particle variance. */
function lifeOf(p: PreparedCell, i: number): number {
  "worklet";
  return p.lifetime + p.lifetimeRange * rnd(i, 1);
}

/**
 * Age of slot `i` at time `t` (seconds), or -1 when it is not currently alive.
 *
 * Continuous cells stagger births evenly across the lifetime so the field is
 * already full on the first frame. Burst cells instead emit across a short
 * window that repeats every `period`, which is how the lightning bolts fire.
 */
function ageOf(p: PreparedCell, t: number, i: number): number {
  "worklet";
  const life = lifeOf(p, i);
  if (life <= 0 || p.count === 0) return -1;
  const local = (t - p.phase) * p.timeScale;

  if (p.period > 0) {
    let cycle = local % p.period;
    if (cycle < 0) cycle += p.period;
    const emitted = p.window > 0 ? (i / p.count) * p.window : 0;
    const age = cycle - emitted;
    return age < 0 || age > life ? -1 : age;
  }

  const cycle = p.slotPeriod > life ? p.slotPeriod : life;
  const born = (i / p.count) * cycle;
  let age = (local - born) % cycle;
  if (age < 0) age += cycle;
  return age > life ? -1 : age;
}

function distOf(p: PreparedCell, age: number, i: number): number {
  "worklet";
  return (p.velocity + p.velocityRange * spread(i, 3)) * age;
}

function dirOf(p: PreparedCell, i: number): number {
  "worklet";
  return p.angle + p.emissionRange * spread(i, 2) * 0.5;
}

/** Spawn point for slot `i`: along the path, or across the emitter's extent. */
function spawnX(p: PreparedCell, i: number): number {
  "worklet";
  const n = p.pathX.length;
  if (n > 1) {
    const u = p.sequential === 1 ? i / p.count : rnd(i, 9);
    const x = u * (n - 1);
    const k = Math.floor(x);
    if (k >= n - 1) return p.pathX[n - 1];
    return p.pathX[k] + (p.pathX[k + 1] - p.pathX[k]) * (x - k);
  }
  return p.originX + p.spanX * (rnd(i, 4) - 0.5);
}

function spawnY(p: PreparedCell, i: number): number {
  "worklet";
  const n = p.pathY.length;
  if (n > 1) {
    const u = p.sequential === 1 ? i / p.count : rnd(i, 9);
    const x = u * (n - 1);
    const k = Math.floor(x);
    if (k >= n - 1) return p.pathY[n - 1];
    return p.pathY[k] + (p.pathY[k + 1] - p.pathY[k]) * (x - k);
  }
  return p.originY + p.spanY * (rnd(i, 5) - 0.5);
}

function xOf(p: PreparedCell, age: number, i: number, dist: number): number {
  "worklet";
  let x = spawnX(p, i) + Math.cos(dirOf(p, i)) * dist + 0.5 * p.ax * age * age;
  if (p.waveForce !== 0) {
    x += Math.sin(age * p.waveFrequency * Math.PI * 2 + i) * p.waveForce;
  }
  if (p.attractorForce !== 0) {
    // Approximates CAEmitterBehavior's radial attractor: a pull toward the
    // anchor that falls off with distance.
    const dx = p.attractorX - x;
    x += (dx / (1 + Math.abs(dx) / p.attractorFalloff)) * p.attractorForce * age * 0.01;
  }
  return x;
}

function yOf(p: PreparedCell, age: number, i: number, dist: number): number {
  "worklet";
  let y = spawnY(p, i) + Math.sin(dirOf(p, i)) * dist + 0.5 * p.ay * age * age;
  if (p.attractorForce !== 0) {
    const dy = p.attractorY - y;
    y += (dy / (1 + Math.abs(dy) / p.attractorFalloff)) * p.attractorForce * age * 0.01;
  }
  return y;
}

/** Opacity of particle `i` at time `t`; 0 when culled or fully faded. */
export function particleAlpha(p: PreparedCell, t: number, i: number): number {
  "worklet";
  const age = ageOf(p, t, i);
  if (age < 0) return 0;

  const dist = distOf(p, age, i);
  const y = yOf(p, age, i, dist);
  if (y < p.cullTop || y > p.cullBottom) return 0;

  let a = p.alpha + p.alphaRange * spread(i, 6) + p.alphaSpeed * age;
  if (p.lightGain === 1) {
    const dx = xOf(p, age, i, dist) - p.lightX;
    const dy = y - p.lightY;
    const d = Math.sqrt(dx * dx + dy * dy);
    const fall = 1 - d / p.lightFalloff;
    a += p.lightAmbient + p.lightDiffuse * (fall > 0 ? fall : 0);
  }
  const u = age / lifeOf(p, i);
  if (p.alphaOverLife.length) a *= sampleCurve(p.alphaOverLife, u);
  if (p.colorOverLife.length) a *= sampleRGBA(p.colorOverLife, u, 3);
  if (p.alphaOverDistance.length) {
    a *= sampleCurve(p.alphaOverDistance, p.falloff > 0 ? Math.abs(dist) / p.falloff : u);
  }
  if (a <= 0.002) return 0;
  return a > 1 ? 1 : a;
}

/** Tint of particle `i` for one RGB channel, honouring colorOverLife. */
export function particleTint(p: PreparedCell, t: number, i: number, channel: number): number {
  "worklet";
  const base = channel === 0 ? p.r : channel === 1 ? p.g : p.b;
  if (!p.colorOverLife.length) return base;
  const age = ageOf(p, t, i);
  if (age < 0) return base;
  return base * sampleRGBA(p.colorOverLife, age / lifeOf(p, i), channel);
}

/** Position, scale and rotation of particle `i`, written into an RSXform. */
export function particleXform(
  p: PreparedCell,
  t: number,
  i: number,
  halfW: number,
  halfH: number,
  val: { set: (scos: number, ssin: number, tx: number, ty: number) => void }
): void {
  "worklet";
  const age = ageOf(p, t, i);
  if (age < 0) {
    val.set(0, 0, 0, 0);
    return;
  }

  let s = p.scale + p.scaleRange * spread(i, 7) + p.scaleSpeed * age;
  if (p.scaleOverLife.length) s *= sampleCurve(p.scaleOverLife, age / lifeOf(p, i));
  if (s <= 0) {
    val.set(0, 0, 0, 0);
    return;
  }

  const dist = distOf(p, age, i);
  // alignToMotion turns the sprite's vertical axis along the motion vector
  // (Raindrop.png and the sleet frames are authored as vertical streaks),
  // plus the behavior's own rotation offset; the cell's rotation is ignored.
  // A negative per-particle velocity travels the direction backwards, so the
  // motion vector flips with it. Confirmed by mixedRainAndSleet, whose Rain
  // and Sleet cells carry different rotations yet must render identically.
  const rot =
    p.alignToMotion === 1
      ? dirOf(p, i) +
        (p.velocity + p.velocityRange * spread(i, 3) < 0 ? Math.PI : 0) -
        Math.PI / 2 +
        p.alignRotation
      : p.rotation + (p.spin + p.spinRange * spread(i, 8)) * age;
  const scos = Math.cos(rot) * s;
  const ssin = Math.sin(rot) * s;
  // RSXform positions the sprite's top-left, so offset by the rotated centre.
  val.set(
    scos,
    ssin,
    xOf(p, age, i, dist) - (scos * halfW - ssin * halfH),
    yOf(p, age, i, dist) - (ssin * halfW + scos * halfH)
  );
}

/**
 * Sub-rect of the sprite sheet for particle `i`, written into a rect.
 * Cells without a sheet get the whole image.
 */
export function particleFrame(
  p: PreparedCell,
  t: number,
  i: number,
  imgW: number,
  imgH: number,
  val: { setXYWH: (x: number, y: number, w: number, h: number) => void }
): void {
  "worklet";
  const fw = p.frameW * imgW;
  const fh = p.frameH * imgH;
  if (p.frameCount <= 1) {
    val.setXYWH(0, 0, fw, fh);
    return;
  }

  let frame: number;
  if (p.frameMode === 1) {
    frame = Math.floor(rnd(i, 11) * p.frameCount);
  } else if (p.frameMode === 2) {
    frame = i % p.frameCount;
  } else {
    const age = ageOf(p, t, i);
    // A framesPerSecond of 0 means the sheet plays across the whole lifetime.
    const u = p.frameFPS > 0 ? age * p.frameFPS : (age < 0 ? 0 : age / lifeOf(p, i)) * p.frameCount;
    frame = Math.floor(u) % p.frameCount;
    if (frame < 0) frame += p.frameCount;
  }

  const perRow = p.framesPerRow > 0 ? p.framesPerRow : p.frameCount;
  const col = frame % perRow;
  const row = Math.floor(frame / perRow);
  val.setXYWH(col * fw, row * fh, fw, fh);
}
