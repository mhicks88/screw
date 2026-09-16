/**
 * Difficulty curve for levels 1..TOTAL_LEVELS (CONTRACT_V2 §6). Pure function of
 * the level number.
 *
 * Rhythm (unchanged): every 25th level is 'extreme', every other 10th level is
 * 'hard', levels ending in 4 (from level 14 on) are 'easy' breathers, and levels
 * 1-3 are trivial tutorials. Underneath the rhythm every parameter ramps along
 * the band table of CONTRACT_V2 §6; the label only moves a level within its own
 * band, so the published per-band ranges always hold.
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
  /** Upper bound on the number of plates the layout may use. */
  plates: number;
  layers: number;
  /** Interlocking tower footprints (CONTRACT_V2 §4). */
  towers: number;
  colors: number;
  /** Target screw count (always a multiple of BOX_CAPACITY). */
  screws: number;
  activeBoxCount: number;
  traySlots: number;
  /** Fraction of screws blocked at start that become mystery screws. */
  mysteryFraction: number;
  /** 0 = colours fully random, 1 = colour runs laid down plate by plate. */
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

/** CONTRACT_V2 §6, verbatim: [firstLevel, lastLevel, screws, layers, towers, colours]. */
const BANDS: { lo: number; hi: number; screws: [number, number]; layers: [number, number]; towers: [number, number]; colors: [number, number] }[] = [
  { lo: 1, hi: 3, screws: [9, 12], layers: [1, 2], towers: [1, 1], colors: [3, 3] },
  { lo: 4, hi: 30, screws: [12, 30], layers: [3, 5], towers: [1, 2], colors: [3, 4] },
  { lo: 31, hi: 120, screws: [30, 55], layers: [5, 8], towers: [2, 2], colors: [4, 6] },
  { lo: 121, hi: 350, screws: [55, 90], layers: [8, 11], towers: [2, 3], colors: [5, 7] },
  { lo: 351, hi: 700, screws: [90, 125], layers: [10, 13], towers: [3, 3], colors: [6, 8] },
  { lo: 701, hi: 1000, screws: [125, 150], layers: [12, 15], towers: [3, 4], colors: [6, 8] },
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
  // published ranges of §6 hold exactly.
  const screws = clamp(
    Math.round(lerp(band.screws[0], band.screws[1], t) / BOX_CAPACITY) * BOX_CAPACITY,
    Math.ceil(band.screws[0] / BOX_CAPACITY) * BOX_CAPACITY,
    Math.floor(band.screws[1] / BOX_CAPACITY) * BOX_CAPACITY,
  );
  const layers = Math.round(lerp(band.layers[0], band.layers[1], t));
  const towers = Math.round(lerp(band.towers[0], band.towers[1], t));
  const colors = clamp(Math.round(lerp(band.colors[0], band.colors[1], t)), 3, 8);

  if (level <= 3) {
    return {
      level, label, intensity: 0,
      plates: level === 1 ? 2 : 3,
      layers, towers, colors, screws,
      activeBoxCount: 3,
      traySlots: BASE_TRAY_SLOTS,
      mysteryFraction: 0,
      colorClumping: 0,
    };
  }

  // Plate budget: towers stack a plate on most of their layers, staggered.
  const plates = clamp(Math.round(Math.max(2, towers) * layers * 0.95), 3, 40);

  /*
   * Tray / box balance (CONTRACT_V2 §6), tuned by experiment rather than guess:
   * generating 24 layouts per setting and measuring how often the planning bot
   * and a naive (non-planning) bot win gives, for a 117-screw level,
   *
   *      5 slots / 2 boxes → 21% winnable at all,  5% for a naive player
   *      7 slots / 3 boxes → 58% winnable,        18% naive
   *      7 slots / 4 boxes → 83% winnable,        36% naive
   *
   * and for a 150-screw level 50%/2% at 5+2 versus 96%/46% at 8+4. An extra box
   * is worth more than an extra slot (it removes tray traffic instead of storing
   * it), so boxes ramp first; the 4th box is held back until the deepest band so
   * that the "Magic Box" power-up still has room to spawn everywhere else.
   */
  const activeBoxCount = clamp(
    screws >= 125 ? 4 : screws >= 40 ? 3 : level <= 5 || label === 'easy' ? 3 : 2,
    2, MAX_ACTIVE_BOXES,
  );
  const traySlots = clamp(
    screws >= 120 ? 8 : screws >= 85 ? 7 : screws >= 55 ? 6 : BASE_TRAY_SLOTS,
    BASE_TRAY_SLOTS, MAX_TRAY_SLOTS,
  );

  const mysteryFraction = level < 25 ? 0 : clamp(0.08 + ((level - 25) / 500) * 0.12, 0, 0.2);

  return {
    level, label, intensity,
    plates, layers, towers, colors, screws,
    activeBoxCount, traySlots,
    mysteryFraction,
    colorClumping: 0.5,
  };
}
