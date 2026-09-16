import type { LevelDef, PanelDef, ScrewColor, ScrewDef } from '../src/core/types';
import { rectShape } from '../src/core/shapes';

const THICKNESS = 0.1;
/** Panel local-origin z by panel id, so `screw` can seat itself on the face. */
const PANEL_Z = new Map<number, number>();

/**
 * A rectangular panel lying in the XY plane at height `z`, facing +z. Panels
 * built this way stack like the v2 board did — which keeps the game-rule tests
 * readable — while going through the real 3D ray-vs-panel blocking rule.
 */
export function rectPanel(id: number, shell: number, z: number, hw: number, hh: number, cx = 0, cy = 0): PanelDef {
  PANEL_Z.set(id, z);
  return {
    id,
    shape: rectShape(hw, hh),
    thickness: THICKNESS,
    position: { x: cx, y: cy, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    color: 0xff0000,
    material: 'plastic',
    shell,
  };
}

/** A screw on panel `panelId`'s outer face at assembly-space (x, y), pointing +z. */
export function screw(id: number, panelId: number, x: number, y: number, color: ScrewColor, hidden = false): ScrewDef {
  const z = PANEL_Z.get(panelId) ?? 0;
  return { id, panelId, position: { x, y, z: z + THICKNESS }, axis: { x: 0, y: 0, z: 1 }, color, hidden };
}

/** Move a screw sideways (same panel, same face). */
export function shift(s: ScrewDef, dx: number, dy: number): ScrewDef {
  return { ...s, position: { ...s.position, x: s.position.x + dx, y: s.position.y + dy } };
}

export function makeLevel(opts: {
  panels: PanelDef[]; screws: ScrewDef[]; boxQueue: ScrewColor[]; activeBoxCount?: number; traySlots?: number;
}): LevelDef {
  return {
    level: 1, seed: 1, panels: opts.panels, screws: opts.screws, boxQueue: opts.boxQueue,
    activeBoxCount: opts.activeBoxCount ?? 2, traySlots: opts.traySlots ?? 5,
    colors: [...new Set(opts.screws.map((s) => s.color))], difficulty: 'easy',
  };
}

/** One big base panel (id 0, inner shell) with everything else in front of it. */
export const BASE = rectPanel(0, 1, 0, 2.8, 4);
/** A smaller panel in FRONT of the base, covering x,y in [0.5, 2.5]. */
export const COVER = rectPanel(1, 0, 1, 1, 1, 1.5, 1.5);

/** n screws of one colour on the base panel, laid out along a row `y`. */
export function row(startId: number, color: ScrewColor, y: number, n: number, panelId = 0): ScrewDef[] {
  return Array.from({ length: n }, (_, i) => screw(startId + i, panelId, -2 + i, y, color));
}
