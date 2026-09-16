import { describe, expect, it } from 'vitest';
import { RAY_LENGTH, blockersForScrew, computeBlockers, reachableScrews } from '../src/core/blocking';
import { Game } from '../src/core/game';
import { normalizeV3, quatFromUnitVectors, v3 } from '../src/core/geometry3';
import { rectShape } from '../src/core/shapes';
import { ASSEMBLY_RADIUS, type PanelDef, type ScrewDef, type Vec3 } from '../src/core/types';
import { BASE, COVER, makeLevel, row, screw } from './helpers';

function facing(id: number, shell: number, position: Vec3, normal: Vec3, hw = 1, hh = 1): PanelDef {
  return {
    id, shape: rectShape(hw, hh), thickness: 0.1, position,
    rotation: quatFromUnitVectors(v3(0, 0, 1), normalizeV3(normal)),
    color: 0, material: 'metal', shell,
  };
}

describe('the blocking rule (CONTRACT_V3 §3)', () => {
  it('a screw is blocked by any panel its withdrawal ray passes through', () => {
    const panels = [facing(0, 1, v3(0, 0, 0), v3(0, 0, 1), 2, 2), facing(1, 0, v3(0.5, 0, 1), v3(0, 0, 1))];
    const screws: ScrewDef[] = [
      { id: 0, panelId: 0, position: v3(0.5, 0, 0.1), axis: v3(0, 0, 1), color: 'red', hidden: false },
      { id: 1, panelId: 0, position: v3(-1.5, 0, 0.1), axis: v3(0, 0, 1), color: 'red', hidden: false },
    ];
    const blockers = computeBlockers(panels, screws);
    expect(blockers[0]).toEqual([1]);
    expect(blockers[1]).toEqual([]);
    expect(reachableScrews(screws, blockers, () => false)).toEqual([1]);
    expect(reachableScrews(screws, blockers, () => true)).toEqual([0, 1]);
  });

  it('the ray only looks along the axis, so screws on different faces are independent', () => {
    const panels = [facing(0, 0, v3(0, 0, 1), v3(0, 0, 1)), facing(1, 0, v3(1, 0, 0), v3(1, 0, 0))];
    // A screw on panel 1's face withdrawing along +x passes nowhere near panel 0.
    const s: ScrewDef = { id: 0, panelId: 1, position: v3(1.1, 0, 0.5), axis: v3(1, 0, 0), color: 'red', hidden: false };
    expect(blockersForScrew(panels, s)).toEqual([]);
    // The same screw pointing +z instead is blocked by panel 0.
    expect(blockersForScrew(panels, { ...s, position: v3(0.5, 0, 0.5), axis: v3(0, 0, 1) })).toEqual([0]);
  });

  it('a screw never blocks itself, even flush against its own panel', () => {
    const panels = [facing(0, 0, v3(0, 0, 0), v3(0, 0, 1))];
    const s: ScrewDef = { id: 0, panelId: 0, position: v3(0, 0, 0.1), axis: v3(0, 0, 1), color: 'red', hidden: false };
    expect(blockersForScrew(panels, s)).toEqual([]);
  });

  it('the ray reaches across the whole assembly', () => {
    expect(RAY_LENGTH).toBeGreaterThanOrEqual(2 * ASSEMBLY_RADIUS);
    const panels = [facing(0, 1, v3(0, 0, -2.5), v3(0, 0, 1)), facing(1, 0, v3(0, 0, 2.5), v3(0, 0, 1))];
    const s: ScrewDef = { id: 0, panelId: 0, position: v3(0, 0, -2.4), axis: v3(0, 0, 1), color: 'red', hidden: false };
    expect(blockersForScrew(panels, s)).toEqual([1]);
  });
});

describe('the Game applies the rule and re-derives it after every move', () => {
  const level = makeLevel({
    panels: [BASE, COVER],
    screws: [screw(0, 0, 1.5, 1.5, 'red'), screw(1, 0, -1.5, -1.5, 'blue'), screw(2, 1, 1.8, 1.8, 'green')],
    boxQueue: ['green', 'red'], activeBoxCount: 1,
  });

  it('agrees with a from-scratch recomputation at every step of a play-through', () => {
    const g = new Game(level);
    const blockers = computeBlockers(level.panels, level.screws);
    for (let step = 0; step < 4; step++) {
      const dropped = new Set(g.snapshot().panels.filter((p) => p.dropped).map((p) => p.id));
      const onPanel = new Set(g.snapshot().screws.filter((s) => s.location === 'plate').map((s) => s.id));
      const expected = reachableScrews(level.screws, blockers, (pi) => dropped.has(level.panels[pi].id))
        .filter((id) => onPanel.has(id));
      expect(g.reachableScrewIds().sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
      const next = g.reachableScrewIds()[0];
      if (next === undefined) break;
      g.tapScrew(next);
    }
  });

  it('removing the covering panel unblocks what was behind it', () => {
    const g = new Game(level);
    expect(g.isBlocked(0)).toBe(true);
    const r = g.tapScrew(2);                       // the cover's only screw
    expect(r.events.map((e) => e.type)).toContain('panelDrop');
    expect(r.events.map((e) => e.type)).toContain('screwsUnblocked');
    expect(g.isBlocked(0)).toBe(false);
  });

  it('drill removes a screw whose withdrawal path is obstructed', () => {
    const g = new Game(level);
    expect(g.tapScrew(0).reason).toBe('blocked');
    const r = g.usePowerUp('drill', 0);
    expect(r.ok).toBe(true);
    expect(g.snapshot().screws.find((s) => s.id === 0)!.location).not.toBe('plate');
  });

  it('a panel with no screws left drops, whatever order its screws went', () => {
    const g = new Game(makeLevel({
      panels: [BASE], screws: row(0, 'red', 0, 3), boxQueue: ['red'], activeBoxCount: 1,
    }));
    g.tapScrew(1);
    g.tapScrew(0);
    const last = g.tapScrew(2);
    expect(last.events.map((e) => e.type)).toEqual(['screwToBox', 'boxComplete', 'panelDrop', 'win']);
  });
});
