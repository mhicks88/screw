import type { LevelDef, PlateDef, ScrewColor, ScrewDef } from '../src/core/types';
import { rectShape } from '../src/core/shapes';

export function rectPlate(id: number, layer: number, x: number, y: number, hw: number, hh: number, rotation = 0): PlateDef {
  return { id, layer, shape: rectShape(hw, hh), x, y, rotation, color: 0xff0000, material: 'plastic' };
}

export function screw(id: number, plateId: number, x: number, y: number, color: ScrewColor, hidden = false): ScrewDef {
  return { id, plateId, x, y, color, hidden };
}

export function makeLevel(opts: {
  plates: PlateDef[]; screws: ScrewDef[]; boxQueue: ScrewColor[]; activeBoxCount?: number; traySlots?: number;
}): LevelDef {
  return {
    level: 1, seed: 1, plates: opts.plates, screws: opts.screws, boxQueue: opts.boxQueue,
    activeBoxCount: opts.activeBoxCount ?? 2, traySlots: opts.traySlots ?? 5,
    colors: [...new Set(opts.screws.map((s) => s.color))], difficulty: 'easy',
  };
}

/** One big base plate (id 0, layer 0) filling the board. */
export const BASE = rectPlate(0, 0, 0, 0, 2.8, 4);
/** A smaller plate on layer 1 covering x∈[0.5,2.5], y∈[0.5,2.5]. */
export const COVER = rectPlate(1, 1, 1.5, 1.5, 1, 1);

/** n screws of one colour on the base plate, laid out along a row `y`. */
export function row(startId: number, color: ScrewColor, y: number, n: number, plateId = 0): ScrewDef[] {
  return Array.from({ length: n }, (_, i) => screw(startId + i, plateId, -2 + i, y, color));
}
