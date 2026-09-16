/**
 * Difficulty curve for levels 1..TOTAL_LEVELS. Pure function of the level number.
 *
 * Rhythm: every 25th level is 'extreme', every other 10th level is 'hard',
 * levels ending in 4 (from level 14 on) are 'easy' breathers, and levels 1-3 are
 * trivial tutorials. Underneath the rhythm all parameters ramp smoothly with a
 * saturating curve so late levels are dense but still fit on the board.
 */
import { BASE_TRAY_SLOTS } from './types';

export const TOTAL_LEVELS = 1000;

export type DifficultyLabel = 'easy' | 'normal' | 'hard' | 'extreme';

export interface DifficultyParams {
  level: number;
  label: DifficultyLabel;
  /** 0..1 overall intensity used by the generator (after label modifier). */
  intensity: number;
  plates: number;
  layers: number;
  colors: number;
  /** Target screw count (always a multiple of BOX_CAPACITY). */
  screws: number;
  activeBoxCount: number;
  traySlots: number;
  /** Fraction of screws blocked at start that become mystery screws. */
  mysteryFraction: number;
  /** Plate size (major half-extent) range for upper-layer plates. */
  plateSizeMin: number;
  plateSizeMax: number;
  /** 0 = colours fully random, 1 = colour runs laid down plate by plate. */
  colorClumping: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function difficultyLabelFor(level: number): DifficultyLabel {
  if (level <= 3) return 'easy';
  if (level % 25 === 0) return 'extreme';
  if (level % 10 === 0) return 'hard';
  if (level >= 14 && level % 10 === 4) return 'easy';
  return 'normal';
}

export function difficultyFor(level: number): DifficultyParams {
  level = clamp(Math.floor(level), 1, TOTAL_LEVELS);
  const label = difficultyLabelFor(level);

  // Smooth saturating ramp: ~0.13 at L25, ~0.43 at L100, ~0.81 at L300, ~0.99 at L800.
  const base = 1 - Math.exp(-level / 180);
  const mod = label === 'easy' ? -0.18 : label === 'hard' ? 0.1 : label === 'extreme' ? 0.2 : 0;
  const e = clamp(base + mod, 0, 1);

  if (level <= 3) {
    return {
      level, label, intensity: 0,
      plates: level === 1 ? 2 : 3,
      layers: level === 1 ? 1 : 2,
      colors: 3,
      screws: level === 1 ? 9 : 12,
      activeBoxCount: 3,
      traySlots: BASE_TRAY_SLOTS,
      mysteryFraction: 0,
      plateSizeMin: 1.6,
      plateSizeMax: 2.2,
      colorClumping: 0,
    };
  }

  const activeBoxCount = level <= 5 || label === 'easy' ? 3 : 2;
  // Breathers keep 3 boxes but, past the tutorial band, still one more colour than boxes.
  const colors = clamp(Math.max(3 + Math.round(e * 6), level > 30 ? activeBoxCount + 1 : 3), 3, 8);
  const boxes = clamp(4 + Math.round(e * 6) + (label === 'extreme' ? 1 : 0), 4, 11);
  const plates = clamp(3 + Math.round(e * 5), 3, 8);
  const layers = clamp(2 + Math.round(e * 3), 2, 5);
  const mysteryFraction = level < 25 ? 0 : clamp(0.1 + ((level - 25) / 400) * 0.25, 0, 0.35);

  return {
    level, label, intensity: e,
    plates, layers, colors,
    screws: boxes * 3,
    activeBoxCount,
    traySlots: BASE_TRAY_SLOTS,
    mysteryFraction,
    plateSizeMin: 1.4 - e * 0.3,
    plateSizeMax: 2.3 - e * 0.5,
    colorClumping: 0.5,
  };
}
