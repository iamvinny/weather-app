/**
 * Backdrop colours.
 *
 * The .caml scenes carry precipitation and lighting only — Apple ships the sky
 * as a pre-rendered PNG, and there is not a single CAGradientLayer in the whole
 * corpus. So the backdrop is ours to pick; key it off the scene's time of day.
 */
export function skyFor(sceneName: string) {
  if (sceneName.endsWith("_day")) return "#4a7ba8";
  if (sceneName.endsWith("_night")) return "#101d2e";
  return "#2d5580";
}
