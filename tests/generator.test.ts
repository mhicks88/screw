import { describe, expect, it } from 'vitest';
import {
  TOTAL_LEVELS, generateLevel, lastGenerationStats, measureLevel, nonLinearityTargets, winningMoves,
} from '../src/core/generator';
import { difficultyFor, difficultyLabelFor } from '../src/core/difficulty';
import { Game } from '../src/core/game';
import { plateContainsWorldPoint, plateEdgeDistance, plateWorldOutline, polygonAabb, polygonsOverlap } from '../src/core/geometry';
import { BOX_CAPACITY, MAX_ACTIVE_BOXES, MAX_BONUS_SLOTS, BASE_TRAY_SLOTS, type LevelDef } from '../src/core/types';
import { BOARD, SCREW_EDGE_MARGIN, pairSpacingOk } from '../src/core/spacing';
import { bottomLayerFraction } from '../src/core/placement';

const EPS = 1e-6;

/**
 * CONTRACT_V2 §7: the test suite samples levels (every 10th, both sides of every
 * band boundary, and all of 1..30). `npm run sweep` verifies all 1000.
 */
const BAND_EDGES = [1, 2, 3, 4, 5, 29, 30, 31, 32, 119, 120, 121, 122, 349, 350, 351, 352, 699, 700, 701, 702, 999, 1000];
export const SAMPLE_LEVELS = [...new Set([
  ...Array.from({ length: 30 }, (_, i) => i + 1),
  ...Array.from({ length: 100 }, (_, i) => (i + 1) * 10),
  ...BAND_EDGES,
])].sort((a, b) => a - b);

/** CONTRACT_V2 §6 band table, as published. */
const BANDS = [
  { lo: 1, hi: 3, screws: [9, 12], layers: [1, 2], colors: [3, 3] },
  { lo: 4, hi: 30, screws: [12, 30], layers: [3, 5], colors: [3, 4] },
  { lo: 31, hi: 120, screws: [30, 55], layers: [5, 8], colors: [4, 6] },
  { lo: 121, hi: 350, screws: [55, 90], layers: [8, 11], colors: [5, 7] },
  { lo: 351, hi: 700, screws: [90, 125], layers: [10, 13], colors: [6, 8] },
  { lo: 701, hi: 1000, screws: [125, 150], layers: [12, 15], colors: [6, 8] },
];
const bandFor = (n: number) => BANDS.find((b) => n <= b.hi)!;

const cache = new Map<number, LevelDef>();
function level(n: number): LevelDef {
  let def = cache.get(n);
  if (!def) { def = generateLevel(n); cache.set(n, def); }
  return def;
}

function checkConstraints(def: LevelDef, n: number): void {
  const tag = `level ${n}`;
  expect(def.level, tag).toBe(n);
  expect(def.difficulty, tag).toBe(difficultyFor(n).label);
  expect(def.activeBoxCount, tag).toBeGreaterThanOrEqual(1);
  expect(def.activeBoxCount, tag).toBeLessThanOrEqual(MAX_ACTIVE_BOXES);
  expect(def.traySlots, tag).toBeGreaterThanOrEqual(BASE_TRAY_SLOTS);
  expect(def.plates.length, tag).toBeGreaterThanOrEqual(2);
  expect(def.screws.length % BOX_CAPACITY, tag).toBe(0);
  expect(def.boxQueue.length, tag).toBe(def.screws.length / BOX_CAPACITY);
  // ids are dense and ordered
  expect(def.plates.map((p) => p.id), tag).toEqual(def.plates.map((_, i) => i));
  expect(def.screws.map((s) => s.id), tag).toEqual(def.screws.map((_, i) => i));
  // colour counts are multiples of 3 and match the queue
  const perColor = new Map<string, number>();
  for (const s of def.screws) perColor.set(s.color, (perColor.get(s.color) ?? 0) + 1);
  for (const [c, count] of perColor) {
    expect(count % BOX_CAPACITY, `${tag} colour ${c}`).toBe(0);
    expect(def.boxQueue.filter((q) => q === c).length, `${tag} queue ${c}`).toBe(count / BOX_CAPACITY);
  }
  expect([...perColor.keys()].sort(), tag).toEqual([...def.colors].sort());
  // plates: inside the board, no same-layer overlap, every plate has a screw
  const outlines = def.plates.map(plateWorldOutline);
  const plateById = new Map(def.plates.map((p) => [p.id, p]));
  for (let i = 0; i < def.plates.length; i++) {
    const bb = polygonAabb(outlines[i]);
    expect(bb.minX, tag).toBeGreaterThanOrEqual(BOARD.minX - EPS);
    expect(bb.maxX, tag).toBeLessThanOrEqual(BOARD.maxX + EPS);
    expect(bb.minY, tag).toBeGreaterThanOrEqual(BOARD.minY - EPS);
    expect(bb.maxY, tag).toBeLessThanOrEqual(BOARD.maxY + EPS);
    expect(def.screws.some((s) => s.plateId === def.plates[i].id), `${tag} plate ${i} has no screw`).toBe(true);
    for (let j = i + 1; j < def.plates.length; j++) {
      if (def.plates[i].layer === def.plates[j].layer) {
        expect(polygonsOverlap(outlines[i], outlines[j]), `${tag} plates ${i},${j} overlap on layer ${def.plates[i].layer}`).toBe(false);
      }
    }
  }
  // screws: inside their plate with margin, spaced per CONTRACT_V2 §2
  for (let i = 0; i < def.screws.length; i++) {
    const s = def.screws[i];
    const p = plateById.get(s.plateId)!;
    expect(plateContainsWorldPoint(p, s.x, s.y), `${tag} screw ${i} outside plate`).toBe(true);
    expect(plateEdgeDistance(p, s.x, s.y), `${tag} screw ${i} margin`).toBeGreaterThanOrEqual(SCREW_EDGE_MARGIN - EPS);
    for (let j = i + 1; j < def.screws.length; j++) {
      const t = def.screws[j];
      if (!pairSpacingOk(p, s.x, s.y, plateById.get(t.plateId)!, t.x, t.y)) {
        throw new Error(`${tag}: screws ${i},${j} violate the spacing rule`);
      }
    }
    if (s.hidden) {
      const blocked = def.plates.some((q) => q.layer > p.layer && plateContainsWorldPoint(q, s.x, s.y));
      expect(blocked, `${tag} hidden screw ${i} is not blocked`).toBe(true);
    }
  }
  if (n < 25) expect(def.screws.some((s) => s.hidden), tag).toBe(false);
}

describe('generator', () => {
  it('exports TOTAL_LEVELS = 1000 and rejects out-of-range levels', () => {
    expect(TOTAL_LEVELS).toBe(1000);
    expect(() => generateLevel(0)).toThrow();
    expect(() => generateLevel(1001)).toThrow();
    expect(() => generateLevel(1.5)).toThrow();
  });

  it('tutorial levels are small with 3 colours and 3 boxes', () => {
    for (const n of [1, 2, 3]) {
      const def = level(n);
      expect(def.colors.length).toBe(3);
      expect(def.activeBoxCount).toBe(3);
      expect(def.traySlots).toBe(BASE_TRAY_SLOTS);
      expect(def.screws.length).toBeGreaterThanOrEqual(9);
      expect(def.screws.length).toBeLessThanOrEqual(12);
      expect(def.plates.length).toBeLessThanOrEqual(4);
      expect(new Set(def.plates.map((p) => p.layer)).size).toBeLessThanOrEqual(2);
      expect(def.screws.some((s) => s.hidden)).toBe(false);
    }
  }, 60_000);

  it('keeps the difficulty rhythm and ramps along the CONTRACT_V2 §6 bands', () => {
    expect(difficultyLabelFor(10)).toBe('hard');
    expect(difficultyLabelFor(25)).toBe('extreme');
    expect(difficultyLabelFor(50)).toBe('extreme');
    expect(difficultyLabelFor(34)).toBe('easy');
    expect(difficultyLabelFor(7)).toBe('normal');
    expect(difficultyFor(24).mysteryFraction).toBe(0);
    expect(difficultyFor(25).mysteryFraction).toBeGreaterThan(0);
    expect(difficultyFor(500).screws).toBeGreaterThan(difficultyFor(100).screws);
    expect(difficultyFor(500).colors).toBeGreaterThan(difficultyFor(50).colors);
    expect(difficultyFor(1000).screws).toBeGreaterThanOrEqual(147);
    expect(difficultyFor(1000).layers).toBe(15);
    // every level's targets sit inside its own band
    for (let n = 1; n <= TOTAL_LEVELS; n++) {
      const b = bandFor(n);
      const p = difficultyFor(n);
      expect(p.screws, `level ${n} screws`).toBeGreaterThanOrEqual(b.screws[0] - 2);
      expect(p.screws, `level ${n} screws`).toBeLessThanOrEqual(b.screws[1] + 1);
      expect(p.layers, `level ${n} layers`).toBeGreaterThanOrEqual(b.layers[0]);
      expect(p.layers, `level ${n} layers`).toBeLessThanOrEqual(b.layers[1]);
      expect(p.colors, `level ${n} colours`).toBeGreaterThanOrEqual(b.colors[0]);
      expect(p.colors, `level ${n} colours`).toBeLessThanOrEqual(b.colors[1]);
      expect(p.traySlots + MAX_BONUS_SLOTS, `level ${n} tray`).toBeLessThanOrEqual(11);
    }
  });

  it('is deterministic', () => {
    for (const n of [1, 7, 30, 120, 421, 1000]) {
      expect(generateLevel(n), `level ${n}`).toEqual(level(n));
    }
  }, 120_000);

  it('exposes generation stats that measureLevel reproduces', () => {
    const def = generateLevel(200);
    const gen = lastGenerationStats();
    const stats = measureLevel(def);
    expect(stats.level).toBe(200);
    expect(stats.screws).toBe(def.screws.length);
    expect(gen).toBeDefined();
    expect(gen!.avgReachable).toBeCloseTo(stats.avgReachable, 10);
    expect(gen!.avgFronts).toBeCloseTo(stats.avgFronts, 10);
    expect(gen!.minReachable).toBe(stats.minReachable);
    expect(gen!.ms).toBeLessThan(2500);
  }, 60_000);

  it(`every sampled level (${SAMPLE_LEVELS.length} of ${TOTAL_LEVELS}) is well-formed and winnable`, async () => {
    let genMs = 0;
    let maxMs = 0;
    let maxLevel = 0;
    let biggest = 0;
    let deepest = 0;
    let mostPlates = 0;
    let peakVisible = 0;
    for (const n of SAMPLE_LEVELS) {
      // Yield now and then: this test runs for a minute and vitest's reporter
      // channel times out if the event loop never breathes.
      await new Promise((r) => setTimeout(r, 0));
      const t0 = performance.now();
      const def = level(n);
      const dt = performance.now() - t0;
      genMs += dt;
      if (dt > maxMs) { maxMs = dt; maxLevel = n; }

      checkConstraints(def, n);
      const game = new Game(def);
      expect(game.reachableScrewIds().length, `level ${n} has no reachable screw`).toBeGreaterThan(0);

      // Winnable through the public Game API alone, using the recorded queue.
      const moves = winningMoves(def);
      expect(moves.length, `level ${n} winning line`).toBe(def.screws.length);
      for (const id of moves) {
        const r = game.tapScrew(id);
        expect(r.ok, `level ${n}: tapping ${id} was refused (${r.reason})`).toBe(true);
      }
      const snap = game.snapshot();
      expect(snap.status, `level ${n}`).toBe('won');
      expect(snap.removedScrews, `level ${n}`).toBe(def.screws.length);
      expect(snap.nextBoxIndex, `level ${n}`).toBe(def.boxQueue.length);

      const stats = measureLevel(def);
      biggest = Math.max(biggest, stats.screws);
      deepest = Math.max(deepest, stats.layers);
      mostPlates = Math.max(mostPlates, stats.plates);
      peakVisible = Math.max(peakVisible, stats.peakReachable);
    }
    console.log(
      `generateLevel over ${SAMPLE_LEVELS.length} sampled levels: avg ${(genMs / SAMPLE_LEVELS.length).toFixed(0)} ms, `
      + `total ${(genMs / 1000).toFixed(1)} s, slowest level ${maxLevel} (${maxMs.toFixed(0)} ms); `
      + `max ${biggest} screws, ${deepest} layers, ${mostPlates} plates, ${peakVisible} visible at once`,
    );
    expect(maxMs, `level ${maxLevel} took ${maxMs.toFixed(0)} ms`).toBeLessThan(2500);
    expect(biggest).toBeGreaterThanOrEqual(140);
    expect(deepest).toBeGreaterThanOrEqual(14);
  }, 600_000);

  it('hits the CONTRACT_V2 §6 size and depth bands', () => {
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      const b = bandFor(n);
      const layers = new Set(def.plates.map((p) => p.layer)).size;
      expect(def.screws.length, `level ${n} screws`).toBeGreaterThanOrEqual(b.screws[0] - 3);
      expect(def.screws.length, `level ${n} screws`).toBeLessThanOrEqual(b.screws[1]);
      expect(layers, `level ${n} layers`).toBeGreaterThanOrEqual(b.layers[0] - 1);
      expect(layers, `level ${n} layers`).toBeLessThanOrEqual(b.layers[1]);
      expect(def.colors.length, `level ${n} colours`).toBeLessThanOrEqual(b.colors[1]);
    }
    const top = SAMPLE_LEVELS.filter((n) => n >= 701).map((n) => level(n).screws.length);
    expect(Math.max(...top), 'top band never reaches 140+ screws').toBeGreaterThanOrEqual(140);
    expect(Math.min(...top), 'top band drops below 120 screws').toBeGreaterThanOrEqual(120);
  }, 300_000);

  /* CONTRACT_V2 §4 */
  it('spreads screws over the layers instead of piling them on the bottom', () => {
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      const layers = new Set(def.plates.map((p) => p.layer)).size;
      if (layers < 4) continue; // 1-3 layer tutorials cannot be 35% bottom-heavy
      expect(bottomLayerFraction(def.plates, def.screws), `level ${n} bottom layer share`).toBeLessThanOrEqual(0.35);
    }
  }, 300_000);

  it('keeps the per-layer screw counts roughly uniform on deep levels', () => {
    for (const n of SAMPLE_LEVELS.filter((k) => k >= 351)) {
      const def = level(n);
      const byLayer = new Map<number, number>();
      const plate = new Map(def.plates.map((p) => [p.id, p]));
      for (const s of def.screws) {
        const l = plate.get(s.plateId)!.layer;
        byLayer.set(l, (byLayer.get(l) ?? 0) + 1);
      }
      const layers = new Set(def.plates.map((p) => p.layer)).size;
      const mean = def.screws.length / layers;
      const heaviest = Math.max(...byLayer.values());
      expect(heaviest, `level ${n}: one layer holds ${heaviest} of ${def.screws.length} screws`).toBeLessThanOrEqual(mean * 3.2);
    }
  }, 300_000);

  /* CONTRACT_V2 §5 — N active boxes are only N fronts if they want N colours. */
  it('opens every level with distinct active box colours', () => {
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      const want = Math.min(def.activeBoxCount, def.colors.length);
      const opening = new Game(def).snapshot().boxes;
      expect(opening.length, `level ${n} box count`).toBe(def.activeBoxCount);
      expect(new Set(opening.map((b) => b.color)).size, `level ${n} opens with duplicate box colours`).toBe(want);
      const s = measureLevel(def);
      expect(s.startBoxColors, `level ${n} startBoxColors`).toBe(want);
      // Duplicates are only tolerable once the pool has run down to one colour,
      // which is the last handful of moves — short levels feel that tail more.
      expect(s.avgBoxColors, `level ${n} avgBoxColors`).toBeGreaterThanOrEqual(Math.min(want, 2) * 0.8);
    }
  }, 300_000);

  it('meets the non-linearity criteria', () => {
    let strict = 0;
    let counted = 0;
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      const s = measureLevel(def);
      const t = nonLinearityTargets(n);
      // Hard floor every sampled level must clear.
      expect(s.avgReachable, `level ${n} avgReachable`).toBeGreaterThanOrEqual(t.avgReachable * 0.8);
      expect(s.avgFronts, `level ${n} avgFronts`).toBeGreaterThanOrEqual(t.avgFronts * 0.8);
      expect(s.minReachable, `level ${n} minReachable`).toBeGreaterThanOrEqual(Math.max(1, t.minReachable - 1));
      expect(s.maxChokeRun, `level ${n} chokepoint run`).toBeLessThanOrEqual(Math.max(4, t.maxChokeRun));
      // Peak visible screws stay in a tappable range on a 440pt-wide phone
      // (the band averages are 19-23; this is the hard ceiling).
      expect(s.peakReachable, `level ${n} peak visible`).toBeLessThanOrEqual(38);
      expect(s.startBoxColors, `level ${n} startBoxColors`).toBeGreaterThanOrEqual(t.startBoxColors);
      if (n <= 50) continue;
      counted++;
      if (s.avgReachable >= 8 && s.minReachable >= 3 && s.avgFronts >= 3 && s.maxChokeRun < 4) strict++;
    }
    console.log(`non-linearity: ${strict}/${counted} levels above 50 meet every §5 criterion strictly`);
    expect(strict / counted, 'too few levels meet the strict §5 criteria').toBeGreaterThanOrEqual(0.95);
  }, 300_000);
});
