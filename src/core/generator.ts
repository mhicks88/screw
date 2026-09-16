/**
 * Deterministic level generator. `generateLevel(n)` always returns the same
 * LevelDef for the same n: the seed is a hash of (n, attempt) and the first
 * attempt that yields a winnable, sufficiently interesting level wins. The
 * box queue is recorded from a bot play-through with a lazy colour provider.
 */
import { ALL_COLORS, BOX_CAPACITY, type LevelDef, type PlateDef, type ScrewColor, type ScrewDef } from './types';
import { Rng, hashSeed } from './rng';
import { difficultyFor, TOTAL_LEVELS, type DifficultyParams } from './difficulty';
import { placePlates, placeScrews, trimToMultiple, type Layout } from './placement';
import { plateContainsWorldPoint } from './geometry';
import { Game } from './game';
import { chooseLazyBoxColor } from './colorChoice';
import { playBot, type BotResult } from './bot';

export { TOTAL_LEVELS };

const MAX_ATTEMPTS = 400;

/**
 * Assign colours so that each colour count is a multiple of BOX_CAPACITY.
 * `clumping` in [0, 1] controls how much screws on the same plate share
 * colours: 0 = fully random, 1 = colour runs laid down plate by plate.
 */
export function assignColors(layout: Layout, params: DifficultyParams, rng: Rng, clumping: number): ScrewColor[] {
  const count = layout.screws.length;
  const boxes = count / BOX_CAPACITY;
  const k = Math.max(1, Math.min(params.colors, boxes, ALL_COLORS.length));
  const palette = rng.shuffle([...ALL_COLORS]).slice(0, k);
  const perColor = new Array(k).fill(1);
  for (let i = k; i < boxes; i++) perColor[rng.int(0, k - 1)]++;
  // Runs of the same colour, in random colour order.
  const runs: ScrewColor[] = [];
  for (const i of rng.shuffle(perColor.map((_, i) => i))) for (let j = 0; j < perColor[i] * BOX_CAPACITY; j++) runs.push(palette[i]);
  // Screw order: grouped by plate (random plate order, random order inside).
  const plateOrder = rng.shuffle(layout.plates.map((p) => p.id));
  const order = layout.screws.map((s, i) => ({ i, key: plateOrder.indexOf(s.plateId) + rng.next() * 0.99 }))
    .sort((a, b) => a.key - b.key).map((o) => o.i);
  const colors: ScrewColor[] = new Array(count);
  order.forEach((si, j) => { colors[si] = runs[j]; });
  // Break the runs up with random swaps.
  const swaps = Math.round(count * (1 - clumping));
  for (let n = 0; n < swaps; n++) {
    const a = rng.int(0, count - 1), b = rng.int(0, count - 1);
    const t = colors[a]; colors[a] = colors[b]; colors[b] = t;
  }
  return colors;
}

function buildDef(level: number, seed: number, params: DifficultyParams, layout: Layout, colors: ScrewColor[], rng: Rng): LevelDef {
  const plates: PlateDef[] = layout.plates.map((p, i) => ({ ...p, id: i }));
  const idMap = new Map(layout.plates.map((p, i) => [p.id, i]));
  const screws: ScrewDef[] = layout.screws.map((s, i) => ({
    id: i, plateId: idMap.get(s.plateId)!, x: s.x, y: s.y, color: colors[i], hidden: false,
  }));
  // Mystery screws: a fraction of the screws blocked at start.
  if (params.mysteryFraction > 0) {
    const blocked = screws.filter((s) => {
      const layer = plates[s.plateId].layer;
      return plates.some((p) => p.layer > layer && plateContainsWorldPoint(p, s.x, s.y));
    });
    const n = Math.round(blocked.length * params.mysteryFraction);
    for (const s of rng.shuffle(blocked).slice(0, n)) s.hidden = true;
  }
  return {
    level, seed, plates, screws, boxQueue: [], activeBoxCount: params.activeBoxCount, traySlots: params.traySlots,
    colors: [...new Set(colors)].sort((a, b) => ALL_COLORS.indexOf(a) - ALL_COLORS.indexOf(b)),
    difficulty: params.label,
  };
}

/** Bot play-through with a lazy queue; returns the recorded queue on success. */
export function simulateWithLazyQueue(def: LevelDef, seed: number): BotResult & { queue: ScrewColor[] } {
  const game = new Game({ ...def, boxQueue: [] }, { boxColorProvider: chooseLazyBoxColor });
  const res = playBot(game, seed);
  return { ...res, queue: [...game.peekQueue()] };
}

const NAIVE_RUNS = 8;

/**
 * Difficulty gate. The planning bot proves the level is winnable; a naive bot
 * (random matching, random tray choices) then replays the FIXED queue several
 * times and its win count tells how forgiving the level is. Later levels (and
 * 'hard'/'extreme' ones) must be less forgiving. The gate relaxes every 30
 * failed attempts so generation always terminates.
 */
function naiveWinLimits(level: number, params: DifficultyParams, attempt: number): { max: number; min: number } {
  const relax = Math.floor(attempt / 30);
  if (level <= 30 || params.activeBoxCount >= 3) return { max: NAIVE_RUNS, min: 0 };
  let max = level <= 60 ? 7 : level <= 150 ? 6 : level <= 400 ? 5 : 4;
  if (params.label === 'hard') max -= 1;
  else if (params.label === 'extreme') max -= 2;
  max = Math.min(NAIVE_RUNS, max + relax);
  const min = level < 200 && relax === 0 ? 1 : 0;
  return { max, min };
}

function naiveWins(def: LevelDef): number {
  let wins = 0;
  for (let k = 0; k < NAIVE_RUNS; k++) {
    if (playBot(new Game(def), hashSeed(def.seed, k + 1), { naive: true }).outcome === 'won') wins++;
  }
  return wins;
}

export interface GenerationStats { attempts: number; naiveWins: number }
const lastStats: GenerationStats = { attempts: 0, naiveWins: -1 };
export function lastGenerationStats(): GenerationStats { return { ...lastStats }; }

export function generateLevel(level: number): LevelDef {
  if (!Number.isInteger(level) || level < 1 || level > TOTAL_LEVELS) {
    throw new RangeError(`level must be an integer in 1..${TOTAL_LEVELS}`);
  }
  const params = difficultyFor(level);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = hashSeed(level, attempt);
    const rng = new Rng(seed);
    // After repeated failures shrink the screw target (never below 9).
    const reduce = BOX_CAPACITY * Math.floor(attempt / 40);
    const target = Math.max(9, params.screws - reduce);
    const plates = placePlates(params, rng);
    if (plates.length < 2) continue;
    let layout = placeScrews(plates, target, rng);
    layout = trimToMultiple(layout, BOX_CAPACITY, rng);
    const count = layout.screws.length;
    if (count < 9 || count % BOX_CAPACITY !== 0 || count < target * 0.6) continue;
    if (layout.plates.length < 2) continue;
    const colors = assignColors(layout, params, rng, params.colorClumping);
    const def = buildDef(level, seed, params, layout, colors, rng);
    const sim = simulateWithLazyQueue(def, seed);
    if (sim.outcome !== 'won') continue;
    if (sim.queue.length !== count / BOX_CAPACITY) continue;
    const final: LevelDef = { ...def, boxQueue: sim.queue };
    const { max, min } = naiveWinLimits(level, params, attempt);
    if (max < NAIVE_RUNS || min > 0) {
      const wins = naiveWins(final);
      if (wins > max || wins < min) continue;
      lastStats.naiveWins = wins;
    } else lastStats.naiveWins = -1;
    lastStats.attempts = attempt + 1;
    return final;
  }
  throw new Error(`generateLevel(${level}): could not produce a winnable level`);
}
