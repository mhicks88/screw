/**
 * Standalone dev harness for the renderer (open /render-dev.html with `vite`).
 * Uses the real core (generateLevel + Game) when src/core/index.ts exists,
 * otherwise a small fake game with just enough rules to exercise every event.
 */
import type {
  ActionResult,
  BoxState,
  GameApi,
  GameEvent,
  GameSnapshot,
  LevelDef,
  PlateDef,
  PowerUpId,
  ScrewColor,
  ScrewDef,
  ScrewState,
  Vec2,
} from '../core/types';
import { BOX_CAPACITY } from '../core/types';
import { GameRenderer } from './renderer';

/* ----------------------------- fake level ------------------------------ */

function rect(w: number, h: number): Vec2[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
}

function roundedRect(w: number, h: number, r: number, n = 5): Vec2[] {
  const pts: Vec2[] = [];
  const corners = [
    [w / 2 - r, -h / 2 + r, -Math.PI / 2],
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, Math.PI / 2],
    [-w / 2 + r, -h / 2 + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  }
  return pts;
}

function lShape(): Vec2[] {
  return [
    { x: -1.6, y: -1.3 },
    { x: 1.6, y: -1.3 },
    { x: 1.6, y: 0.1 },
    { x: 0.1, y: 0.1 },
    { x: 0.1, y: 1.5 },
    { x: -1.6, y: 1.5 },
  ];
}

function toWorld(p: PlateDef, lx: number, ly: number): Vec2 {
  const c = Math.cos(p.rotation);
  const s = Math.sin(p.rotation);
  return { x: p.x + lx * c - ly * s, y: p.y + lx * s + ly * c };
}

function buildFakeLevel(): LevelDef {
  const plates: PlateDef[] = [
    { id: 0, layer: 0, shape: { kind: 'rect', outline: rect(4.6, 3.2) }, x: 0, y: 1.6, rotation: 0.06, color: 0x3f8cf5, material: 'plastic' },
    { id: 1, layer: 0, shape: { kind: 'roundedRect', outline: roundedRect(4.2, 2.8, 0.5) }, x: -0.3, y: -2.3, rotation: -0.08, color: 0xf2b134, material: 'plastic' },
    { id: 2, layer: 1, shape: { kind: 'L', outline: lShape() }, x: 0.9, y: -0.1, rotation: 0.35, color: 0xe85d75, material: 'plastic' },
    { id: 3, layer: 2, shape: { kind: 'roundedRect', outline: roundedRect(2.2, 1.4, 0.4) }, x: -1.4, y: 0.9, rotation: -0.5, color: 0x9b5de5, material: 'metal' },
  ];
  const p = (id: number) => plates[id];
  const raw: { plate: number; lx: number; ly: number; color: ScrewColor; hidden?: boolean }[] = [
    { plate: 0, lx: -1.8, ly: 1.0, color: 'red' },
    { plate: 0, lx: -0.6, ly: 1.1, color: 'blue' },
    { plate: 0, lx: 1.4, ly: 1.1, color: 'green' },
    { plate: 0, lx: 0.4, ly: -0.2, color: 'yellow', hidden: true },
    { plate: 0, lx: 1.8, ly: -1.0, color: 'red' },
    { plate: 1, lx: -1.5, ly: 0.6, color: 'blue' },
    { plate: 1, lx: -1.4, ly: -0.7, color: 'green' },
    { plate: 1, lx: 0.2, ly: -0.9, color: 'yellow' },
    { plate: 2, lx: -1.1, ly: 0.9, color: 'red' },
    { plate: 2, lx: -0.9, ly: -0.7, color: 'blue' },
    { plate: 2, lx: 0.9, ly: -0.7, color: 'green' },
    { plate: 3, lx: -0.5, ly: 0.1, color: 'yellow' },
    { plate: 3, lx: 0.5, ly: -0.1, color: 'green' },
    { plate: 1, lx: 1.4, ly: 0.2, color: 'red' },
    { plate: 2, lx: 0.1, ly: -0.7, color: 'yellow' },
  ];
  const screws: ScrewDef[] = raw.map((r, i) => {
    const w = toWorld(p(r.plate), r.lx, r.ly);
    return { id: i, plateId: r.plate, x: w.x, y: w.y, color: r.color, hidden: !!r.hidden };
  });
  // 15 screws: 4 red, 3 blue, 4 green, 4 yellow is not balanced; fix to multiples of 3 → 15 = 5 boxes
  const counts: Record<string, number> = {};
  for (const s of screws) counts[s.color] = (counts[s.color] ?? 0) + 1;
  const queue: ScrewColor[] = ['blue', 'red', 'green', 'yellow', 'red', 'green', 'yellow'];
  return {
    level: 1,
    seed: 42,
    plates,
    screws,
    boxQueue: queue,
    activeBoxCount: 2,
    traySlots: 5,
    colors: ['red', 'blue', 'green', 'yellow'],
    difficulty: 'easy',
  };
}

/* ------------------------------ fake game ------------------------------ */

function pointInPoly(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function plateContains(plate: PlateDef, x: number, y: number): boolean {
  const dx = x - plate.x;
  const dy = y - plate.y;
  const c = Math.cos(-plate.rotation);
  const s = Math.sin(-plate.rotation);
  return pointInPoly({ x: dx * c - dy * s, y: dx * s + dy * c }, plate.shape.outline);
}

class FakeGame implements GameApi {
  private readonly level: LevelDef;
  private status: GameSnapshot['status'] = 'playing';
  private screws: ScrewState[];
  private boxes: BoxState[] = [];
  private tray: (number | null)[];
  private dropped = new Set<number>();
  private nextBoxIndex = 0;
  private nextBoxId = 0;
  private moves = 0;
  private bonus = 0;

  constructor(level: LevelDef) {
    this.level = level;
    this.screws = level.screws.map((s) => ({
      id: s.id, color: s.color, plateId: s.plateId, location: 'plate', revealed: !s.hidden, blocked: false,
    }));
    this.tray = Array.from({ length: level.traySlots }, () => null);
    for (let i = 0; i < level.activeBoxCount; i++) this.spawnBox(i);
    this.refreshBlocked();
    for (const s of this.screws) if (!s.blocked) s.revealed = true;
  }

  private spawnBox(position: number): BoxState | null {
    if (this.nextBoxIndex >= this.level.boxQueue.length) return null;
    const box: BoxState = { id: this.nextBoxId++, color: this.level.boxQueue[this.nextBoxIndex++], screws: [], position, completed: false };
    this.boxes.push(box);
    this.boxes.sort((a, b) => a.position - b.position);
    return box;
  }

  private isBlocked(s: ScrewState): boolean {
    const def = this.level.screws[s.id];
    const layer = this.level.plates.find((p) => p.id === s.plateId)?.layer ?? 0;
    return this.level.plates.some((p) => p.layer > layer && !this.dropped.has(p.id) && plateContains(p, def.x, def.y));
  }

  private refreshBlocked(): number[] {
    const newly: number[] = [];
    for (const s of this.screws) {
      if (s.location !== 'plate') continue;
      const b = this.isBlocked(s);
      if (s.blocked && !b) newly.push(s.id);
      s.blocked = b;
    }
    return newly;
  }

  snapshot(): GameSnapshot {
    return structuredClone({
      level: this.level,
      status: this.status,
      screws: this.screws,
      plates: this.level.plates.map((p) => ({
        id: p.id,
        dropped: this.dropped.has(p.id),
        remainingScrews: this.screws.filter((s) => s.plateId === p.id && s.location === 'plate').map((s) => s.id),
      })),
      boxes: this.boxes,
      nextBoxIndex: this.nextBoxIndex,
      tray: this.tray,
      bonusSlots: this.bonus,
      moves: this.moves,
      totalScrews: this.screws.length,
      removedScrews: this.screws.filter((s) => s.location === 'box' || s.location === 'gone').length,
    });
  }

  reachableScrewIds(): number[] {
    return this.screws.filter((s) => s.location === 'plate' && !s.blocked).map((s) => s.id);
  }

  tapScrew(screwId: number, force = false): ActionResult {
    if (this.status !== 'playing') return { ok: false, reason: 'notPlaying', events: [] };
    const s = this.screws[screwId];
    if (!s) return { ok: false, reason: 'noSuchScrew', events: [] };
    if (s.location !== 'plate') return { ok: false, reason: 'notOnPlate', events: [] };
    if (s.blocked && !force) return { ok: false, reason: 'blocked', events: [{ type: 'blockedTap', screwId }] };
    const events: GameEvent[] = [];
    const box = this.boxes.find((b) => b.color === s.color && b.screws.length < BOX_CAPACITY);
    if (box) {
      this.putInBox(s, box, 'plate', events);
    } else {
      const slot = this.tray.indexOf(null);
      if (slot < 0) {
        this.status = 'lost';
        return { ok: false, reason: 'trayFull', events: [{ type: 'lose', reason: 'trayFull' }] };
      }
      s.location = 'tray';
      s.traySlot = slot;
      this.tray[slot] = s.id;
      events.push({ type: 'screwToTray', screwId: s.id, traySlot: slot });
    }
    this.moves++;
    this.afterRemoval(s, events);
    return { ok: true, events };
  }

  private putInBox(s: ScrewState, box: BoxState, from: 'plate' | 'tray', events: GameEvent[]): void {
    if (from === 'tray' && s.traySlot !== undefined) this.tray[s.traySlot] = null;
    s.location = 'box';
    s.boxId = box.id;
    s.boxSlot = box.screws.length;
    s.traySlot = undefined;
    box.screws.push(s.id);
    events.push({ type: 'screwToBox', screwId: s.id, boxId: box.id, boxSlot: s.boxSlot, from });
    if (box.screws.length === BOX_CAPACITY) {
      box.completed = true;
      this.boxes = this.boxes.filter((b) => b !== box);
      for (const id of box.screws) this.screws[id].location = 'gone';
      events.push({ type: 'boxComplete', boxId: box.id, position: box.position });
      const nb = this.spawnBox(box.position);
      if (nb) {
        events.push({ type: 'boxSpawn', box: structuredClone(nb) });
        for (const id of [...this.tray]) {
          if (id === null) continue;
          const ts = this.screws[id];
          if (ts.color === nb.color && nb.screws.length < BOX_CAPACITY) this.putInBox(ts, nb, 'tray', events);
        }
      }
    }
  }

  private afterRemoval(s: ScrewState, events: GameEvent[]): void {
    const remaining = this.screws.filter((o) => o.plateId === s.plateId && o.location === 'plate');
    if (remaining.length === 0 && !this.dropped.has(s.plateId)) {
      this.dropped.add(s.plateId);
      events.push({ type: 'plateDrop', plateId: s.plateId });
      const newly = this.refreshBlocked();
      if (newly.length) events.push({ type: 'screwsUnblocked', screwIds: newly });
      for (const id of newly) {
        const o = this.screws[id];
        if (!o.revealed) {
          o.revealed = true;
          events.push({ type: 'screwRevealed', screwId: id, color: o.color });
        }
      }
    }
    if (this.screws.every((o) => o.location === 'gone')) {
      this.status = 'won';
      events.push({ type: 'win' });
    }
  }

  usePowerUp(id: PowerUpId, target?: number): ActionResult {
    if (id === 'hint') return { ok: true, events: [], hintScrewIds: this.reachableScrewIds().slice(0, 3) };
    if (id === 'drill' && target !== undefined) return this.tapScrew(target, true);
    if (id === 'addSlot') {
      this.tray.push(null);
      this.bonus++;
      return { ok: true, events: [{ type: 'traySlotAdded', slotIndex: this.tray.length - 1 }] };
    }
    if (id === 'recolor') {
      const box = this.boxes.find((b) => b.screws.length === 0);
      if (!box) return { ok: false, reason: 'noEmptyBox', events: [] };
      const colors: ScrewColor[] = ['red', 'blue', 'green', 'yellow'];
      box.color = colors[(colors.indexOf(box.color) + 1) % colors.length];
      return { ok: true, events: [{ type: 'boxRecolored', boxId: box.id, color: box.color }] };
    }
    if (id === 'addBox') {
      const nb = this.spawnBox(this.boxes.length);
      if (!nb) return { ok: false, reason: 'maxBoxes', events: [] };
      return { ok: true, events: [{ type: 'boxSpawn', box: structuredClone(nb) }] };
    }
    return { ok: false, reason: 'nothingToDo', events: [] };
  }

  continueAfterLose(): ActionResult {
    this.status = 'playing';
    return this.usePowerUp('addSlot');
  }
}

/* -------------------------------- boot --------------------------------- */

interface CoreModule {
  generateLevel: (n: number) => LevelDef;
  Game: new (level: LevelDef) => GameApi;
}

async function loadCore(): Promise<CoreModule | null> {
  const mods = import.meta.glob('../core/index.ts') as Record<string, () => Promise<unknown>>;
  const loader = mods['../core/index.ts'];
  if (!loader) return null;
  try {
    const m = (await loader()) as Partial<CoreModule>;
    if (typeof m.generateLevel === 'function' && typeof m.Game === 'function') return m as CoreModule;
  } catch (err) {
    console.warn('[harness] real core failed to load, using fake game', err);
  }
  return null;
}

async function main(): Promise<void> {
  const container = document.getElementById('app')!;
  const status = document.getElementById('status')!;
  const core = await loadCore();
  const params = new URLSearchParams(location.search);
  let levelNo = Number(params.get('level') ?? '1') || 1;
  let game: GameApi;
  const newGame = () => {
    game = core ? new core.Game(core.generateLevel(levelNo)) : new FakeGame(buildFakeLevel());
    renderer.loadLevel(game.snapshot());
    status.textContent = `${core ? 'core' : 'fake'} level ${levelNo}`;
  };

  let targeting = false;
  const renderer = new GameRenderer(container, {
    onScrewTap: (id) => {
      const res = targeting ? game.usePowerUp('drill', id) : game.tapScrew(id);
      if (targeting) {
        targeting = false;
        renderer.setTargetingMode(false);
      }
      renderer.setHint([]);
      log(`tap ${id} → ${res.ok ? 'ok' : res.reason} ${res.events.map((e) => e.type).join(',')}`);
      void renderer.playEvents(res.events).then(() => log(`done ${res.events.length} events`));
    },
  });
  const top = document.getElementById('top')!;
  const bottom = document.getElementById('bottom')!;
  renderer.setInsets(top.offsetHeight, bottom.offsetHeight);
  newGame();

  const log = (msg: string) => {
    console.log('[harness]', msg);
    status.textContent = msg;
  };
  const bind = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  bind('btn-hint', () => renderer.setHint(game.usePowerUp('hint').hintScrewIds ?? []));
  bind('btn-target', () => {
    targeting = !targeting;
    renderer.setTargetingMode(targeting);
  });
  bind('btn-slot', () => void renderer.playEvents(game.usePowerUp('addSlot').events));
  bind('btn-box', () => void renderer.playEvents(game.usePowerUp('addBox').events));
  bind('btn-recolor', () => void renderer.playEvents(game.usePowerUp('recolor').events));
  bind('btn-restart', () => newGame());
  bind('btn-next', () => {
    levelNo++;
    newGame();
  });

  (window as unknown as { __harness: unknown }).__harness = {
    renderer,
    get game() {
      return game;
    },
    tap: (id: number) => {
      const res = game.tapScrew(id);
      return renderer.playEvents(res.events).then(() => res);
    },
    powerUp: (id: PowerUpId, target?: number) => {
      const res = game.usePowerUp(id, target);
      return renderer.playEvents(res.events).then(() => res);
    },
    snapshot: () => game.snapshot(),
    reachable: () => game.reachableScrewIds(),
    restart: newGame,
  };
}

void main();
