import type { Scene, StateEntry } from "./types";

/**
 * Apple ships each scene with LKStates — `Full`, `Mini` (the collapsed header
 * you get when scrolling) and `Landscape`. Each is a list of key-path overrides
 * against layer ids, optionally inheriting from another state.
 *
 * We resolve a state into a flat lookup: id -> keyPath -> value.
 */
export type Overrides = Record<string, Record<string, number>>;

export function resolveState(scene: Scene, name: string): Overrides {
  const out: Overrides = {};
  const chain: StateEntry[] = [];

  let cursor: string | null = name;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry: StateEntry | undefined = scene.states[cursor];
    if (!entry) break;
    chain.unshift(entry);
    cursor = entry.basedOn;
  }

  for (const entry of chain) {
    for (const s of entry.set) {
      (out[s.targetId] ??= {})[s.keyPath] = s.value;
    }
    // A removed emitter cell is expressed as an element removal; mark the cell
    // disabled so the renderer skips it.
    for (const r of entry.remove) {
      if (r.keyPath === "emitterCells" && r.name) {
        (out[r.targetId] ??= {})[`emitterCells.${r.name}.enabled`] = 0;
      }
    }
  }
  return out;
}

/** Read `emitterCells.<name>.birthRate` style overrides for one cell. */
export function cellOverride(
  overrides: Overrides,
  emitterId: string | undefined,
  cellName: string,
  prop: string
): number | undefined {
  if (!emitterId) return undefined;
  return overrides[emitterId]?.[`emitterCells.${cellName}.${prop}`];
}

export function nodeOverride(
  overrides: Overrides,
  id: string | undefined,
  keyPath: string
): number | undefined {
  if (!id) return undefined;
  return overrides[id]?.[keyPath];
}
