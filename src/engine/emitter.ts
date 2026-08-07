import type { Behavior, Cell, EmitterNode } from "./types";

/**
 * A CAEmitterCell-equivalent simulation.
 *
 * Apple's emitters here are steady-state: a constant birth rate feeding a fixed
 * lifetime. So rather than keeping mutable particle state, each particle index
 * owns a deterministic seed and its whole life is a pure function of the clock.
 * That keeps the simulation allocation-free and safe to run in a worklet, at the
 * cost of not modelling one-shot bursts (lightning bolts need a stateful pass).
 */

export const MAX_PARTICLES = 1200;

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
  waveForce: number;
  waveFrequency: number;
  timeScale: number;
};

function behaviorCurve(behaviors: Behavior[] | undefined, kind: string, keyPath: string) {
  const b = behaviors?.find(
    (x) => x.behavior === kind && x.keyPath === keyPath && x.enabled !== false
  );
  return b?.values ?? [];
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
  const count = Math.min(MAX_PARTICLES, Math.ceil(rate * (lifetime + lifetimeRange)));

  const wave = cell.behaviors?.find((b) => b.behavior === "wave" && b.enabled !== false);
  const dist = cell.behaviors?.find(
    (b) => b.behavior === "valueOverDistance" && b.keyPath === "color.alpha" && b.enabled !== false
  );

  const [w, h] = emitter.emitterSize;
  const line = emitter.shape === "line";

  return {
    count,
    lifetime,
    lifetimeRange,
    velocity: cell.velocity ?? 0,
    velocityRange: cell.velocityRange ?? 0,
    // Core Animation measures emissionLongitude from +x; the scene's container
    // rotation is what actually points precipitation downward.
    angle: sceneRotation + (cell.emissionLongitude ?? 0),
    emissionRange: cell.emissionRange ?? 0,
    scale: cell.scale ?? 1,
    scaleRange: cell.scaleRange ?? 0,
    scaleSpeed: cell.scaleSpeed ?? 0,
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
    spanX: line ? w : w,
    spanY: line ? 0 : h,
    r: cell.color[0],
    g: cell.color[1],
    b: cell.color[2],
    cullTop: emitter.cullRect ? emitter.cullRect[1] : -Infinity,
    cullBottom: emitter.cullRect ? emitter.cullRect[1] + emitter.cullRect[3] : Infinity,
    alphaOverLife: behaviorCurve(cell.behaviors, "valueOverLife", "color.alpha"),
    alphaOverDistance: dist?.values ?? [],
    falloff: dist?.falloff ?? 0,
    scaleOverLife: behaviorCurve(cell.behaviors, "valueOverLife", "scale"),
    waveForce: wave?.force ?? 0,
    waveFrequency: wave?.frequency ?? 0,
    // CAEmitterLayer.speed scales the emitter's whole sense of time.
    timeScale: emitter.speed || 1,
  };
}

/**
 * Particles are evaluated independently per index rather than simulated into a
 * shared buffer. That keeps every worklet pure -- no cross-frame state for
 * Reanimated to serialize, and nothing to compact when a particle dies. The
 * cost is recomputing position in both the transform and colour passes, which
 * is a handful of trig calls per particle.
 */

/** Lifetime of slot `i`, including its per-particle variance. */
function lifeOf(p: PreparedCell, i: number): number {
  "worklet";
  return p.lifetime + p.lifetimeRange * rnd(i, 1);
}

/**
 * Age of slot `i` at time `t`, or -1 if it has no valid lifetime. Births are
 * staggered evenly so the field is already full on the first frame, then each
 * slot recycles forever.
 */
function ageOf(p: PreparedCell, t: number, i: number): number {
  "worklet";
  const life = lifeOf(p, i);
  if (life <= 0) return -1;
  const scaled = t * p.timeScale;
  const born = (i / p.count) * life;
  const age = (scaled - born) % life;
  return age < 0 ? age + life : age;
}

function distOf(p: PreparedCell, age: number, i: number): number {
  "worklet";
  return (p.velocity + p.velocityRange * spread(i, 3)) * age;
}

function dirOf(p: PreparedCell, i: number): number {
  "worklet";
  return p.angle + p.emissionRange * spread(i, 2) * 0.5;
}

function xOf(p: PreparedCell, age: number, i: number, dist: number): number {
  "worklet";
  let x =
    p.originX + p.spanX * (rnd(i, 4) - 0.5) + Math.cos(dirOf(p, i)) * dist + 0.5 * p.ax * age * age;
  if (p.waveForce !== 0) {
    x += Math.sin(age * p.waveFrequency * Math.PI * 2 + i) * p.waveForce;
  }
  return x;
}

function yOf(p: PreparedCell, age: number, i: number, dist: number): number {
  "worklet";
  return (
    p.originY + p.spanY * (rnd(i, 5) - 0.5) + Math.sin(dirOf(p, i)) * dist + 0.5 * p.ay * age * age
  );
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
  const u = age / lifeOf(p, i);
  if (p.alphaOverLife.length) a *= sampleCurve(p.alphaOverLife, u);
  if (p.alphaOverDistance.length) {
    a *= sampleCurve(p.alphaOverDistance, p.falloff > 0 ? Math.abs(dist) / p.falloff : u);
  }
  if (a <= 0.002) return 0;
  return a > 1 ? 1 : a;
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
  const rot = p.rotation + (p.spin + p.spinRange * spread(i, 8)) * age;
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
