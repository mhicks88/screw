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
 *
 * WHAT MAKES A LEVEL HARD (v3.1). The screw count is how LONG a level is, not
 * how hard: the game is lost in the tray and nowhere else, so difficulty is the
 * rate at which screws are forced into it. That rate is colours against open
 * boxes, and nothing else comes close. v3.0 ramped the screw count with depth
 * while ALSO growing the tray from five slots to eight and the boxes from two to
 * four, and the two cancelled out: measured with the generator's own naive-bot
 * proxy, level 1000 played itself 11 times in 12 while level 50 did 7 — the game
 * peaked around level 40 and got easier from there. Now the palette reaches all
 * eight colours by level 25, boxes sit at two from level 5 on, and the tray
 * never grows at all.
 */
import { BASE_TRAY_SLOTS, BOX_CAPACITY, MAX_ACTIVE_BOXES } from './types';

export const TOTAL_LEVELS = 1000;

/**
 * Biggest tray the UI must be able to lay out. No level starts wider than
 * BASE_TRAY_SLOTS any more, but the "Extra Hole" power-up adds up to
 * MAX_BONUS_SLOTS on top of that during play, and 5 + 3 is what the row has to
 * hold.
 */
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

/**
 * CONTRACT_V3 §7, verbatim: [firstLevel, lastLevel, screws, shells, panels]
 * (+ v2's colours, which §7 does not publish and which are therefore free).
 *
 * The §7 band 4-30 is split in two here. Both halves stay inside its published
 * ranges (12-30 screws, 1-2 shells, 6-10 panels), but they are different games:
 *
 *   - Level 4 is a SINGLE shell, which means nothing is blocked and every screw
 *     is removable from move one. A single-shell level cannot really be lost —
 *     the naive bot always finds a match among a dozen reachable screws, at any
 *     tray size and any number of colours — so exactly one level is spent on it,
 *     as the bridge out of the tutorials.
 *   - 5-30 is TWO shells. That is where the curve actually starts: outer panels
 *     hide inner ones, only part of the assembly is reachable at any moment, and
 *     the colours the player needs are usually the ones behind.
 *
 * Colours ramp to the full palette of eight by level 25 and stay there. Colours
 * against open boxes is the whole pressure of the game: two boxes against eight
 * colours means three quarters of what is reachable has nowhere to go but the
 * tray, and the tray is the only place a level can be lost.
 */
const BANDS: { lo: number; hi: number; screws: [number, number]; shells: [number, number]; panels: [number, number]; colors: [number, number] }[] = [
  // 12 rather than 9 screws: six faces with two screws each, so turning the
  // box always shows at least a pair the player can take.
  { lo: 1, hi: 3, screws: [12, 12], shells: [1, 1], panels: [6, 6], colors: [3, 3] },
  { lo: 4, hi: 4, screws: [15, 15], shells: [1, 1], panels: [7, 7], colors: [4, 4] },
  { lo: 5, hi: 30, screws: [21, 30], shells: [2, 2], panels: [8, 10], colors: [6, 8] },
  { lo: 31, hi: 120, screws: [30, 60], shells: [2, 3], panels: [10, 20], colors: [8, 8] },
  { lo: 121, hi: 350, screws: [60, 100], shells: [3, 4], panels: [18, 32], colors: [8, 8] },
  { lo: 351, hi: 700, screws: [100, 140], shells: [4, 5], panels: [28, 45], colors: [8, 8] },
  { lo: 701, hi: 1000, screws: [140, 190], shells: [5, 6], panels: [40, 60], colors: [8, 8] },
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
  const nudge = level <= 3 ? 0 : label === 'easy' ? -0.2 : label === 'hard' ? 0.22 : label === 'extreme' ? 0.38 : 0;
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
  // Biased hard towards the top of the band: panels beyond the six skin faces
  // of a shell become brackets and straps, and those are what keep screws
  // facing the player from every angle (CONTRACT_V3 §6). The bias was 0.3 and
  // is now 0.55, because two open boxes put more screws in the tray and a screw
  // in the tray is a screw off the board: the assembly has to carry more faces
  // to keep every viewing angle worth turning to.
  const panels = clamp(
    Math.round(lerp(lerp(band.panels[0], band.panels[1], 0.55), band.panels[1], t)),
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
   * Tray / box balance. THIS is the difficulty dial, not the screw count: a
   * screw count is how LONG a level is, but the ratio of colours in play to
   * open boxes is what forces screws into the tray, and the tray is the only
   * place a level can be lost.
   *
   * v3.0 grew both with depth (up to 4 boxes and 8 slots at level 1000) and so
   * cancelled out everything else the deep bands added: the naive-bot proxy won
   * 11/12 at level 1000 against 7/12 at level 50. Both are now held down.
   *
   *   - TWO boxes is the default, from level 5 to level 1000. Two boxes against
   *     six to eight colours is the pressure. Three is for the single-shell
   *     bridge level only, which cannot be lost anyway. Four is never shipped:
   *     the "Magic Box" power-up needs a free box position to spawn into, and a
   *     level that has already spent it has one power-up fewer.
   *   - The tray stays at BASE_TRAY_SLOTS for the whole game. Growing it to
   *     eight slots at the deep end was the single largest piece of the old
   *     curve's collapse — every slot added is difficulty removed, and three
   *     extra slots cancelled out everything the deep bands added. The top band
   *     was measured at five slots before this was written: 141 to 189 screws
   *     over eight colours with two boxes still generates winnable and inside
   *     the time budget, and the player can still buy up to MAX_BONUS_SLOTS
   *     more with the "Extra Hole" power-up.
   */
  const activeBoxCount = clamp(level <= 4 ? 3 : 2, 2, MAX_ACTIVE_BOXES);
  const traySlots = BASE_TRAY_SLOTS;

  // Mystery screws hide a colour until the screw first becomes reachable, so
  // the player has to plan the tray around an unknown. They start once the
  // tray has been taught (the first 'hard' level after the tutorial band).
  const mysteryFraction = level < 15 ? 0 : clamp(0.1 + ((level - 15) / 400) * 0.15, 0, 0.25);

  return {
    level, label, intensity,
    panels, shells, colors, screws,
    activeBoxCount, traySlots,
    mysteryFraction,
    /*
     * Which way colour clumping cuts depends on how much of the assembly is
     * reachable at once, and that flips over the course of the game.
     *
     * While only a handful of screws are reachable, MIXED colours are the
     * pressure: the four or five screws in front of the player are four or five
     * different colours and at most two of them have a box. Once the assembly
     * is big enough to offer a dozen reachable screws at a time, mixing is a
     * gift instead — something always matches — and CLUMPED colours are what
     * bites, because a whole front can come up in colours that have no box.
     * Measured with the naive-bot proxy: at level 100 mixing wins (mean 5.9
     * against 7.7 clumped), at level 1000 clumping wins (0.1 against 1.9).
     */
    colorClumping: clamp(lerp(0.15, 0.95, (level - 120) / 480), 0.15, 0.95),
  };
}
