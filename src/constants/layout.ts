/**
 * Geometry for the collapsing header.
 *
 * These are our choices, not Apple's: the .caml scenes say what the Mini state
 * looks like but not when to trigger it, since that lives in the Weather app's
 * view controller.
 */

/** Scroll distance over which the background collapses into the header. */
export const COLLAPSE_RANGE = 320;

/** Header height once fully collapsed. */
export const HEADER_MIN = 150;

/** Past this fraction of the collapse, the scene switches to its Mini state. */
export const MINI_AT = 0.55;
