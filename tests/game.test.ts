import { describe, expect, it } from 'vitest';
import { Game } from '../src/core/game';
import { BASE, COVER, makeLevel, row, screw } from './helpers';
import type { GameEvent } from '../src/core/types';

const types = (ev: GameEvent[]) => ev.map((e) => e.type);

describe('blocking', () => {
  const level = makeLevel({
    plates: [BASE, COVER],
    screws: [screw(0, 0, 1.5, 1.5, 'red'), screw(1, 0, -1.5, -1.5, 'blue'), screw(2, 1, 1.8, 1.8, 'green')],
    boxQueue: ['red'], activeBoxCount: 1,
  });
  it('screws under a higher plate are blocked, others reachable', () => {
    const g = new Game(level);
    expect(g.reachableScrewIds().sort()).toEqual([1, 2]);
    const snap = g.snapshot();
    expect(snap.screws.find((s) => s.id === 0)!.blocked).toBe(true);
    expect(snap.screws.find((s) => s.id === 1)!.blocked).toBe(false);
    expect(snap.screws.find((s) => s.id === 2)!.blocked).toBe(false);
  });
  it('tapping a blocked screw is refused with a blockedTap event', () => {
    const g = new Game(level);
    const r = g.tapScrew(0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blocked');
    expect(r.events).toEqual([{ type: 'blockedTap', screwId: 0 }]);
    expect(g.snapshot().moves).toBe(0);
  });
  it('unknown / already removed screws are refused', () => {
    const g = new Game(level);
    expect(g.tapScrew(99).reason).toBe('noSuchScrew');
    expect(g.tapScrew(1).ok).toBe(true);
    expect(g.tapScrew(1).reason).toBe('notOnPlate');
  });
});

describe('tray / box flow and chaining', () => {
  const flowLevel = () => makeLevel({
    plates: [BASE],
    screws: [...row(0, 'red', 3, 3), ...row(3, 'blue', 1, 3), ...row(6, 'green', -1, 3)],
    boxQueue: ['red', 'blue', 'green'], activeBoxCount: 1,
  });
  it('matching screws go to the box, others to the first free tray slot', () => {
    const g = new Game(flowLevel());
    expect(g.tapScrew(0).events).toEqual([{ type: 'screwToBox', screwId: 0, boxId: 0, boxSlot: 0, from: 'plate' }]);
    expect(g.tapScrew(3).events).toEqual([{ type: 'screwToTray', screwId: 3, traySlot: 0 }]);
    expect(g.tapScrew(4).events).toEqual([{ type: 'screwToTray', screwId: 4, traySlot: 1 }]);
    const s = g.snapshot();
    expect(s.tray).toEqual([3, 4, null, null, null]);
    expect(s.boxes[0].screws).toEqual([0]);
    expect(s.removedScrews).toBe(1);
    expect(s.moves).toBe(3);
  });
  it('box completion spawns the next box and chains tray screws in causal order', () => {
    const g = new Game(flowLevel());
    for (const id of [3, 4, 5, 6]) g.tapScrew(id); // 3 blue + 1 green in tray
    g.tapScrew(0);
    g.tapScrew(1);
    const r = g.tapScrew(2);
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([
      { type: 'screwToBox', screwId: 2, boxId: 0, boxSlot: 2, from: 'plate' },
      { type: 'boxComplete', boxId: 0, position: 0 },
      { type: 'boxSpawn', box: { id: 1, color: 'blue', screws: [], position: 0, completed: false } },
      { type: 'screwToBox', screwId: 3, boxId: 1, boxSlot: 0, from: 'tray' },
      { type: 'screwToBox', screwId: 4, boxId: 1, boxSlot: 1, from: 'tray' },
      { type: 'screwToBox', screwId: 5, boxId: 1, boxSlot: 2, from: 'tray' },
      { type: 'boxComplete', boxId: 1, position: 0 },
      { type: 'boxSpawn', box: { id: 2, color: 'green', screws: [], position: 0, completed: false } },
      { type: 'screwToBox', screwId: 6, boxId: 2, boxSlot: 0, from: 'tray' },
    ]);
    const s = g.snapshot();
    expect(s.tray.every((t) => t === null)).toBe(true);
    expect(s.nextBoxIndex).toBe(3);
    expect(s.removedScrews).toBe(7);
    // last screws: complete, no spawn (queue exhausted), plate drops, win
    g.tapScrew(7);
    const last = g.tapScrew(8);
    expect(types(last.events)).toEqual(['screwToBox', 'boxComplete', 'plateDrop', 'win']);
    expect(g.snapshot().status).toBe('won');
    expect(g.snapshot().screws.every((s) => s.location === 'gone')).toBe(true);
    expect(g.tapScrew(0).reason).toBe('notPlaying');
  });
  it('auto-moves take the OLDEST tray screw first, not the lowest slot', () => {
    const level = makeLevel({
      plates: [BASE],
      screws: [...row(0, 'red', 3, 3), ...row(3, 'green', 2, 3), ...row(6, 'yellow', 1, 3), ...row(9, 'blue', 0, 3)],
      boxQueue: ['red', 'green', 'yellow', 'blue'], activeBoxCount: 1,
    });
    const g = new Game(level);
    g.tapScrew(3);  // green → slot 0
    g.tapScrew(10); // blue → slot 1 (older blue)
    for (const id of [0, 1, 2]) g.tapScrew(id); // red done → green spawns, takes screw 3 from slot 0
    expect(g.snapshot().tray).toEqual([null, 10, null, null, null]);
    g.tapScrew(11); // blue → slot 0 (newer blue)
    g.tapScrew(4); g.tapScrew(5); // green done → yellow spawns
    g.tapScrew(6); g.tapScrew(7);
    const r = g.tapScrew(8); // yellow done → blue spawns → oldest blue (10, slot 1) first
    const moves = r.events.filter((e) => e.type === 'screwToBox' && e.from === 'tray');
    expect(moves.map((e) => (e as { screwId: number }).screwId)).toEqual([10, 11]);
  });
});

describe('plate drop, unblocking and mystery reveal', () => {
  const level = makeLevel({
    plates: [BASE, COVER],
    screws: [screw(0, 0, 1.5, 1.5, 'red', true), screw(1, 1, 1.8, 1.8, 'red'), screw(2, 0, -1.5, -1.5, 'blue')],
    boxQueue: ['blue', 'red'], activeBoxCount: 2,
  });
  it('hidden blocked screws start unrevealed and reveal when unblocked', () => {
    const g = new Game(level);
    let s0 = g.snapshot().screws[0];
    expect(s0.revealed).toBe(false);
    expect(s0.blocked).toBe(true);
    const r = g.tapScrew(1);
    expect(r.events).toEqual([
      { type: 'screwToBox', screwId: 1, boxId: 1, boxSlot: 0, from: 'plate' },
      { type: 'plateDrop', plateId: 1 },
      { type: 'screwsUnblocked', screwIds: [0] },
      { type: 'screwRevealed', screwId: 0, color: 'red' },
    ]);
    s0 = g.snapshot().screws[0];
    expect(s0.revealed).toBe(true);
    expect(s0.blocked).toBe(false);
    expect(g.snapshot().plates.find((p) => p.id === 1)!.dropped).toBe(true);
    expect(g.reachableScrewIds().sort()).toEqual([0, 2]);
  });
});

describe('losing and continuing', () => {
  const level = makeLevel({
    plates: [BASE],
    screws: [...row(0, 'red', 3, 3), ...row(3, 'blue', 1, 3), ...row(6, 'blue', -1, 3)],
    boxQueue: ['red', 'blue', 'blue'], activeBoxCount: 1,
  });
  it('tapping with a full tray and no matching box loses; continueAfterLose adds a slot', () => {
    const g = new Game(level);
    for (const id of [3, 4, 5, 6, 7]) expect(g.tapScrew(id).ok).toBe(true);
    const r = g.tapScrew(8);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('trayFull');
    expect(r.events).toEqual([{ type: 'lose', reason: 'trayFull' }]);
    let s = g.snapshot();
    expect(s.status).toBe('lost');
    expect(s.screws[8].location).toBe('plate');
    expect(s.moves).toBe(5);
    expect(g.tapScrew(8).reason).toBe('notPlaying');
    expect(g.usePowerUp('addSlot').reason).toBe('notPlaying');
    const c = g.continueAfterLose();
    expect(c.ok).toBe(true);
    expect(c.events).toEqual([{ type: 'traySlotAdded', slotIndex: 5 }]);
    s = g.snapshot();
    expect(s.status).toBe('playing');
    expect(s.bonusSlots).toBe(1);
    expect(s.tray).toHaveLength(6);
    expect(g.tapScrew(8).events).toEqual([{ type: 'screwToTray', screwId: 8, traySlot: 5 }]);
    expect(g.continueAfterLose().reason).toBe('notPlaying');
    // finish: reds complete → blue spawns → chain 3 blues → next blue spawns → chain 3 more → win
    g.tapScrew(0); g.tapScrew(1);
    const last = g.tapScrew(2);
    expect(types(last.events).filter((t) => t === 'boxComplete')).toHaveLength(3);
    expect(types(last.events).at(-1)).toBe('win');
  });
});

describe('snapshots', () => {
  it('are deep copies and can rebuild an equivalent game', () => {
    const level = makeLevel({
      plates: [BASE, COVER],
      screws: [screw(0, 0, 1.5, 1.5, 'red', true), screw(1, 1, 1.8, 1.8, 'red'), screw(2, 0, -1.5, -1.5, 'blue'), screw(3, 0, -1.5, 2, 'red')],
      boxQueue: ['blue', 'red'], activeBoxCount: 2,
    });
    const g = new Game(level);
    g.tapScrew(2); // blue → active blue box (position 0)
    g.tapScrew(3); // red → active red box
    const a = g.snapshot();
    a.tray[0] = 999;
    a.boxes[0].screws.push(42);
    a.level.plates[0].shape.outline[0].x = 123;
    a.screws[0].location = 'gone';
    const b = g.snapshot();
    expect(b.tray[0]).toBe(null);
    expect(b.boxes[0].screws).toEqual([2]);
    expect(b.level.plates[0].shape.outline[0].x).toBe(-2.8);
    expect(b.screws[0].location).toBe('plate');
    const g2 = Game.fromSnapshot(b);
    expect(g2.snapshot()).toEqual(b);
    expect(g2.reachableScrewIds()).toEqual(g.reachableScrewIds());
    expect(types(g2.tapScrew(1).events)).toEqual(types(g.tapScrew(1).events));
  });
});
