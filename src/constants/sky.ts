/**
 * Fallback backdrop colours.
 *
 * The thunderstorm-family scenes carry their sky as a coloured "🔳 Underlying"
 * layer, which the converter extracts into `scene.backgroundColor`. Every
 * other condition ships no backdrop at all (and there is not a single
 * CAGradientLayer in the corpus), so the backdrop is ours to pick; key it off
 * the scene's time of day.
 */
export function skyFor(sceneName: string) {
  if (sceneName.endsWith("_day")) return "#4a7ba8";
  if (sceneName.endsWith("_night")) return "#101d2e";
  return "#2d5580";
}
