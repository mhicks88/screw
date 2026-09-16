/**
 * Colour "need" accounting shared by the Game power-ups (addBox / recolor) and
 * the generator's lazy box-colour provider.
 */
import { ALL_COLORS, BOX_CAPACITY, type ScrewColor } from './types';
import type { Game } from './game';

export interface ColorNeed {
  color: ScrewColor;
  /** Screws of this colour waiting in the tray. */
  tray: number;
  /** Reachable screws of this colour still on plates. */
  reachable: number;
  /** All screws of this colour still on plates (reachable or blocked). */
  onPlate: number;
  /**
   * Screws of this colour not yet accounted for by an active box:
   * tray + onPlate - free slots in active boxes of that colour.
   */
  unassigned: number;
}

export function colorNeeds(game: Game): Map<ScrewColor, ColorNeed> {
  const needs = new Map<ScrewColor, ColorNeed>();
  for (const c of ALL_COLORS) needs.set(c, { color: c, tray: 0, reachable: 0, onPlate: 0, unassigned: 0 });
  for (const s of game.peekScrews()) {
    const n = needs.get(s.color)!;
    if (s.location === 'tray') n.tray++;
    else if (s.location === 'plate') {
      n.onPlate++;
      if (!s.blocked) n.reachable++;
    }
  }
  for (const n of needs.values()) n.unassigned = n.tray + n.onPlate;
  for (const b of game.peekBoxes()) {
    const n = needs.get(b.color)!;
    n.unassigned -= BOX_CAPACITY - b.screws.length;
  }
  return needs;
}

/**
 * Order candidates by how much they would help right now: tray screws first,
 * then reachable screws, then everything still on plates. Deterministic.
 */
export function rankByNeed(needs: Map<ScrewColor, ColorNeed>, candidates: readonly ScrewColor[]): ScrewColor[] {
  const score = (c: ScrewColor) => {
    const n = needs.get(c)!;
    return [n.tray, n.reachable, n.onPlate] as const;
  };
  return [...candidates].sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < 3; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return ALL_COLORS.indexOf(a) - ALL_COLORS.indexOf(b);
  });
}

/**
 * Lazy queue colour provider used while generating a level: whenever a box
 * must spawn, choose the colour most present in the tray, then among reachable
 * screws, then any colour that still has unassigned screws. Returns undefined
 * when every remaining screw already has a box.
 *
 * The simultaneously active boxes must show DISTINCT colours whenever the
 * remaining pool still offers a choice. Four boxes that all want red give the
 * player one front, not four, however many plates are reachable — which defeats
 * the point of CONTRACT_V2 §5. A duplicate is therefore only allowed when every
 * colour that still needs a box is already on the board (late in a level, or
 * when one colour needs more boxes than there are free positions).
 */
export function chooseLazyBoxColor(game: Game): ScrewColor | undefined {
  const needs = colorNeeds(game);
  let candidates = ALL_COLORS.filter((c) => needs.get(c)!.unassigned > 0);
  if (candidates.length === 0) return undefined;
  const active = new Set(game.peekBoxes().map((b) => b.color));
  const fresh = candidates.filter((c) => !active.has(c));
  if (fresh.length > 0) candidates = fresh;
  // Prefer a colour whose box can be completed from what is available right
  // now (tray first, then reachable), then tray relief, then future supply.
  const score = (c: ScrewColor) => {
    const n = needs.get(c)!;
    const available = Math.min(BOX_CAPACITY, n.tray + n.reachable);
    return available * 10 + n.tray * 3 + n.reachable + n.onPlate * 0.05;
  };
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = score(c);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}
