/**
 * Deterministic level generator. `generateLevel(n)` always returns the same
 * LevelDef for the same n: the seed is a hash of (n, attempt), and the level is
 * the BEST of a few dozen candidates rather than the first passable one (the
 * ~2 s budget of CONTRACT_V3 §7 buys quality, not just a pass). The box queue is
 * recorded from a bot play-through with a lazy colour provider.
 *
 * Every candidate must be WINNABLE — the planning bot clears it with a lazily
 * chosen box queue — and is then judged on three axes: how it plays (the §7
 * non-linearity statistics measured over that play-through, plus the §6 rule
 * that some screws are removable and face-on from every viewing direction),
 * whether it is the size its band advertises, and HOW FORGIVING it is — how
 * often a naive bot that does not plan clears it. Candidates are tiered on the
 * first two, play quality first, and among the tiers that are sound the one
 * whose best candidate comes closest to this level's difficulty window wins.
 *
 * That third axis is what v3.0 lacked. Its gate was switched off below level 30
 * and switched off again for any level with four active boxes — the whole of the
 * deepest band — so the game peaked in difficulty around level 40 and got easier
 * with depth from there.
 *
 * Solvability is not left to luck: the assembly is built so that a screw can
 * only ever be blocked by panels in a strictly outer shell (see ./assembly), so
 * a legal move always exists. What the bot play-through actually proves is that
 * the COLOUR and TRAY economy works out.
 */
import { ALL_COLORS, BOX_CAPACITY, type LevelDef, type PanelDef, type ScrewColor, type ScrewDef, type Vec3 } from './types';
import { Rng, hashSeed } from './rng';
import { difficultyFor, TOTAL_LEVELS, type DifficultyParams } from './difficulty';
import { buildAssembly, outerShellFraction, shellCount, trimScrews, type Assembly } from './assembly';
import { Game } from './game';
import { chooseLazyBoxColor } from './colorChoice';
import { playBot, type BotResult } from './bot';

export { TOTAL_LEVELS };

/**
 * Assign colours so that each colour count is a multiple of BOX_CAPACITY.
 * `clumping` in [0, 1] controls how much screws on the same panel share
 * colours: 0 = fully random, 1 = colour runs laid down panel by panel.
 */
export function assignColors(asm: Assembly, params: DifficultyParams, rng: Rng, clumping: number): ScrewColor[] {
  const count = asm.screws.length;
  const boxes = count / BOX_CAPACITY;
  const k = Math.max(1, Math.min(params.colors, boxes, ALL_COLORS.length));
  const palette = rng.shuffle([...ALL_COLORS]).slice(0, k);
  const perColor = new Array(k).fill(1);
  for (let i = k; i < boxes; i++) perColor[rng.int(0, k - 1)]++;
  // Runs of the same colour, in random colour order.
  const runs: ScrewColor[] = [];
  for (const i of rng.shuffle(perColor.map((_, i) => i))) for (let j = 0; j < perColor[i] * BOX_CAPACITY; j++) runs.push(palette[i]);
  // Screw order: grouped by panel (random panel order, random order inside).
  const panelRank = new Map(rng.shuffle(asm.panels.map((p) => p.id)).map((id, i) => [id, i]));
  const order = asm.screws.map((s, i) => ({ i, key: panelRank.get(s.panelId)! + rng.next() * 0.99 }))
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

function buildDef(level: number, seed: number, params: DifficultyParams, asm: Assembly, colors: ScrewColor[], rng: Rng): LevelDef {
  const panels: PanelDef[] = asm.panels.map((p, i) => ({ ...p, id: i }));
  const idMap = new Map(asm.panels.map((p, i) => [p.id, i]));
  const screws: ScrewDef[] = asm.screws.map((s, i) => ({
    id: i,
    panelId: idMap.get(s.panelId)!,
    position: { ...s.position },
    axis: { ...s.axis },
    color: colors[i],
    hidden: false,
  }));
  // Mystery screws: a fraction of the screws whose path is obstructed at start.
  if (params.mysteryFraction > 0) {
    const blocked = screws.filter((_, i) => asm.blockers[i].length > 0);
    const n = Math.round(blocked.length * params.mysteryFraction);
    for (const s of rng.shuffle(blocked).slice(0, n)) s.hidden = true;
  }
  return {
    level, seed, panels, screws, boxQueue: [], activeBoxCount: params.activeBoxCount, traySlots: params.traySlots,
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

/* -------------------------------------------- view coverage (§6, §7) */

/**
 * Evenly spread view directions (a Fibonacci sphere). The renderer only draws
 * and hit-tests screws that are removable AND front-facing, so "how many screws
 * can the player actually tap right now" depends on where the object has been
 * turned to — and the answer must never be zero, from any angle.
 */
const VIEW_DIRS: Vec3[] = (() => {
  const n = 40;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = i * golden;
    out.push({ x: r * Math.cos(phi), y: r * Math.sin(phi), z });
  }
  return out;
})();

/** A screw is drawn (and tappable) when its axis points somewhat at the camera. */
const FACING_DOT = 0.35;

/**
 * Fewest screws that are removable AND front-facing, over every sampled view
 * direction. This is the count the player can actually tap after turning the
 * assembly to the worst angle for them.
 */
export function minViewFacing(def: LevelDef, removableIds: readonly number[]): number {
  const axes = new Map(def.screws.map((s) => [s.id, s.axis]));
  let worst = Infinity;
  for (const v of VIEW_DIRS) {
    let n = 0;
    for (const id of removableIds) {
      const a = axes.get(id)!;
      if (a.x * v.x + a.y * v.y + a.z * v.z > FACING_DOT) n++;
    }
    if (n < worst) worst = n;
  }
  return Number.isFinite(worst) ? worst : 0;
}

/* ------------------------------------------------ non-linearity (§7) */

export interface LevelStats {
  level: number;
  screws: number;
  panels: number;
  shells: number;
  /** Fraction of screws sitting on the outermost shell. */
  outerShellFraction: number;
  /** Screws removable at the very start of the level (from any angle). */
  startReachable: number;
  /** Most screws simultaneously removable during the play-through. */
  peakReachable: number;
  /** Mean removable screws per step over the whole play-through (§7). */
  avgReachable: number;
  /** Fewest removable screws outside the final 5 moves. */
  minReachable: number;
  /** Mean number of distinct PANELS holding a removable screw (§7). */
  avgFronts: number;
  /** Longest stretch of consecutive steps with fewer than 3 removable screws. */
  maxChokeRun: number;
  /** Distinct colours among the active boxes at the very start of the level. */
  startBoxColors: number;
  /** Mean number of distinct colours among the active boxes over the play-through. */
  avgBoxColors: number;
  /**
   * Over sampled view directions and sampled moments of the play-through, the
   * fewest screws that are at once removable and front-facing — what the player
   * can tap after turning the assembly to the least helpful angle (§6).
   */
  minViewFacing: number;
  /** Taps in the proven winning line (one per screw). */
  steps: number;
}

export interface NonLinearityTargets {
  avgReachable: number;
  minReachable: number;
  avgFronts: number;
  maxChokeRun: number;
  /** Fewest removable, front-facing screws from the worst view direction (§6). */
  minViewFacing: number;
  /** Distinct colours the starting boxes must show (§7: N boxes, N fronts). */
  startBoxColors: number;
}

/**
 * CONTRACT_V3 §7 thresholds (carried over from v2 §5). Full strength from level
 * 50 on; below that they ramp down, because a 12-screw tutorial cannot offer 8
 * removable screws.
 */
export function nonLinearityTargets(level: number): NonLinearityTargets {
  const params = difficultyFor(level);
  // Every starting box must want a different colour whenever the palette allows.
  const startBoxColors = Math.min(params.activeBoxCount, params.colors);
  /*
   * Turning the assembly must never show an empty board: whatever angle the
   * player lands on, some screws are face-on and removable. Above that bare
   * rule — VIEW_FLOOR_MIN, which no level may break — this is what the generator
   * PREFERS: a real choice from every angle, not just a move.
   *
   * It is set by the assembly's size, not by level number: how many screws can
   * face the player at once is a question about how much material there is. The
   * old rule asked three of everything past level 350, which is where the bands
   * carry 100-140 screws; with two open boxes rather than three, more of those
   * screws are sitting in the tray at any moment, and three was no longer
   * reachable there — the generator spent its whole budget failing to find one
   * and shipped a candidate at one instead. Three is kept for the 140+ band,
   * which does have the material for it.
   */
  const viewFloor = params.screws >= 140 ? 3 : 2;
  if (level <= 5) return { avgReachable: 0, minReachable: 1, avgFronts: 0, maxChokeRun: 999, minViewFacing: viewFloor, startBoxColors };
  const s = Math.min(1, (level - 5) / 45);
  return {
    avgReachable: 3 + 5 * s,
    minReachable: s >= 1 ? 3 : s > 0.5 ? 2 : 1,
    avgFronts: 1.2 + 1.8 * s,
    maxChokeRun: Math.round(10 - 7 * s),
    minViewFacing: viewFloor,
    startBoxColors,
  };
}

const TAIL = 5; // the last few moves of any level are necessarily forced

/**
 * Worst view over the play-through, ignoring its final stretch: the last few
 * screws of any level are wherever they are, and one of them is the last screw
 * on the board. Everything before that has to keep the assembly tappable from
 * every angle.
 */
function viewFloorOf(def: LevelDef, samples: readonly number[][]): number {
  if (samples.length === 0) return 0;
  const body = samples.slice(0, Math.max(1, samples.length - 2));
  return body.reduce((m, ids) => Math.min(m, minViewFacing(def, ids)), Infinity);
}

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
  return {
    level: def.level,
    screws: def.screws.length,
    panels: def.panels.length,
    shells: shellCount(def.panels),
    outerShellFraction: outerShellFraction(def.panels, def.screws),
    startReachable: reach.length ? reach[0] : 0,
    peakReachable: reach.length ? Math.max(...reach) : 0,
    avgReachable: mean(reach),
    minReachable: body.length ? Math.min(...body) : 0,
    avgFronts: mean(fronts),
    maxChokeRun: maxRun,
    startBoxColors: boxColors.length ? boxColors[0] : 0,
    avgBoxColors: mean(boxColors),
    minViewFacing: viewFloorOf(def, res.reachSamples ?? []),
    steps: res.steps,
  };
}

/**
 * Replay a level's recorded queue with the same bot/seed used at generation
 * time and report its §7 statistics. Deterministic, and identical to what the
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

/**
 * The §6 rule itself: SOME screw is removable and face-on from every viewing
 * direction, at every sampled moment. `NonLinearityTargets.minViewFacing` asks
 * for more than that — a real choice, not just a move — and is a preference the
 * generator pays for in `quality` and gates on in its top tiers. When a level
 * cannot offer both that preference and the difficulty its depth calls for,
 * this is the line that still holds.
 */
export const VIEW_FLOOR_MIN = 1;

function meetsTargets(stats: LevelStats, targets: NonLinearityTargets): boolean {
  return stats.minViewFacing >= targets.minViewFacing
    && stats.avgReachable >= targets.avgReachable
    && stats.minReachable >= targets.minReachable
    && stats.avgFronts >= targets.avgFronts
    && stats.maxChokeRun < Math.max(4, targets.maxChokeRun + 1)
    && stats.startBoxColors >= targets.startBoxColors;
}

/* ------------------------------------------------------- difficulty gate */

/**
 * Runs of the naive bot used to judge one candidate. Twelve is the resolution
 * the difficulty curve below is written in, and the generator measures what it
 * is aiming at rather than a cheaper approximation of it: picking the tightest
 * of twenty candidates on a four-run estimate is the winner's curse — the
 * candidate that happens to lose four seeded runs is often an ordinary level,
 * and level 300 shipped at 5/12 while the gate believed it was 0/4.
 */
const GATE_RUNS = 12;

/**
 * The published difficulty curve: how many of GATE_RUNS a player who does not
 * plan should win at this depth. Linear between the listed levels.
 *
 *   1-4     12/12   tutorials and the single-shell bridge; they teach the
 *                   drag-to-rotate gesture and must play themselves
 *   5       10/12   the tray exists and can bite
 *   10       7/12   real pressure
 *   20       4/12   demanding
 *   30       3/12
 *   50       2/12
 *   100      1/12
 *   200+     0/12   a level you do not plan is a level you lose
 *
 * v3.0's curve started at 0.85 of the runs and bottomed out at 0.5, switched
 * the gate off entirely below level 30, and switched it off again for any level
 * with four active boxes — which was the whole of the deepest band. The game
 * peaked in difficulty around level 40 and got EASIER from there.
 */
const CURVE: [level: number, wins: number][] = [
  [4, 12], [5, 10], [10, 7], [20, 4], [30, 3], [50, 2], [100, 1], [200, 0],
];

function naiveWinTarget(level: number): number {
  if (level <= CURVE[0][0]) return CURVE[0][1];
  for (let i = 1; i < CURVE.length; i++) {
    const [hi, hiW] = CURVE[i];
    if (level <= hi) {
      const [lo, loW] = CURVE[i - 1];
      return Math.round(loW + ((hiW - loW) * (level - lo)) / (hi - lo));
    }
  }
  return CURVE[CURVE.length - 1][1];
}

/**
 * Difficulty gate. The planning bot proves the level is winnable; a naive bot
 * (random matching, random tray choices) then replays the FIXED queue GATE_RUNS
 * times and its win count tells how forgiving the level is. The window has BOTH
 * ends: a level of this depth must not be forgiving, and — while the player is
 * still learning what the tray is for — must not be brutal either.
 *
 * The rhythm rides on top: a 'hard' or 'extreme' level is one win tighter than
 * its depth asks for, an 'easy' breather one win looser. One win is deliberately
 * small — the rhythm is already felt in the band position, which gives a 'hard'
 * level more screws and more colours than its neighbours.
 *
 * The gate ranks candidates rather than rejecting outright (see `pickByGate`),
 * so generation always terminates.
 */
function naiveWinLimits(level: number, params: DifficultyParams): { max: number; min: number } {
  if (level <= 4) return { max: GATE_RUNS, min: 0 };
  const target = naiveWinTarget(level);
  const mod = params.label === 'extreme' || params.label === 'hard' ? -1 : params.label === 'easy' ? 1 : 0;
  const max = Math.min(GATE_RUNS, Math.max(0, target + mod));
  // The window has a floor one win below the ceiling, not zero. Without it the
  // gate takes the first candidate that is merely no easier than the target and
  // ships whatever it finds: level 15, which wants six, came out at zero — a
  // brick wall five levels after the game first asks the player to think.
  const min = Math.max(0, max - 1);
  return { max, min };
}

function naiveWins(def: LevelDef): number {
  let wins = 0;
  for (let k = 0; k < GATE_RUNS; k++) {
    if (playBot(new Game(def), hashSeed(def.seed, k + 1), { naive: true }).outcome === 'won') wins++;
  }
  return wins;
}

/**
 * How far outside its difficulty window a candidate falls. Undershooting costs
 * more than overshooting, and by enough to outrank a nearer miss on the easy
 * side: a level that is a shade too forgiving is a better level than a wall.
 * Level 30 wants one or two and had a 0 and a 4 to choose from; it shipped the 0.
 */
function gateMiss(wins: number, limits: { max: number; min: number }): number {
  return Math.max(0, wins - limits.max) + 2.5 * Math.max(0, limits.min - wins);
}

/**
 * Apply the gate to a tier of candidates (already ordered best-quality first).
 * The first candidate INSIDE the window wins. When none is inside — the common
 * case for a level the generator cannot make tight enough — the one that misses
 * by the least wins, rather than v3.0's "take the highest-quality one and give
 * up on difficulty". That is what stopped the deep bands from drifting back to
 * levels the naive bot clears 11 times out of 12.
 */
function pickByGate(
  list: readonly Candidate[],
  limits: { max: number; min: number },
  winsFor: (c: Candidate) => number,
): { cand: Candidate; wins: number; miss: number } {
  let best: { cand: Candidate; wins: number; miss: number } | undefined;
  for (const cand of list) {
    const wins = winsFor(cand);
    const miss = gateMiss(wins, limits);
    if (miss === 0) return { cand, wins, miss };
    // Strictly less: ties keep the earlier, higher-quality candidate.
    if (!best || miss < best.miss) best = { cand, wins, miss };
  }
  return best!;
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
 * Quality of a candidate level: how far it clears the §7 bar, how close it is
 * to the band's target size/shells, and how evenly the screws are spread
 * through the assembly. The generator keeps the best candidate it saw rather
 * than the first passable one — with a ~2 s budget that is a far better use of
 * the time (CONTRACT_V3 §7).
 */
function quality(stats: LevelStats, t: NonLinearityTargets, params: DifficultyParams): number {
  const ratio = (v: number, target: number) => (target <= 0 ? 1 : Math.min(1.25, v / target));
  let q = 0;
  q += 2.2 * ratio(stats.avgReachable, t.avgReachable);
  q += 1.6 * ratio(stats.avgFronts, t.avgFronts);
  // Headroom above the minReachable floor is worth paying for: v2's late levels
  // sat exactly on it, which felt like a forced line whenever the tray filled.
  q -= 2.5 * Math.max(0, t.minReachable - stats.minReachable);
  q += 0.9 * Math.min(3, Math.max(0, stats.minReachable - t.minReachable));
  q -= 0.8 * Math.max(0, stats.maxChokeRun - t.maxChokeRun);
  q += 3.0 * Math.min(1, stats.screws / params.screws) + (stats.screws >= params.screws ? 1.2 : 0);
  q += 1.2 * Math.min(1, stats.shells / params.shells);
  q += 0.8 * Math.min(1, stats.panels / Math.max(2, params.panels));
  // A solid whose screws all sit on the skin is a flat board again.
  q -= 3.0 * Math.max(0, stats.outerShellFraction - 0.45);
  q -= 2.0 * Math.max(0, t.startBoxColors - stats.startBoxColors);
  // An angle with nothing on it is the worst thing a 3D level can do, so this
  // is scored steeply rather than as one criterion among many.
  q -= 6.0 * Math.max(0, t.minViewFacing - stats.minViewFacing);
  q += 0.5 * Math.min(4, Math.max(0, stats.minViewFacing - t.minViewFacing));
  return q;
}

/** Attempts per level; each costs an assembly plus one bot play-through. */
function attemptBudget(params: DifficultyParams): number {
  return params.screws >= 140 ? 38 : params.screws >= 100 ? 52 : params.screws >= 60 ? 80 : 110;
}

/**
 * Hard ceiling on attempts including the extra round below, sized so even a
 * level that never satisfies every criterion stays inside the ~2 s budget of
 * CONTRACT_V3 §7. Bigger assemblies cost more per attempt, so they get fewer.
 */
function maxTotalAttempts(params: DifficultyParams): number {
  return params.screws >= 140 ? 52 : params.screws >= 100 ? 70 : params.screws >= 60 ? 100 : 180;
}

/**
 * How many candidates per tier are carried to the difficulty gate. The gate can
 * only choose from what it is shown, and the candidates a level offers are
 * spread wide: at level 50 the naive bot wins anywhere from 2 to 12 of them.
 * Five was too narrow a window to find the tight ones. Small levels are cheap
 * to replay, so they keep the most; the biggest levels keep fewer, because at
 * 140+ screws the replays start to cost real time against the ~2 s budget.
 */
function keepCount(params: DifficultyParams): number {
  return params.screws >= 120 ? 10 : params.screws >= 60 ? 20 : 30;
}

interface Candidate { def: LevelDef; stats: LevelStats; score: number; attempt: number }

export function generateLevel(level: number): LevelDef {
  if (!Number.isInteger(level) || level < 1 || level > TOTAL_LEVELS) {
    throw new RangeError(`level must be an integer in 1..${TOTAL_LEVELS}`);
  }
  const t0 = Date.now();
  const params = difficultyFor(level);
  const targets = nonLinearityTargets(level);
  const budget = attemptBudget(params);
  /*
   * Tier 1: the right size AND every §7 criterion. Tier 2: every criterion, a
   * little small. Tier 3: the right size and every criterion but the PREFERRED
   * view floor, still clearing the §6 rule itself. Tier 4: the right size but
   * some criterion missed. Tier 5: anything winnable.
   *
   * How a level PLAYS outranks how big it is — a level that is 8% short but
   * offers screws from every angle is a better level than a full-size one the
   * player can turn to an empty view — while a level still never silently
   * shrinks out of its band when a full-size candidate plays just as well.
   */
  const tier1: Candidate[] = [];
  const tier2: Candidate[] = [];
  const tier3: Candidate[] = [];
  const tier4: Candidate[] = [];
  const tier5: Candidate[] = [];
  const tiers = [tier1, tier2, tier3, tier4, tier5];
  const maxKeep = keepCount(params);
  const keep = (list: Candidate[], c: Candidate) => {
    list.push(c);
    list.sort((a, b) => b.score - a.score);
    if (list.length > maxKeep) list.length = maxKeep;
  };

  const tryAttempt = (attempt: number): void => {
    const seed = hashSeed(level, attempt);
    const rng = new Rng(seed);
    const target = params.screws;

    const built = buildAssembly(params, rng);
    if (built.panels.length < 2) return;
    const want = Math.floor(Math.min(built.screws.length, target) / BOX_CAPACITY) * BOX_CAPACITY;
    if (want < 9) return;
    const asm = trimScrews(built, want, rng);
    const count = asm.screws.length;
    if (count % BOX_CAPACITY !== 0 || count < target * 0.5) return;

    const colors = assignColors(asm, params, rng, params.colorClumping);
    const def = buildDef(level, seed, params, asm, colors, rng);
    const sim = simulateWithLazyQueue(def, seed);
    if (sim.outcome !== 'won') return;
    if (sim.queue.length !== count / BOX_CAPACITY) return;
    const final: LevelDef = { ...def, boxQueue: sim.queue };

    const stats = statsFrom(final, sim);
    // Opening with two boxes of the same colour narrows the level to one front
    // no matter how many panels are reachable — never ship that.
    if (stats.startBoxColors < targets.startBoxColors) return;
    const c: Candidate = { def: final, stats, score: quality(stats, targets, params), attempt };
    const rightSize = count >= target * 0.92
      && stats.shells >= params.shells
      && stats.panels >= params.panels * 0.75;
    // Tier 2 is for levels that play well but came out a little small. "A
    // little" has a floor: a six-panel single-shell assembly in a band that
    // promises twenty panels is a different game, and the loading card has
    // already told the player what to expect.
    const nearSize = count >= target * 0.85
      && stats.shells >= params.shells - 1
      && stats.panels >= params.panels * 0.6;
    const plays = meetsTargets(stats, targets);
    // Same level of play, one notch less view coverage than preferred — still
    // never an empty angle. Worth more than a level at the wrong difficulty.
    const playsSoftView = !plays && meetsTargets(stats, { ...targets, minViewFacing: VIEW_FLOOR_MIN });
    keep(
      rightSize
        ? (plays ? tier1 : playsSoftView ? tier3 : tier4)
        : (plays && nearSize ? tier2 : tier5),
      c,
    );
  };

  for (let attempt = 0; attempt < budget; attempt++) tryAttempt(attempt);

  const limits = naiveWinLimits(level, params);
  const winCache = new Map<Candidate, number>();
  const winsFor = (c: Candidate): number => {
    let w = winCache.get(c);
    if (w === undefined) { w = naiveWins(c.def); winCache.set(c, w); }
    return w;
  };
  const inWindow = (c: Candidate): boolean => { const w = winsFor(c); return w <= limits.max && w >= limits.min; };
  /** Tiers whose levels meet §7 and §6 and may therefore be chosen on difficulty. */
  const sound = [tier1, tier2, tier3];
  /*
   * What the budget was supposed to buy: a candidate at the PREFERRED view
   * coverage, and a sound candidate inside this level's difficulty window.
   * Either half missing is worth more attempts.
   *
   * Missing the coverage is what left ~12% of the 351-700 band short of its
   * floor. Missing the window is worse and more common: candidates that clear
   * every §7 criterion are scarce around 90 screws — sometimes one in eighty —
   * and one candidate is no choice at all, so whatever difficulty it happens to
   * have is what ships. That is how level 200 came out at 7 naive wins sitting
   * between a 0 at level 100 and a 3 at level 300.
   */
  const satisfied = (): boolean =>
    (tier1.length > 0 || tier2.length > 0) && sound.some((list) => list.some(inWindow));
  if (!satisfied()) {
    // Bounded by a TOTAL attempt cap, not by adding a multiple of the budget.
    // An unbounded second round made the levels that cannot be satisfied pay
    // the most for nothing: two levels ran the whole extra round, still missed
    // the floor, and took 3.0 s against a 2 s budget. The cap keeps the worst
    // case inside the budget while still buying most of the improvement.
    for (let attempt = budget; attempt < maxTotalAttempts(params); attempt++) {
      tryAttempt(attempt);
      if (satisfied()) break;
    }
  }

  // Prefer a level that meets every criterion; fall back to the best seen.
  /*
   * Choose among the tiers that are sound — every §7 criterion met, and §6 held
   * at VIEW_FLOOR_MIN even where the preferred view floor was not reachable — on
   * how close each one's best candidate comes to this level's difficulty window,
   * plus one win per tier of descent. A level that meets §7 with one screw less
   * coverage than preferred, at the difficulty its depth calls for, is a better
   * level than a beautifully covered one the player clears without thinking;
   * the per-tier penalty keeps it from trading coverage away for nothing.
   *
   * Below the sound tiers the old order stands: a level that misses a §7
   * criterion outright is not rescued by being hard.
   */
  let chosen: { cand: Candidate; wins: number } | undefined;
  let chosenCost = Infinity;
  sound.forEach((list, depth) => {
    if (!list.length) return;
    const c = pickByGate(list, limits, winsFor);
    const cost = c.miss + depth;
    if (cost < chosenCost) { chosenCost = cost; chosen = c; }
  });
  if (!chosen) {
    for (const list of [tier4, tier5]) {
      if (list.length) { chosen = pickByGate(list, limits, winsFor); break; }
    }
  }
  if (chosen) {
    const c: { cand: Candidate; wins: number } = chosen;
    lastStats = { ...c.cand.stats, attempts: c.cand.attempt + 1, naiveWins: c.wins, ms: Date.now() - t0 };
    return c.cand.def;
  }
  throw new Error(`generateLevel(${level}): could not produce a winnable level`);
}
