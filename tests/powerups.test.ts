import { describe, expect, it } from 'vitest';
import { Game } from '../src/core/game';
import { playBot } from '../src/core/bot';
import { generateLevel } from '../src/core/generator';
import { BASE, COVER, makeLevel, row, screw, shift } from './helpers';
import { BOX_CAPACITY, type GameEvent } from '../src/core/types';

const types = (ev: GameEvent[]) => ev.map((e) => e.type);

const nineLevel = (queue: ('red' | 'blue' | 'green')[], activeBoxCount: number) => makeLevel({
  panels: [BASE],
  screws: [...row(0, 'red', 3, 3), ...row(3, 'blue', 1, 3), ...row(6, 'green', -1, 3)],
  boxQueue: queue, activeBoxCount,
});

describe('drill', () => {
  const level = makeLevel({
    panels: [BASE, COVER],
    screws: [screw(0, 0, 1.5, 1.5, 'red', true), screw(1, 1, 1.8, 1.8, 'blue'), screw(2, 0, -1.5, -1.5, 'green'), screw(3, 0, -1.5, 0.5, 'red'), screw(4, 0, -1.5, 2, 'red')],
    boxQueue: ['red', 'blue'], activeBoxCount: 2,
  });
  it('removes a blocked mystery screw (revealing it first)', () => {
    const g = new Game(level);
    const r = g.usePowerUp('drill', 0);
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([
      { type: 'screwRevealed', screwId: 0, color: 'red' },
      { type: 'screwToBox', screwId: 0, boxId: 0, boxSlot: 0, from: 'plate' },
    ]);
    expect(g.snapshot().screws[0].location).toBe('box');
    expect(g.usePowerUp('drill', 0).reason).toBe('notOnPlate');
    expect(g.usePowerUp('drill').reason).toBe('noSuchScrew');
    expect(g.usePowerUp('drill', 77).reason).toBe('noSuchScrew');
  });
  it('drops the panel when it drills the last screw of a panel', () => {
    const g = new Game(level);
    expect(types(g.usePowerUp('drill', 1).events)).toEqual(['screwToBox', 'panelDrop', 'screwsUnblocked', 'screwRevealed']);
  });
  it('refuses without losing when there is no room', () => {
    const l = makeLevel({ panels: [BASE], screws: [...row(0, 'red', 3, 3), ...row(3, 'blue', 1, 3), ...row(6, 'blue', -1, 3)], boxQueue: ['red', 'blue', 'blue'], activeBoxCount: 1 });
    const g = new Game(l);
    for (const id of [3, 4, 5, 6, 7]) g.tapScrew(id);
    const r = g.usePowerUp('drill', 8);
    expect(r).toEqual({ ok: false, reason: 'trayFull', events: [] });
    expect(g.snapshot().status).toBe('playing');
  });
});

describe('addSlot', () => {
  it('adds up to MAX_BONUS_SLOTS slots', () => {
    const g = new Game(nineLevel(['red', 'blue', 'green'], 1));
    for (let i = 0; i < 3; i++) {
      const r = g.usePowerUp('addSlot');
      expect(r.ok).toBe(true);
      expect(r.events).toEqual([{ type: 'traySlotAdded', slotIndex: 5 + i }]);
    }
    expect(g.usePowerUp('addSlot').reason).toBe('maxSlots');
    expect(g.snapshot().bonusSlots).toBe(3);
    expect(g.snapshot().tray).toHaveLength(8);
  });
});

describe('addBox', () => {
  it('spawns a bonus box of the most needed colour and consumes its future queue entry', () => {
    const g = new Game(nineLevel(['red', 'blue', 'green'], 1));
    g.tapScrew(6); g.tapScrew(7); g.tapScrew(3); // tray: green, green, blue
    const r = g.usePowerUp('addBox');
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([
      { type: 'boxSpawn', box: { id: 1, color: 'green', screws: [], position: 1, completed: false } },
      { type: 'screwToBox', screwId: 6, boxId: 1, boxSlot: 0, from: 'tray' },
      { type: 'screwToBox', screwId: 7, boxId: 1, boxSlot: 1, from: 'tray' },
    ]);
    let s = g.snapshot();
    expect(s.level.boxQueue).toEqual(['red', 'blue']);
    expect(s.nextBoxIndex).toBe(1);
    expect(s.boxes.map((b) => b.position)).toEqual([0, 1]);
    // completing the bonus box does not respawn at the bonus position
    const c = g.tapScrew(8);
    expect(types(c.events)).toEqual(['screwToBox', 'boxComplete']);
    s = g.snapshot();
    expect(s.boxes).toHaveLength(1);
    // the level is still completable: 3 red → blue spawns → chains, then 2 blue → win
    g.tapScrew(0); g.tapScrew(1);
    expect(types(g.tapScrew(2).events)).toEqual(['screwToBox', 'boxComplete', 'boxSpawn', 'screwToBox']);
    g.tapScrew(4);
    expect(types(g.tapScrew(5).events)).toEqual(['screwToBox', 'boxComplete', 'panelDrop', 'win']);
  });
  it('is refused when nothing is queued or the box row is full', () => {
    const g = new Game(makeLevel({ panels: [BASE], screws: row(0, 'red', 3, 3), boxQueue: ['red'], activeBoxCount: 1 }));
    expect(g.usePowerUp('addBox').reason).toBe('nothingToDo');
    const full = new Game(makeLevel({
      panels: [BASE], screws: [...row(0, 'red', 3, 3), ...row(3, 'blue', 2, 3), ...row(6, 'green', 1, 3), ...row(9, 'yellow', 0, 3), ...row(12, 'red', -1, 3)],
      boxQueue: ['red', 'blue', 'green', 'yellow', 'red'], activeBoxCount: 4,
    }));
    expect(full.usePowerUp('addBox').reason).toBe('maxBoxes');
  });
});

describe('recolor', () => {
  it('recolours an empty box, returns the old colour to the front of the queue and consumes the new one', () => {
    const g = new Game(nineLevel(['red', 'blue', 'green'], 2));
    g.tapScrew(6); g.tapScrew(7); // 2 green in tray
    const r = g.usePowerUp('recolor');
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([
      { type: 'boxRecolored', boxId: 0, color: 'green' },
      { type: 'screwToBox', screwId: 6, boxId: 0, boxSlot: 0, from: 'tray' },
      { type: 'screwToBox', screwId: 7, boxId: 0, boxSlot: 1, from: 'tray' },
    ]);
    const s = g.snapshot();
    expect(s.level.boxQueue).toEqual(['red', 'blue', 'red']);
    expect(s.nextBoxIndex).toBe(2);
    expect(s.boxes.map((b) => b.color)).toEqual(['green', 'blue']);
    // still completable
    expect(types(g.tapScrew(8).events)).toEqual(['screwToBox', 'boxComplete', 'boxSpawn']);
    expect(g.snapshot().boxes.map((b) => b.color)).toEqual(['red', 'blue']);
    for (const id of [0, 1, 2, 3, 4]) g.tapScrew(id);
    expect(g.tapScrew(5).events.at(-1)).toEqual({ type: 'win' });
  });
  it('is refused when no box is empty or nothing useful is queued', () => {
    const g = new Game(nineLevel(['red', 'blue', 'green'], 2));
    g.tapScrew(0); g.tapScrew(3);
    expect(g.usePowerUp('recolor').reason).toBe('noEmptyBox');
    const g2 = new Game(makeLevel({ panels: [BASE], screws: row(0, 'red', 3, 3), boxQueue: ['red'], activeBoxCount: 1 }));
    expect(g2.usePowerUp('recolor').reason).toBe('nothingToDo');
  });
});

describe('magnet', () => {
  it('fills the boxes on screen and stops, rather than chaining through refills', () => {
    // Two active boxes with three spaces each: the magnet takes exactly six and
    // leaves the rest. It used to loop until nothing matched, which chained
    // through every refill and cleared whole levels from one tap.
    const g = new Game(nineLevel(['red', 'blue', 'green'], 2));
    const r = g.usePowerUp('magnet');
    expect(r.ok).toBe(true);
    const t = types(r.events);
    expect(t.filter((x) => x === 'screwToBox')).toHaveLength(2 * BOX_CAPACITY);
    expect(t.filter((x) => x === 'boxComplete')).toHaveLength(2);
    expect(t).not.toContain('win');
    const s = g.snapshot();
    expect(s.status).toBe('playing');
    expect(s.removedScrews).toBe(6);
    // The replacement boxes make a second pull possible, so it is not a one-shot.
    expect(g.usePowerUp('magnet').ok).toBe(true);
  });

  it('never clears more than the visible box capacity on a real level', () => {
    for (const n of [60, 350, 700, 1000]) {
      const g = new Game(generateLevel(n));
      const before = g.snapshot();
      g.usePowerUp('magnet');
      const pulled = g.snapshot().removedScrews - before.removedScrews;
      expect(pulled).toBeGreaterThan(0);
      expect(pulled).toBeLessThanOrEqual(before.boxes.length * BOX_CAPACITY);
      // The whole point: one tap must not finish the level.
      expect(g.snapshot().status).toBe('playing');
    }
  }, 60_000);

  it('never pushes a screw into the tray, so it cannot lose the game', () => {
    const g = new Game(generateLevel(350));
    // Fill the tray by hand with screws that match nothing on screen.
    for (let i = 0; i < 40 && g.snapshot().tray.some((x) => x === null); i++) {
      const s = g.snapshot();
      const boxed = new Set(s.boxes.map((b) => b.color));
      const byId = new Map(s.screws.map((x) => [x.id, x]));
      const id = g.reachableScrewIds().find((x) => !boxed.has(byId.get(x)!.color));
      if (id === undefined) break;
      g.tapScrew(id);
    }
    const trayBefore = g.snapshot().tray.filter(Boolean).length;
    const r = g.usePowerUp('magnet');
    const after = g.snapshot();
    expect(after.status).not.toBe('lost');
    expect(after.tray.filter(Boolean).length).toBeLessThanOrEqual(trayBefore);
    expect(types(r.events)).not.toContain('lose');
  }, 60_000);
  it('does nothing when no reachable screw matches', () => {
    const level = makeLevel({
      panels: [BASE, COVER],
      screws: [screw(0, 0, 1, 1, 'red'), screw(1, 0, 2, 1, 'red'), screw(2, 0, 1, 2, 'red'), ...row(3, 'blue', 2, 3, 1).map((s) => shift(s, 3, 0))],
      boxQueue: ['red', 'blue'], activeBoxCount: 1,
    });
    const g = new Game(level);
    expect(g.usePowerUp('magnet')).toEqual({ ok: false, reason: 'nothingToDo', events: [] });
  });
});

describe('hint', () => {
  it('never mutates and only returns reachable screws', () => {
    const g = new Game(generateLevel(40));
    const before = g.snapshot();
    const r = g.usePowerUp('hint');
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([]);
    expect(r.hintScrewIds!.length).toBeGreaterThan(0);
    expect(r.hintScrewIds!.length).toBeLessThanOrEqual(3);
    const reachable = new Set(g.reachableScrewIds());
    for (const id of r.hintScrewIds!) expect(reachable.has(id)).toBe(true);
    expect(g.snapshot()).toEqual(before);
  }, 60_000);
});

describe('power-ups on generated levels keep the queue consistent', () => {
  it('addBox + recolor mid-game keep "every screw has a box", and the level is still winnable', () => {
    for (const n of [40, 90, 150]) {
      const def = generateLevel(n);
      const g = new Game(def);
      // a few moves, then a bonus box and a recolor, then play out
      for (let i = 0; i < 4; i++) g.tapScrew(g.reachableScrewIds()[0]);
      g.usePowerUp('addBox');
      g.usePowerUp('recolor');
      g.usePowerUp('addSlot');
      g.usePowerUp('addSlot');
      g.usePowerUp('addSlot');

      // Invariant: for every colour, the screws still in play are exactly the
      // ones the remaining queue plus the open active boxes can take.
      const snap = g.snapshot();
      const left = new Map<string, number>();
      for (const s of snap.screws) {
        if (s.location === 'plate' || s.location === 'tray') left.set(s.color, (left.get(s.color) ?? 0) + 1);
      }
      const capacity = new Map<string, number>();
      for (const c of snap.level.boxQueue.slice(snap.nextBoxIndex)) capacity.set(c, (capacity.get(c) ?? 0) + BOX_CAPACITY);
      for (const b of snap.boxes) capacity.set(b.color, (capacity.get(b.color) ?? 0) + (BOX_CAPACITY - b.screws.length));
      for (const [c, k] of left) expect(capacity.get(c) ?? 0, `level ${n} colour ${c}`).toBe(k);

      // It is still winnable from here (the bot is greedy, so give it a few tries).
      let won = false;
      for (let seed = 1; seed <= 6 && !won; seed++) {
        const res = playBot(g.clone(), seed);
        won = res.outcome === 'won';
      }
      expect(won, `level ${n} became unwinnable after the power-ups`).toBe(true);
    }
  }, 120_000);
});
