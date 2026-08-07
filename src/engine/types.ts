export type Behavior = {
  behavior: "valueOverLife" | "valueOverDistance" | "colorOverLife" | "wave" | "attractor" | string;
  keyPath?: string;
  enabled?: boolean;
  values?: number[];
  force?: number;
  frequency?: number;
  falloff?: number;
  falloffDistance?: number;
  orientationLatitude?: number;
  orientationLongitude?: number;
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
  contentsFrameMode?: string;

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
  emissionRange?: number;
  spin?: number;
  spinRange?: number;
  rotation?: number;
};

export type EmitterNode = {
  type: "emitter";
  id?: string;
  name: string;
  birthRate: number;
  speed: number;
  scale: number;
  shape: "point" | "line" | "rectangle" | string;
  mode: string;
  emitterPosition: [number, number];
  emitterSize: [number, number];
  cullRect?: number[];
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
    repeat: boolean;
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
