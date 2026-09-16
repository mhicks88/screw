/**
 * Deterministic level generator. `generateLevel(n)` always returns the same
 * LevelDef for the same n: the seed is a hash of (n, attempt), and the level is
 * the BEST of 80-110 candidates rather than the first passable one (the ~2 s
 * budget of CONTRACT_V2 §7 buys quality, not just a pass). The box queue is
 * recorded from a bot play-through with a lazy colour provider.
 *
 * Every candidate must:
 *   1. have the right shape   — enough screws, >= 2 plates, not bottom-heavy (§4)
 *   2. be winnable            — the planning bot wins with a lazily chosen queue
 * and is then ranked by the §5 non-linearity statistics measured over that
 * play-through plus how close it lands to the band's size/depth targets. The
 * best candidate that also survives the "not too forgiving" naive-bot gate wins.
 */
import { ALL_COLORS, BOX_CAPACITY, type LevelDef, type PlateDef, type ScrewColor, type ScrewDef } from './types';
import { Rng, hashSeed } from './rng';
import { difficultyFor, TOTAL_LEVELS, type DifficultyParams } from './difficulty';
import { bottomLayerFraction, compactLayers, placePlates, placeScrews, trimToMultiple, type Layout } from './placement';
import { plateContainsWorldPoint } from './geometry';
import { Game } from './game';
import { chooseLazyBoxColor } from './colorChoice';
import { playBot, type BotResult } from './bot';

export { TOTAL_LEVELS };

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
  const plateRank = new Map(rng.shuffle(layout.plates.map((p) => p.id)).map((id, i) => [id, i]));
  const order = layout.screws.map((s, i) => ({ i, key: plateRank.get(s.plateId)! + rng.next() * 0.99 }))
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
  const res = playBot(game, seed, { trace: true });
  return { ...res, queue: [...game.peekQueue()] };
}

/* ------------------------------------------------ non-linearity (§5) */

export interface LevelStats {
  level: number;
  screws: number;
  plates: number;
  layers: number;
  /** Fraction of screws sitting on the bottom layer (CONTRACT_V2 §4: <= 0.35). */
  bottomLayerFraction: number;
  /** Screws reachable at the very start of the level. */
  startReachable: number;
  /** Most screws simultaneously reachable during the play-through. */
  peakReachable: number;
  /** Mean reachable screws per step over the whole play-through (§5). */
  avgReachable: number;
  /** Fewest reachable screws outside the final 5 moves. */
  minReachable: number;
  /** Mean number of distinct plates holding a reachable screw (§5). */
  avgFronts: number;
  /** Longest stretch of consecutive steps with fewer than 3 reachable screws. */
  maxChokeRun: number;
  /** Distinct colours among the active boxes at the very start of the level. */
  startBoxColors: number;
  /** Mean number of distinct colours among the active boxes over the play-through. */
  avgBoxColors: number;
  /** Taps in the proven winning line (one per screw). */
  steps: number;
}

export interface NonLinearityTargets {
  avgReachable: number;
  minReachable: number;
  avgFronts: number;
  maxChokeRun: number;
  /** Distinct colours the starting boxes must show (§5: N boxes, N fronts). */
  startBoxColors: number;
}

/**
 * CONTRACT_V2 §5 thresholds. Full strength from level 50 on; below that they
 * ramp down, because a 12-screw tutorial cannot offer 8 reachable screws.
 */
export function nonLinearityTargets(level: number): NonLinearityTargets {
  const params = difficultyFor(level);
  // Every starting box must want a different colour whenever the palette allows.
  const startBoxColors = Math.min(params.activeBoxCount, params.colors);
  if (level <= 5) return { avgReachable: 0, minReachable: 1, avgFronts: 0, maxChokeRun: 999, startBoxColors };
  const s = Math.min(1, (level - 5) / 45);
  return {
    avgReachable: 3 + 5 * s,
    minReachable: s >= 1 ? 3 : s > 0.5 ? 2 : 1,
    avgFronts: 1.2 + 1.8 * s,
    maxChokeRun: Math.round(10 - 7 * s),
    startBoxColors,
  };
}

const TAIL = 5; // the last few moves of any level are necessarily forced

function statsFrom(def: LevelDef, res: BotResult): LevelStats {
  const reach = res.reachPerStep ?? [];
  const fronts = res.frontsPerStep ?? [];
  const boxColors = res.boxColorsPerStep ?? [];
  const body = reach.length > TAIL ? reach.slice(0, reach.length - TAIL) : reach.slice(0, 1);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  let run = 0, maxRun = 0;
  for (const r of body) {
    run = r < 3 ? run + 1 : 0;
    if (run > maxRun) maxRun = run;
  }
  const layers = new Set(def.plates.map((p) => p.layer));
  return {
    level: def.level,
    screws: def.screws.length,
    plates: def.plates.length,
    layers: layers.size,
    bottomLayerFraction: bottomLayerFraction(def.plates, def.screws),
    startReachable: reach.length ? reach[0] : 0,
    peakReachable: reach.length ? Math.max(...reach) : 0,
    avgReachable: mean(reach),
    minReachable: body.length ? Math.min(...body) : 0,
    avgFronts: mean(fronts),
    maxChokeRun: maxRun,
    startBoxColors: boxColors.length ? boxColors[0] : 0,
    avgBoxColors: mean(boxColors),
    steps: res.steps,
  };
}

/**
 * Replay a level's recorded queue with the same bot/seed used at generation
 * time and report its §5 statistics. Deterministic, and identical to what the
 * generator measured.
 */
export function measureLevel(def: LevelDef): LevelStats {
  const res = playBot(new Game(def), def.seed, { trace: true });
  return statsFrom(def, res);
}

/**
 * The exact winning line the generator proved: tapping these screw ids in order
 * through the public Game API clears the level. Deterministic.
 */
export function winningMoves(def: LevelDef): number[] {
  return playBot(new Game(def), def.seed, { trace: true }).picks ?? [];
}

function meetsTargets(stats: LevelStats, targets: NonLinearityTargets): boolean {
  return stats.avgReachable >= targets.avgReachable
    && stats.minReachable >= targets.minReachable
    && stats.avgFronts >= targets.avgFronts
    && stats.maxChokeRun < Math.max(4, targets.maxChokeRun + 1)
    && stats.startBoxColors >= targets.startBoxColors;
}

/* ------------------------------------------------------- difficulty gate */

function naiveRuns(screws: number): number { return screws > 90 ? 4 : screws > 45 ? 6 : 8; }

/**
 * Difficulty gate. The planning bot proves the level is winnable; a naive bot
 * (random matching, random tray choices) then replays the FIXED queue several
 * times and its win count tells how forgiving the level is. Later levels (and
 * 'hard'/'extreme' ones) must be less forgiving, early ones must not be brutal.
 * Levels with the full four boxes are hard enough by construction (a naive bot
 * clears a 150-screw level less than half the time), so they skip the gate.
 * The gate only ranks candidates — if none passes, the best is used anyway, so
 * generation always terminates.
 */
function naiveWinLimits(level: number, params: DifficultyParams): { max: number; min: number } {
  const runs = naiveRuns(params.screws);
  if (level <= 30 || params.activeBoxCount >= 4) return { max: runs, min: 0 };
  let max = Math.round(runs * (level <= 60 ? 0.85 : level <= 150 ? 0.75 : level <= 400 ? 0.62 : 0.5));
  if (params.label === 'hard') max -= 1;
  else if (params.label === 'extreme') max -= 2;
  max = Math.min(runs, Math.max(0, max));
  const min = level < 200 ? 1 : 0;
  return { max, min };
}

function naiveWins(def: LevelDef, runs: number): number {
  let wins = 0;
  for (let k = 0; k < runs; k++) {
    if (playBot(new Game(def), hashSeed(def.seed, k + 1), { naive: true }).outcome === 'won') wins++;
  }
  return wins;
}

/* ----------------------------------------------------------- generation */

export interface GenerationStats extends LevelStats {
  attempts: number;
  naiveWins: number;
  /** Wall-clock milliseconds spent in the last generateLevel call. */
  ms: number;
}

let lastStats: GenerationStats | undefined;
export function lastGenerationStats(): GenerationStats | undefined {
  return lastStats ? { ...lastStats } : undefined;
}

/**
 * Quality of a candidate level: how far it clears the §5 bar, how close it is
 * to the band's target size/depth, and how sane its exposed-screw count is.
 * The generator keeps the best candidate it saw rather than the first passable
 * one — with a ~2 s budget that is a far better use of the time (CONTRACT_V2 §7).
 */
function quality(stats: LevelStats, t: NonLinearityTargets, params: DifficultyParams): number {
  const ratio = (v: number, target: number) => (target <= 0 ? 1 : Math.min(1.25, v / target));
  let q = 0;
  q += 2.2 * ratio(stats.avgReachable, t.avgReachable);
  q += 1.6 * ratio(stats.avgFronts, t.avgFronts);
  q -= 2.5 * Math.max(0, t.minReachable - stats.minReachable);
  q -= 0.8 * Math.max(0, stats.maxChokeRun - t.maxChokeRun);
  q += 3.0 * Math.min(1, stats.screws / params.screws) + (stats.screws >= params.screws ? 1.2 : 0);
  q += 1.2 * Math.min(1, stats.layers / params.layers);
  q += 0.5 * Math.min(1, stats.plates / Math.max(2, params.plates));
  q -= 3.0 * Math.max(0, stats.bottomLayerFraction - 0.35);
  q -= 0.35 * Math.max(0, stats.peakReachable - 28);
  q -= 2.0 * Math.max(0, t.startBoxColors - stats.startBoxColors);
  return q;
}

/** Attempts per level; each costs a layout plus one bot play-through. */
function attemptBudget(params: DifficultyParams): number {
  return params.screws >= 120 ? 80 : params.screws >= 60 ? 100 : 110;
}

const KEEP = 5;

interface Candidate { def: LevelDef; stats: LevelStats; score: number; attempt: number }

export function generateLevel(level: number): LevelDef {
  if (!Number.isInteger(level) || level < 1 || level > TOTAL_LEVELS) {
    throw new RangeError(`level must be an integer in 1..${TOTAL_LEVELS}`);
  }
  const t0 = Date.now();
  const params = difficultyFor(level);
  const targets = nonLinearityTargets(level);
  const budget = attemptBudget(params);
  // Tier 1: right size + depth AND every §5 criterion. Tier 2: right size and
  // depth. Tier 3: anything winnable. The best candidate of the highest
  // non-empty tier wins, so a level never silently shrinks out of its band.
  const tier1: Candidate[] = [];
  const tier2: Candidate[] = [];
  const tier3: Candidate[] = [];
  const keep = (list: Candidate[], c: Candidate) => {
    list.push(c);
    list.sort((a, b) => b.score - a.score);
    if (list.length > KEEP) list.length = KEEP;
  };

  for (let attempt = 0; attempt < budget; attempt++) {
    const seed = hashSeed(level, attempt);
    const rng = new Rng(seed);
    const target = params.screws;

    const plates = placePlates(params, rng);
    if (plates.length < 2) continue;
    let layout = placeScrews(plates, target, rng);
    layout = trimToMultiple(layout, BOX_CAPACITY, rng, target);
    compactLayers(layout.plates);
    const count = layout.screws.length;
    if (count < 9 || count % BOX_CAPACITY !== 0 || count < target * 0.5) continue;
    if (layout.plates.length < 2) continue;
    // Depth check (§4): the bottom layer must not hold most of the level.
    const layerCount = new Set(layout.plates.map((p) => p.layer)).size;
    if (layerCount >= 4 && bottomLayerFraction(layout.plates, layout.screws) > 0.35) continue;

    const colors = assignColors(layout, params, rng, params.colorClumping);
    const def = buildDef(level, seed, params, layout, colors, rng);
    const sim = simulateWithLazyQueue(def, seed);
    if (sim.outcome !== 'won') continue;
    if (sim.queue.length !== count / BOX_CAPACITY) continue;
    const final: LevelDef = { ...def, boxQueue: sim.queue };

    const stats = statsFrom(final, sim);
    // Opening with two boxes of the same colour narrows the level to one front
    // no matter how many plates are reachable — never ship that.
    if (stats.startBoxColors < targets.startBoxColors) continue;
    const c: Candidate = { def: final, stats, score: quality(stats, targets, params), attempt };
    const rightSize = count >= target * 0.92 && stats.layers >= params.layers - 1;
    keep(rightSize ? (meetsTargets(stats, targets) ? tier1 : tier2) : tier3, c);
  }

  // Prefer a level that meets every criterion; fall back to the best seen.
  for (const list of [tier1, tier2, tier3]) {
    for (const c of list) {
      const runs = naiveRuns(c.stats.screws);
      const { max, min } = naiveWinLimits(level, params);
      let wins = -1;
      if (max < runs || min > 0) {
        wins = naiveWins(c.def, runs);
        if (wins > max || wins < min) continue;
      }
      lastStats = { ...c.stats, attempts: c.attempt + 1, naiveWins: wins, ms: Date.now() - t0 };
      return c.def;
    }
    // Nothing in this tier survived the difficulty gate: take its best anyway.
    if (list.length) {
      const c = list[0];
      lastStats = { ...c.stats, attempts: c.attempt + 1, naiveWins: -1, ms: Date.now() - t0 };
      return c.def;
    }
  }
  throw new Error(`generateLevel(${level}): could not produce a winnable level`);
}
