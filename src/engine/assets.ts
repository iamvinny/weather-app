import type { Scene } from "./types";

/**
 * Metro needs static require paths, so extracted scenes and their sprites are
 * registered here. Re-run `tools/caml_to_scene.py` for a new condition, then
 * add its entries below.
 */
export const SCENES: Record<string, Scene> = {
  rain_night: require("../../assets/scenes/rain_night.json") as Scene,
  snow_night: require("../../assets/scenes/snow_night.json") as Scene,
};

export const SPRITES: Record<string, number> = {
  "Raindrop.png": require("../../assets/sprites/Raindrop.png"),
  "Raindrop-Tile-Heavy.png": require("../../assets/sprites/Raindrop-Tile-Heavy.png"),
  "Snow-Flake-Small.png": require("../../assets/sprites/Snow-Flake-Small.png"),
};

/** Every sprite filename a scene references, across tiles and emitter cells. */
export function spritesFor(scene: Scene): string[] {
  const names = new Set<string>();
  for (const node of scene.nodes) {
    if (node.type === "image") names.add(node.image);
    else for (const cell of node.cells) if (cell.image) names.add(cell.image);
  }
  return [...names];
}
