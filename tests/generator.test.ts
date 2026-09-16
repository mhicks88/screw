import { describe, expect, it } from 'vitest';
import { TOTAL_LEVELS, generateLevel } from '../src/core/generator';
import { difficultyFor } from '../src/core/difficulty';
import { Game } from '../src/core/game';
import { playBot } from '../src/core/bot';
import { plateContainsWorldPoint, plateEdgeDistance, plateWorldOutline, polygonAabb, polygonsOverlap } from '../src/core/geometry';
import { BOX_CAPACITY, MAX_ACTIVE_BOXES, type LevelDef } from '../src/core/types';
import { BOARD, SCREW_EDGE_MARGIN, SCREW_SPACING } from '../src/core/placement';

const EPS = 1e-6;

function checkConstraints(def: LevelDef, n: number): void {
  const tag = `level ${n}`;
  expect(def.level, tag).toBe(n);
  expect(def.difficulty, tag).toBe(difficultyFor(n).label);
  expect(def.activeBoxCount, tag).toBeGreaterThanOrEqual(1);
  expect(def.activeBoxCount, tag).toBeLessThanOrEqual(MAX_ACTIVE_BOXES);
  expect(def.plates.length, tag).toBeGreaterThanOrEqual(2);
  expect(def.screws.length % BOX_CAPACITY, tag).toBe(0);
  expect(def.boxQueue.length, tag).toBe(def.screws.length / BOX_CAPACITY);
  // ids
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
  // screws: inside their plate with margin, spaced apart, hidden only if blocked at start
  for (let i = 0; i < def.screws.length; i++) {
    const s = def.screws[i];
    const p = plateById.get(s.plateId)!;
    expect(plateContainsWorldPoint(p, s.x, s.y), `${tag} screw ${i} outside plate`).toBe(true);
    expect(plateEdgeDistance(p, s.x, s.y), `${tag} screw ${i} margin`).toBeGreaterThanOrEqual(SCREW_EDGE_MARGIN - EPS);
    for (let j = i + 1; j < def.screws.length; j++) {
      const t = def.screws[j];
      expect(Math.hypot(s.x - t.x, s.y - t.y), `${tag} screws ${i},${j} too close`).toBeGreaterThanOrEqual(SCREW_SPACING - EPS);
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
      const def = generateLevel(n);
      expect(def.colors.length).toBe(3);
      expect(def.activeBoxCount).toBe(3);
      expect(def.screws.length).toBeGreaterThanOrEqual(9);
      expect(def.screws.length).toBeLessThanOrEqual(12);
      expect(def.plates.length).toBeLessThanOrEqual(3);
    }
  });

  it('difficulty ramps with level and has a rhythm', () => {
    expect(difficultyFor(10).label).toBe('hard');
    expect(difficultyFor(25).label).toBe('extreme');
    expect(difficultyFor(50).label).toBe('extreme');
    expect(difficultyFor(34).label).toBe('easy');
    expect(difficultyFor(7).label).toBe('normal');
    expect(difficultyFor(24).mysteryFraction).toBe(0);
    expect(difficultyFor(25).mysteryFraction).toBeGreaterThan(0);
    expect(difficultyFor(900).mysteryFraction).toBeCloseTo(0.35, 5);
    expect(difficultyFor(500).screws).toBeGreaterThan(difficultyFor(100).screws);
    expect(difficultyFor(500).colors).toBeGreaterThan(difficultyFor(50).colors);
  });

  it(`every level 1..${TOTAL_LEVELS} is deterministic, well-formed and winnable with its fixed queue`, () => {
    let genMs = 0;
    let maxMs = 0;
    let maxLevel = 0;
    for (let n = 1; n <= TOTAL_LEVELS; n++) {
      const t0 = performance.now();
      const def = generateLevel(n);
      const dt = performance.now() - t0;
      genMs += dt;
      if (dt > maxMs) { maxMs = dt; maxLevel = n; }
      if (n % 7 === 1) expect(generateLevel(n), `level ${n} not deterministic`).toEqual(def);
      checkConstraints(def, n);
      const game = new Game(def);
      expect(game.reachableScrewIds().length, `level ${n} has no reachable screw`).toBeGreaterThan(0);
      const res = playBot(game, def.seed);
      expect(res.outcome, `level ${n} bot outcome`).toBe('won');
      expect(game.snapshot().status, `level ${n}`).toBe('won');
      expect(game.snapshot().removedScrews).toBe(def.screws.length);
    }
    console.log(`generateLevel: avg ${(genMs / TOTAL_LEVELS).toFixed(2)} ms, total ${(genMs / 1000).toFixed(1)} s, slowest level ${maxLevel} (${maxMs.toFixed(0)} ms)`);
  }, 120_000);
});
