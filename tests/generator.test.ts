import { describe, expect, it } from 'vitest';
import {
  TOTAL_LEVELS, generateLevel, lastGenerationStats, measureLevel, minViewFacing, nonLinearityTargets, winningMoves,
} from '../src/core/generator';
import { difficultyFor, difficultyLabelFor } from '../src/core/difficulty';
import { Game } from '../src/core/game';
import { computeBlockers } from '../src/core/blocking';
import { outerShellFraction, shellCount } from '../src/core/assembly';
import { distanceToPolygonEdge, pointInShape } from '../src/core/geometry';
import { assemblyToPanel, dotV3, lengthV3, panelMaxRadius, panelNormal } from '../src/core/geometry3';
import { SCREW_EDGE_MARGIN, spacingViolations } from '../src/core/spacing';
import {
  ASSEMBLY_RADIUS, BOX_CAPACITY, MAX_ACTIVE_BOXES, MAX_BONUS_SLOTS, BASE_TRAY_SLOTS, type LevelDef,
} from '../src/core/types';

const EPS = 1e-6;

/**
 * CONTRACT_V3 §7: the test suite SAMPLES levels (the first few, both sides of
 * every band boundary, and a spread in between). `npm run sweep` verifies all
 * 1000 — generating a level costs up to two seconds by design.
 */
const BAND_EDGES = [1, 2, 3, 4, 5, 30, 31, 32, 120, 121, 122, 350, 351, 352, 700, 701, 702, 999, 1000];
export const SAMPLE_LEVELS = [...new Set([
  ...BAND_EDGES,
  ...[10, 25, 60, 100, 200, 300, 450, 500, 600, 800, 900],
])].sort((a, b) => a - b);

/** CONTRACT_V3 §7 band table, as published (panels raised to a floor of 6 — see difficulty.ts). */
const BANDS = [
  { lo: 1, hi: 3, screws: [9, 12], shells: [1, 1], panels: [6, 6], colors: [3, 3] },
  { lo: 4, hi: 30, screws: [12, 30], shells: [1, 2], panels: [6, 10], colors: [3, 4] },
  { lo: 31, hi: 120, screws: [30, 60], shells: [2, 3], panels: [10, 20], colors: [4, 6] },
  { lo: 121, hi: 350, screws: [60, 100], shells: [3, 4], panels: [18, 32], colors: [5, 7] },
  { lo: 351, hi: 700, screws: [100, 140], shells: [4, 5], panels: [28, 45], colors: [6, 8] },
  { lo: 701, hi: 1000, screws: [140, 190], shells: [5, 6], panels: [40, 60], colors: [6, 8] },
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
  expect(def.panels.length, tag).toBeGreaterThanOrEqual(2);
  expect(def.screws.length % BOX_CAPACITY, tag).toBe(0);
  expect(def.boxQueue.length, tag).toBe(def.screws.length / BOX_CAPACITY);
  // ids are dense and ordered
  expect(def.panels.map((p) => p.id), tag).toEqual(def.panels.map((_, i) => i));
  expect(def.screws.map((s) => s.id), tag).toEqual(def.screws.map((_, i) => i));
  // colour counts are multiples of 3 and match the queue
  const perColor = new Map<string, number>();
  for (const s of def.screws) perColor.set(s.color, (perColor.get(s.color) ?? 0) + 1);
  for (const [c, count] of perColor) {
    expect(count % BOX_CAPACITY, `${tag} colour ${c}`).toBe(0);
    expect(def.boxQueue.filter((q) => q === c).length, `${tag} queue ${c}`).toBe(count / BOX_CAPACITY);
  }
  expect([...perColor.keys()].sort(), tag).toEqual([...def.colors].sort());

  // panels: inside the bounding sphere, dense shells, each carrying a screw
  for (const p of def.panels) {
    expect(panelMaxRadius(p), `${tag} panel ${p.id} outside the bounding sphere`).toBeLessThanOrEqual(ASSEMBLY_RADIUS + EPS);
    expect(def.screws.some((s) => s.panelId === p.id), `${tag} panel ${p.id} has no screw`).toBe(true);
    expect(p.thickness, tag).toBeGreaterThan(0);
    expect(Math.abs(Math.hypot(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w) - 1), tag).toBeLessThan(1e-9);
  }
  const shells = [...new Set(def.panels.map((p) => p.shell))].sort((a, b) => a - b);
  expect(shells, tag).toEqual(shells.map((_, i) => i));

  // screws: on a face of their own panel, clear of the edges, unit axis
  const byId = new Map(def.panels.map((p) => [p.id, p]));
  for (const s of def.screws) {
    const panel = byId.get(s.panelId)!;
    expect(panel, `${tag} screw ${s.id} has no panel`).toBeDefined();
    expect(lengthV3(s.position), `${tag} screw ${s.id} outside the sphere`).toBeLessThanOrEqual(ASSEMBLY_RADIUS + EPS);
    expect(Math.abs(lengthV3(s.axis) - 1), `${tag} screw ${s.id} axis`).toBeLessThan(1e-9);
    const local = assemblyToPanel(panel, s.position);
    const onFace = Math.abs(local.z - panel.thickness) < 1e-6 || Math.abs(local.z) < 1e-6;
    expect(onFace, `${tag} screw ${s.id} is not on a face`).toBe(true);
    expect(Math.abs(dotV3(s.axis, panelNormal(panel))), `${tag} screw ${s.id} axis is not the face normal`).toBeCloseTo(1, 6);
    expect(pointInShape(local, panel.shape), `${tag} screw ${s.id} outside its panel`).toBe(true);
    let edge = distanceToPolygonEdge(local, panel.shape.outline);
    for (const h of panel.shape.holes ?? []) edge = Math.min(edge, distanceToPolygonEdge(local, h));
    expect(edge, `${tag} screw ${s.id} too close to the edge`).toBeGreaterThanOrEqual(SCREW_EDGE_MARGIN - EPS);
  }

  // the spacing rule, and the blocking order that makes the level solvable
  const blockers = computeBlockers(def.panels, def.screws);
  expect(spacingViolations(def.screws, blockers.map((b) => b.map((i) => def.panels[i].id))), tag).toEqual([]);
  def.screws.forEach((s, i) => {
    const own = byId.get(s.panelId)!;
    for (const pi of blockers[i]) {
      expect(def.panels[pi].shell, `${tag} screw ${i} blocked by an equal or deeper panel`).toBeLessThan(own.shell);
    }
    if (s.hidden) expect(blockers[i].length, `${tag} mystery screw ${i} is not blocked at start`).toBeGreaterThan(0);
  });
  if (n < 25) expect(def.screws.some((s) => s.hidden), tag).toBe(false);
}

describe('generator', () => {
  it('exports TOTAL_LEVELS = 1000 and rejects out-of-range levels', () => {
    expect(TOTAL_LEVELS).toBe(1000);
    expect(() => generateLevel(0)).toThrow();
    expect(() => generateLevel(1001)).toThrow();
    expect(() => generateLevel(1.5)).toThrow();
  });

  it('tutorial levels are a small closed box with 3 colours and 3 boxes', () => {
    for (const n of [1, 2, 3]) {
      const def = level(n);
      expect(def.colors.length).toBe(3);
      expect(def.activeBoxCount).toBe(3);
      expect(def.traySlots).toBe(BASE_TRAY_SLOTS);
      expect(def.screws.length).toBeGreaterThanOrEqual(9);
      expect(def.screws.length).toBeLessThanOrEqual(12);
      expect(shellCount(def.panels)).toBe(1);
      expect(def.screws.some((s) => s.hidden)).toBe(false);
      // Whichever way it is turned, some screws face the player (§6).
      expect(measureLevel(def).minViewFacing).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);

  it('keeps the difficulty rhythm and ramps along the CONTRACT_V3 §7 bands', () => {
    expect(difficultyLabelFor(10)).toBe('hard');
    expect(difficultyLabelFor(25)).toBe('extreme');
    expect(difficultyLabelFor(50)).toBe('extreme');
    expect(difficultyLabelFor(34)).toBe('easy');
    expect(difficultyLabelFor(7)).toBe('normal');
    expect(difficultyFor(24).mysteryFraction).toBe(0);
    expect(difficultyFor(25).mysteryFraction).toBeGreaterThan(0);
    expect(difficultyFor(500).screws).toBeGreaterThan(difficultyFor(100).screws);
    expect(difficultyFor(500).colors).toBeGreaterThan(difficultyFor(50).colors);
    expect(difficultyFor(1000).screws).toBeGreaterThanOrEqual(180);
    expect(difficultyFor(1000).shells).toBe(6);
    for (let n = 1; n <= TOTAL_LEVELS; n++) {
      const b = bandFor(n);
      const p = difficultyFor(n);
      expect(p.screws, `level ${n} screws`).toBeGreaterThanOrEqual(b.screws[0] - 2);
      expect(p.screws, `level ${n} screws`).toBeLessThanOrEqual(b.screws[1] + 1);
      expect(p.shells, `level ${n} shells`).toBeGreaterThanOrEqual(b.shells[0]);
      expect(p.shells, `level ${n} shells`).toBeLessThanOrEqual(b.shells[1]);
      expect(p.panels, `level ${n} panels`).toBeGreaterThanOrEqual(b.panels[0]);
      expect(p.panels, `level ${n} panels`).toBeLessThanOrEqual(b.panels[1]);
      expect(p.colors, `level ${n} colours`).toBeGreaterThanOrEqual(b.colors[0]);
      expect(p.colors, `level ${n} colours`).toBeLessThanOrEqual(b.colors[1]);
      expect(p.traySlots + MAX_BONUS_SLOTS, `level ${n} tray`).toBeLessThanOrEqual(11);
    }
  });

  it('is deterministic', () => {
    for (const n of [1, 7, 30, 421, 1000]) {
      expect(JSON.stringify(generateLevel(n)), `level ${n}`).toBe(JSON.stringify(level(n)));
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
    expect(gen!.minViewFacing).toBe(stats.minViewFacing);
    expect(gen!.ms).toBeLessThan(2500);
  }, 60_000);

  it(`every sampled level (${SAMPLE_LEVELS.length} of ${TOTAL_LEVELS}) is well-formed and winnable`, async () => {
    let genMs = 0;
    let maxMs = 0;
    let maxLevel = 0;
    let biggest = 0;
    let deepest = 0;
    let mostPanels = 0;
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
      expect(game.reachableScrewIds().length, `level ${n} has no removable screw`).toBeGreaterThan(0);

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
      expect(snap.panels.every((p) => p.dropped), `level ${n}: a panel survived the win`).toBe(true);

      biggest = Math.max(biggest, def.screws.length);
      deepest = Math.max(deepest, shellCount(def.panels));
      mostPanels = Math.max(mostPanels, def.panels.length);
    }
    console.log(
      `generateLevel over ${SAMPLE_LEVELS.length} sampled levels: avg ${(genMs / SAMPLE_LEVELS.length).toFixed(0)} ms, `
      + `total ${(genMs / 1000).toFixed(1)} s, slowest level ${maxLevel} (${maxMs.toFixed(0)} ms); `
      + `max ${biggest} screws, ${deepest} shells, ${mostPanels} panels`,
    );
    expect(maxMs, `level ${maxLevel} took ${maxMs.toFixed(0)} ms`).toBeLessThan(2500);
    expect(biggest).toBeGreaterThanOrEqual(140);
    expect(deepest).toBeGreaterThanOrEqual(5);
  }, 600_000);

  it('hits the CONTRACT_V3 §7 size bands', () => {
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      const b = bandFor(n);
      expect(def.screws.length, `level ${n} screws`).toBeGreaterThanOrEqual(b.screws[0] - 3);
      expect(def.screws.length, `level ${n} screws`).toBeLessThanOrEqual(b.screws[1]);
      expect(shellCount(def.panels), `level ${n} shells`).toBeGreaterThanOrEqual(b.shells[0] - 1);
      expect(shellCount(def.panels), `level ${n} shells`).toBeLessThanOrEqual(b.shells[1]);
      expect(def.panels.length, `level ${n} panels`).toBeLessThanOrEqual(b.panels[1]);
      expect(def.colors.length, `level ${n} colours`).toBeLessThanOrEqual(b.colors[1]);
    }
    const top = SAMPLE_LEVELS.filter((n) => n >= 701).map((n) => level(n).screws.length);
    expect(Math.max(...top), 'top band never reaches 140+ screws').toBeGreaterThanOrEqual(140);
    expect(Math.min(...top), 'top band drops below 130 screws').toBeGreaterThanOrEqual(130);
  }, 300_000);

  it('spreads screws through the shells instead of piling them on the skin', () => {
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      if (shellCount(def.panels) < 3) continue;
      expect(outerShellFraction(def.panels, def.screws), `level ${n} outer shell share`).toBeLessThanOrEqual(0.6);
    }
  }, 300_000);

  /* CONTRACT_V3 §6 — turning the assembly must never show an empty board. */
  it('keeps screws tappable from every viewing direction', () => {
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      const t = nonLinearityTargets(n);
      const s = measureLevel(def);
      expect(minViewFacing(def, new Game(def).reachableScrewIds()), `level ${n} opening view`).toBeGreaterThanOrEqual(1);
      expect(s.minViewFacing, `level ${n} worst view during play`).toBeGreaterThanOrEqual(Math.max(1, t.minViewFacing - 1));
    }
  }, 300_000);

  /* N active boxes are only N fronts if they want N different colours. */
  it('opens every level with distinct active box colours', () => {
    for (const n of SAMPLE_LEVELS) {
      const def = level(n);
      const want = Math.min(def.activeBoxCount, def.colors.length);
      const opening = new Game(def).snapshot().boxes;
      expect(opening.length, `level ${n} box count`).toBe(def.activeBoxCount);
      expect(new Set(opening.map((b) => b.color)).size, `level ${n} opens with duplicate box colours`).toBe(want);
      const s = measureLevel(def);
      expect(s.startBoxColors, `level ${n} startBoxColors`).toBe(want);
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
      expect(s.avgReachable, `level ${n} avgReachable`).toBeGreaterThanOrEqual(t.avgReachable * 0.8);
      expect(s.avgFronts, `level ${n} avgFronts`).toBeGreaterThanOrEqual(t.avgFronts * 0.8);
      expect(s.minReachable, `level ${n} minReachable`).toBeGreaterThanOrEqual(Math.max(1, t.minReachable - 1));
      expect(s.maxChokeRun, `level ${n} chokepoint run`).toBeLessThanOrEqual(Math.max(4, t.maxChokeRun));
      expect(s.startBoxColors, `level ${n} startBoxColors`).toBeGreaterThanOrEqual(t.startBoxColors);
      if (n <= 50) continue;
      counted++;
      if (s.avgReachable >= 8 && s.minReachable >= 3 && s.avgFronts >= 3 && s.maxChokeRun < 4) strict++;
    }
    console.log(`non-linearity: ${strict}/${counted} levels above 50 meet every §7 criterion strictly`);
    expect(strict / counted, 'too few levels meet the strict §7 criteria').toBeGreaterThanOrEqual(0.95);
  }, 300_000);
});
