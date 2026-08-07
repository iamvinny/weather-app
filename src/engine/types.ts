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
  name: string;
  image: string;
  frame: [number, number, number, number];
  opacity: number;
  tiled: boolean;
  contentsScale: number;
  scroll: {
    keyPath: string;
    duration: number;
    speed: number;
    from: number;
    to: number;
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
  nodes: SceneNode[];
  states: Record<string, StateEntry>;
};
