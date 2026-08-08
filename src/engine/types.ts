/** The only Skia blend modes tools/caml_to_scene.py emits. */
export type BlendModeName = "srcOver" | "plus" | "screen";

export type Behavior = {
  behavior:
    | "valueOverLife"
    | "valueOverDistance"
    | "colorOverLife"
    | "wave"
    | "attractor"
    | "alignToMotion"
    | "light"
    | string;
  keyPath?: string;
  enabled?: boolean;
  values?: number[];
  force?: number;
  frequency?: number;
  falloff?: number;
  falloffDistance?: number;
  orientationLatitude?: number;
  orientationLongitude?: number;
  stiffness?: number;
  radius?: number;
  /** alignToMotion: extra sprite rotation on top of the motion direction. */
  rotation?: number;
  /** light: intensity floor, cone gain, and whether it modulates alpha. */
  ambientIntensity?: number;
  diffuseIntensity?: number;
  appliesAlpha?: number;
  position?: number[];
};

export type Cell = {
  name: string;
  enabled: boolean;
  image?: string;
  color: [number, number, number, number];
  behaviors?: Behavior[];
  contentsRect?: number[];
  contentsFrameCount?: number;
  contentsFramesPerRow?: number;
  contentsFramesPerSecond?: number;
  contentsFrameMode?: string;
  repeatCount?: number;

  birthRate?: number;
  lifetime?: number;
  lifetimeRange?: number;
  velocity?: number;
  velocityRange?: number;
  scale?: number;
  scaleRange?: number;
  scaleSpeed?: number;
  alphaRange?: number;
  alphaSpeed?: number;
  xAcceleration?: number;
  yAcceleration?: number;
  emissionLongitude?: number;
  emissionLatitude?: number;
  emissionRange?: number;
  spin?: number;
  spinRange?: number;
  rotation?: number;
  rotationRange?: number;
  beginTime?: number;
  duration?: number;
  timeOffset?: number;
  contentsScale?: number;
};

export type EmitterNode = {
  type: "emitter";
  id?: string;
  /** Ids of the group layers above this node; hiding a group hides it too. */
  groups?: string[];
  name: string;
  birthRate: number;
  speed: number;
  scale: number;
  shape: "point" | "line" | "rectangle" | "path" | string;
  mode: string;
  /** Skia blend mode derived from Core Animation's renderMode. */
  blendMode: BlendModeName;
  beginTime: number;
  duration: number;
  /** -1 means repeatCount="Inf": the duration window loops forever. */
  repeatCount: number;
  /**
   * Rotation of the emitter layer itself (y-up radians, from its transform
   * and/or a transform.rotation.z animation). Added to every cell's emission
   * angle — the sunny lens flare aims its streak this way.
   */
  angleOffset?: number;
  emitterPosition: [number, number];
  emitterSize: [number, number];
  cullRect?: number[] | null;
  /** Present when emitterShape is "path" -- the lightning bolt outlines. */
  path?: number[][];
  cells: Cell[];
};

export type ImageNode = {
  type: "image";
  id?: string;
  /** Ids of the group layers above this node; hiding a group hides it too. */
  groups?: string[];
  name: string;
  image: string;
  frame: [number, number, number, number];
  opacity: number;
  tiled: boolean;
  contentsScale: number;
  /**
   * Projective correction (3x3 row-major, screen space) from where `frame`
   * puts the layer to where its transform chain actually lands it — the
   * perspective-tilted cloud planes, scaled/rotated precipitation tiles.
   */
  matrix?: number[];
  /** Slide vector per period, applied inside `matrix`. */
  scroll: {
    duration: number;
    speed: number;
    dx: number;
    dy: number;
  } | null;
};

export type SceneNode = EmitterNode | ImageNode;

export type StateEntry = {
  basedOn: string | null;
  set: { targetId: string; keyPath: string; value: number }[];
  remove: { targetId: string; keyPath: string; name: string | null }[];
};

export type Scene = {
  name: string;
  designSize: [number, number];
  deviceScale: number;
  rotation: number;
  /**
   * Sky colour baked into the scene, when it carries one. Only the
   * thunderstorm-family scenes back themselves with a coloured layer; for the
   * rest this is null and the app supplies a backdrop (src/constants/sky.ts).
   */
  backgroundColor?: string | null;
  nodes: SceneNode[];
  states: Record<string, StateEntry>;
};
