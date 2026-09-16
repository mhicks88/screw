import { describe, expect, it } from 'vitest';
import { Game } from '../src/core/game';
import { generateLevel } from '../src/core/generator';
import { solveNextMoves } from '../src/core/solver';

describe('solver', () => {
  it('returns reachable screws only, respects maxMoves, and stays fast on 150-screw levels', () => {
    let worst = 0;
    let worstLevel = 0;
    let worstReachable = 0;
    for (const n of [12, 77, 250, 500, 800, 1000]) {
      const g = new Game(generateLevel(n));
      for (let step = 0; step < 8; step++) {
        const snap = g.snapshot();
        if (snap.status !== 'playing') break;
        const reachable = new Set(g.reachableScrewIds());
        const t0 = performance.now();
        const moves = solveNextMoves(snap, 3);
        const dt = performance.now() - t0;
        if (dt > worst) { worst = dt; worstLevel = n; worstReachable = reachable.size; }
        expect(moves.length).toBeGreaterThan(0);
        expect(moves.length).toBeLessThanOrEqual(3);
        for (const id of moves) expect(reachable.has(id), `level ${n}: hint ${id} is not reachable`).toBe(true);
        expect(solveNextMoves(snap, 1)).toHaveLength(1);
        expect(g.tapScrew(moves[0]).ok).toBe(true);
      }
    }
    console.log(`solver worst call: ${worst.toFixed(2)} ms (level ${worstLevel}, ${worstReachable} reachable)`);
    expect(worst).toBeLessThan(100);
  }, 120_000);

  it('prefers moves that put screws into boxes', () => {
    const g = new Game(generateLevel(20));
    const snap = g.snapshot();
    const boxColors = new Set(snap.boxes.map((b) => b.color));
    const matching = snap.screws.filter((s) => s.location === 'plate' && !s.blocked && boxColors.has(s.color));
    if (matching.length > 0) {
      const first = solveNextMoves(snap, 1)[0];
      expect(boxColors.has(snap.screws.find((s) => s.id === first)!.color)).toBe(true);
    }
  });

  it('returns nothing for finished games', () => {
    const g = new Game(generateLevel(1));
    const snap = g.snapshot();
    snap.status = 'won';
    expect(solveNextMoves(snap)).toEqual([]);
  });
});
