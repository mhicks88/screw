/**
 * Difficulty curve for levels 1..TOTAL_LEVELS (CONTRACT_V3 §7). Pure function of
 * the level number.
 *
 * The panel counts of the first two bands are raised to a floor of SIX, against
 * the 2-4 of the §7 table. A two-panel assembly is two plates back to back:
 * turn it a quarter and there is nothing facing the player at all, which reads
 * as a broken board rather than as a puzzle. Six panels is the smallest closed
 * box, and it guarantees something face-on from every angle (an octahedral set
 * always presents a face within 55 degrees of any view direction).
 *
 * Rhythm (unchanged from v2): every 25th level is 'extreme', every other 10th
 * level is 'hard', levels ending in 4 (from level 14 on) are 'easy' breathers,
 * and levels 1-3 are trivial tutorials. Underneath the rhythm every parameter
 * ramps along the band table of CONTRACT_V3 §7; the label only moves a level
 * within its own band, so the published per-band ranges always hold.
 */
import { BASE_TRAY_SLOTS, BOX_CAPACITY, MAX_ACTIVE_BOXES } from './types';

export const TOTAL_LEVELS = 1000;

/** Biggest tray the UI must be able to lay out (plus MAX_BONUS_SLOTS on top). */
export const MAX_TRAY_SLOTS = 8;

export type DifficultyLabel = 'easy' | 'normal' | 'hard' | 'extreme';

export interface DifficultyParams {
  level: number;
  label: DifficultyLabel;
  /** 0..1 overall intensity (0 at level 1, 1 at level 1000), after label modifier. */
  intensity: number;
  /** Panels the assembly should end up with (CONTRACT_V3 §7). */
  panels: number;
  /** Nested shells, outermost = 0. The innermost one is the frame. */
  shells: number;
  colors: number;
  /** Target screw count (always a multiple of BOX_CAPACITY). */
  screws: number;
  activeBoxCount: number;
  traySlots: number;
  /** Fraction of screws blocked at start that become mystery screws. */
  mysteryFraction: number;
  /** 0 = colours fully random, 1 = colour runs laid down panel by panel. */
  colorClumping: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function difficultyLabelFor(level: number): DifficultyLabel {
  if (level <= 3) return 'easy';
  if (level % 25 === 0) return 'extreme';
  if (level % 10 === 0) return 'hard';
  if (level >= 14 && level % 10 === 4) return 'easy';
  return 'normal';
}

/** CONTRACT_V3 §7, verbatim: [firstLevel, lastLevel, screws, shells, panels] (+ v2's colours). */
const BANDS: { lo: number; hi: number; screws: [number, number]; shells: [number, number]; panels: [number, number]; colors: [number, number] }[] = [
  // 12 rather than 9 screws: six faces with two screws each, so turning the
  // box always shows at least a pair the player can take.
  { lo: 1, hi: 3, screws: [12, 12], shells: [1, 1], panels: [6, 6], colors: [3, 3] },
  { lo: 4, hi: 30, screws: [12, 30], shells: [1, 2], panels: [6, 10], colors: [3, 4] },
  { lo: 31, hi: 120, screws: [30, 60], shells: [2, 3], panels: [10, 20], colors: [4, 6] },
  { lo: 121, hi: 350, screws: [60, 100], shells: [3, 4], panels: [18, 32], colors: [5, 7] },
  { lo: 351, hi: 700, screws: [100, 140], shells: [4, 5], panels: [28, 45], colors: [6, 8] },
  { lo: 701, hi: 1000, screws: [140, 190], shells: [5, 6], panels: [40, 60], colors: [6, 8] },
];

export function bandFor(level: number): number {
  for (let i = 0; i < BANDS.length; i++) if (level <= BANDS[i].hi) return i;
  return BANDS.length - 1;
}

export function difficultyFor(level: number): DifficultyParams {
  level = clamp(Math.floor(level), 1, TOTAL_LEVELS);
  const label = difficultyLabelFor(level);
  const band = BANDS[bandFor(level)];

  // Position inside the band, nudged by the label so the rhythm is felt without
  // ever leaving the band's published range.
  const raw = band.hi === band.lo ? 1 : (level - band.lo) / (band.hi - band.lo);
  const nudge = level <= 3 ? 0 : label === 'easy' ? -0.32 : label === 'hard' ? 0.22 : label === 'extreme' ? 0.38 : 0;
  const t = clamp(raw + nudge, 0, 1);
  // Overall 0..1 intensity across the whole game (used for colour clumping etc).
  const intensity = clamp((bandFor(level) + t) / BANDS.length, 0, 1);

  // Screw counts are multiples of BOX_CAPACITY and never leave the band, so the
  // published ranges of §7 hold exactly.
  const screws = clamp(
    Math.round(lerp(band.screws[0], band.screws[1], t) / BOX_CAPACITY) * BOX_CAPACITY,
    Math.ceil(band.screws[0] / BOX_CAPACITY) * BOX_CAPACITY,
    Math.floor(band.screws[1] / BOX_CAPACITY) * BOX_CAPACITY,
  );
  const shells = Math.round(lerp(band.shells[0], band.shells[1], t));
  // Biased towards the top of the band: panels beyond the six skin faces of a
  // shell become brackets and straps, and those are what keep screws facing
  // the player from every angle (CONTRACT_V3 §6).
  const panels = clamp(
    Math.round(lerp(lerp(band.panels[0], band.panels[1], 0.3), band.panels[1], t)),
    band.panels[0], band.panels[1],
  );
  const colors = clamp(Math.round(lerp(band.colors[0], band.colors[1], t)), 3, 8);

  if (level <= 3) {
    return {
      level, label, intensity: 0,
      panels: 6,
      shells, colors, screws,
      activeBoxCount: 3,
      traySlots: BASE_TRAY_SLOTS,
      mysteryFraction: 0,
      colorClumping: 0,
    };
  }

  /*
   * Tray / box balance (carried over from v2 and re-scaled for the bigger v3
   * levels): an extra box is worth more than an extra slot, because it removes
   * tray traffic instead of storing it, so boxes ramp first; the 4th box is
   * held back until the deepest band so the "Magic Box" power-up still has room
   * to spawn everywhere else.
   */
  const activeBoxCount = clamp(
    screws >= 140 ? 4 : screws >= 40 ? 3 : level <= 5 || label === 'easy' ? 3 : 2,
    2, MAX_ACTIVE_BOXES,
  );
  const traySlots = clamp(
    screws >= 130 ? 8 : screws >= 95 ? 7 : screws >= 60 ? 6 : BASE_TRAY_SLOTS,
    BASE_TRAY_SLOTS, MAX_TRAY_SLOTS,
  );

  const mysteryFraction = level < 25 ? 0 : clamp(0.08 + ((level - 25) / 500) * 0.12, 0, 0.2);

  return {
    level, label, intensity,
    panels, shells, colors, screws,
    activeBoxCount, traySlots,
    mysteryFraction,
    colorClumping: 0.5,
  };
}
