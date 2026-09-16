/**
 * Authoritative game rules. See types.ts for the rules summary and CONTRACT.md
 * for the event-ordering guarantees.
 *
 * Queue bookkeeping (important for addBox / recolor):
 *   The level's boxQueue is copied into the Game and becomes mutable state.
 *   Every box that ever fills consumes exactly BOX_CAPACITY screws of its
 *   colour, and the queue was built so that the count of each colour equals
 *   BOX_CAPACITY * (number of queue entries of that colour). An extra box
 *   (addBox) of colour C therefore steals the screws of a future queued C box,
 *   so we remove one future occurrence of C from the queue. A recolor of an
 *   empty box from A to B puts A back at the FRONT of the remaining queue (the
 *   player is not punished by having A pushed to the end) and removes one future
 *   occurrence of B. Colours with no future occurrence are not eligible, so the
 *   invariant "every screw has a box" always holds. `snapshot().level.boxQueue`
 *   reflects the current (possibly modified) queue and `nextBoxIndex` indexes it.
 *
 * Bonus box positions: addBox spawns at the first free position >= activeBoxCount.
 * When a box in a bonus position completes, nothing spawns there (the position
 * disappears until addBox is used again).
 */
import {
  BOX_CAPACITY, MAX_ACTIVE_BOXES, MAX_BONUS_SLOTS,
  type ActionResult, type BoxState, type GameApi, type GameEvent, type GameSnapshot, type GameStatus,
  type LevelDef, type PanelState, type PowerUpId, type ScrewColor, type ScrewState,
} from './types';
import { computeBlockers } from './blocking';
import { colorNeeds, rankByNeed } from './colorChoice';
import { solveNextMoves } from './solver';

export interface GameOptions {
  /**
   * Lazy queue: called whenever a box must spawn but the queue is exhausted and
   * unassigned screws remain. The returned colour is appended to the queue.
   * Used by the generator; normal play never needs it.
   */
  boxColorProvider?: (game: Game) => ScrewColor | undefined;
}

interface Screw extends ScrewState { hidden: boolean }

function cloneLevel(level: LevelDef, queue: ScrewColor[]): LevelDef {
  return {
    ...level,
    panels: level.panels.map((p) => ({
      ...p,
      position: { ...p.position },
      rotation: { ...p.rotation },
      shape: {
        kind: p.shape.kind,
        outline: p.shape.outline.map((v) => ({ x: v.x, y: v.y })),
        ...(p.shape.holes ? { holes: p.shape.holes.map((h) => h.map((v) => ({ x: v.x, y: v.y }))) } : {}),
      },
    })),
    screws: level.screws.map((s) => ({ ...s, position: { ...s.position }, axis: { ...s.axis } })),
    boxQueue: [...queue],
    colors: [...level.colors],
  };
}

export class Game implements GameApi {
  readonly level: LevelDef;
  private readonly opts: GameOptions;
  private st: GameStatus = 'playing';
  private screws: Screw[] = [];
  private screwIdx = new Map<number, number>();
  private panels: PanelState[] = [];
  private panelIdx = new Map<number, number>();
  /**
   * Per screw index: the indices of the panels its withdrawal ray passes
   * through (CONTRACT_V3 §3). Static — panels never move, they only drop — so
   * the rays are cast once here and every later "is this blocked?" is a
   * handful of dropped-flag lookups.
   */
  private blockers: number[][] = [];
  private boxes: BoxState[] = [];
  private nextBoxId = 0;
  private queue: ScrewColor[];
  private nextQ = 0;
  private tray: (number | null)[] = [];
  /** Arrival stamp per tray slot (for "oldest first"). */
  private trayStamp: number[] = [];
  private stamp = 0;
  private bonus = 0;
  private movesCount = 0;

  constructor(level: LevelDef, opts: GameOptions = {}, init?: Game | GameSnapshot) {
    this.level = level;
    this.opts = opts;
    this.queue = [...level.boxQueue];
    if (init instanceof Game) {
      this.copyFrom(init);
      return;
    }
    this.buildStatic(level);
    if (init) {
      this.loadSnapshot(init);
      return;
    }
    this.tray = new Array(level.traySlots).fill(null);
    this.trayStamp = new Array(level.traySlots).fill(0);
    for (let p = 0; p < level.activeBoxCount; p++) this.spawnBoxAt(p, []);
  }

  /** Rebuild a Game from a snapshot (used by the solver; tray age order is approximated by slot index). */
  static fromSnapshot(snap: GameSnapshot, opts: GameOptions = {}): Game {
    return new Game(snap.level, opts, snap);
  }

  /** Cheap deep copy of the runtime state (shares the immutable level). */
  clone(): Game {
    return new Game(this.level, this.opts, this);
  }

  /* ------------------------------------------------------------ setup */

  private buildStatic(level: LevelDef): void {
    this.panels = level.panels.map((p) => ({ id: p.id, dropped: false, remainingScrews: [] }));
    level.panels.forEach((p, i) => this.panelIdx.set(p.id, i));
    this.screws = level.screws.map((s) => ({
      id: s.id, color: s.color, panelId: s.panelId, location: 'plate', revealed: !s.hidden, blocked: false, hidden: s.hidden,
    }));
    level.screws.forEach((s, i) => {
      this.screwIdx.set(s.id, i);
      this.panels[this.panelIdx.get(s.panelId)!].remainingScrews.push(s.id);
    });
    this.blockers = computeBlockers(level.panels, level.screws);
    for (const s of this.screws) {
      s.blocked = this.isBlockedIdx(this.screwIdx.get(s.id)!);
      if (!s.blocked) s.revealed = true;
    }
  }

  private copyFrom(g: Game): void {
    this.st = g.st;
    this.screws = g.screws.map((s) => ({ ...s }));
    this.screwIdx = g.screwIdx;
    this.panels = g.panels.map((p) => ({ ...p, remainingScrews: [...p.remainingScrews] }));
    this.panelIdx = g.panelIdx;
    this.blockers = g.blockers;
    this.boxes = g.boxes.map((b) => ({ ...b, screws: [...b.screws] }));
    this.nextBoxId = g.nextBoxId;
    this.queue = [...g.queue];
    this.nextQ = g.nextQ;
    this.tray = [...g.tray];
    this.trayStamp = [...g.trayStamp];
    this.stamp = g.stamp;
    this.bonus = g.bonus;
    this.movesCount = g.movesCount;
  }

  private loadSnapshot(snap: GameSnapshot): void {
    this.st = snap.status;
    for (const ss of snap.screws) {
      const s = this.screws[this.screwIdx.get(ss.id)!];
      Object.assign(s, ss);
    }
    for (const ps of snap.panels) {
      const p = this.panels[this.panelIdx.get(ps.id)!];
      p.dropped = ps.dropped;
      p.remainingScrews = [...ps.remainingScrews];
    }
    this.boxes = snap.boxes.map((b) => ({ ...b, screws: [...b.screws] })).sort((a, b) => a.position - b.position);
    this.nextBoxId = this.boxes.reduce((m, b) => Math.max(m, b.id + 1), 0);
    this.queue = [...snap.level.boxQueue];
    this.nextQ = snap.nextBoxIndex;
    this.tray = [...snap.tray];
    this.trayStamp = this.tray.map((_, i) => i + 1);
    this.stamp = this.tray.length + 1;
    this.bonus = snap.bonusSlots;
    this.movesCount = snap.moves;
  }

  /* ------------------------------------------------------- read access */

  snapshot(): GameSnapshot {
    for (const s of this.screws) s.blocked = s.location === 'plate' && this.isBlockedIdx(this.screwIdx.get(s.id)!);
    return {
      level: cloneLevel(this.level, this.queue),
      status: this.st,
      screws: this.screws.map(({ hidden: _h, ...s }) => ({ ...s })),
      panels: this.panels.map((p) => ({ ...p, remainingScrews: [...p.remainingScrews] })),
      boxes: this.boxes.map((b) => ({ ...b, screws: [...b.screws] })),
      nextBoxIndex: this.nextQ,
      tray: [...this.tray],
      bonusSlots: this.bonus,
      moves: this.movesCount,
      totalScrews: this.screws.length,
      removedScrews: this.screws.reduce((n, s) => n + (s.location === 'box' || s.location === 'gone' ? 1 : 0), 0),
    };
  }

  reachableScrewIds(): number[] {
    const out: number[] = [];
    this.screws.forEach((s, i) => {
      if (s.location === 'plate' && !this.isBlockedIdx(i)) out.push(s.id);
    });
    return out;
  }

  getStatus(): GameStatus { return this.st; }
  get moves(): number { return this.movesCount; }
  get nextBoxIndex(): number { return this.nextQ; }
  isBlocked(screwId: number): boolean {
    const i = this.screwIdx.get(screwId);
    return i !== undefined && this.screws[i].location === 'plate' && this.isBlockedIdx(i);
  }
  /** Read-only live views (do NOT mutate). `blocked` is refreshed on each call. */
  peekScrews(): readonly Readonly<ScrewState>[] {
    this.screws.forEach((s, i) => { s.blocked = s.location === 'plate' && this.isBlockedIdx(i); });
    return this.screws;
  }
  peekBoxes(): readonly Readonly<BoxState>[] { return this.boxes; }
  peekTray(): readonly (number | null)[] { return this.tray; }
  peekPanels(): readonly Readonly<PanelState>[] { return this.panels; }
  /** Current (possibly modified) box queue. */
  peekQueue(): readonly ScrewColor[] { return this.queue; }
  /** Static map panelId → ids of the screws this panel currently stands in the way of. */
  coverageMap(): Map<number, number[]> {
    const m = new Map<number, number[]>();
    this.blockers.forEach((cov, i) => {
      for (const pi of cov) {
        const pid = this.panels[pi].id;
        if (!m.has(pid)) m.set(pid, []);
        m.get(pid)!.push(this.screws[i].id);
      }
    });
    return m;
  }

  /**
   * CONTRACT_V3 §3: the screw's withdrawal ray is obstructed while any panel it
   * passes through is still in place. O(blockers), which is 0-4 in practice.
   */
  private isBlockedIdx(i: number): boolean {
    for (const pi of this.blockers[i]) if (!this.panels[pi].dropped) return true;
    return false;
  }

  /* ------------------------------------------------------------ actions */

  tapScrew(screwId: number): ActionResult {
    if (this.st !== 'playing') return { ok: false, reason: 'notPlaying', events: [] };
    const i = this.screwIdx.get(screwId);
    if (i === undefined) return { ok: false, reason: 'noSuchScrew', events: [] };
    const s = this.screws[i];
    if (s.location !== 'plate') return { ok: false, reason: 'notOnPlate', events: [] };
    if (this.isBlockedIdx(i)) return { ok: false, reason: 'blocked', events: [{ type: 'blockedTap', screwId }] };
    return this.removeScrew(s, true);
  }

  continueAfterLose(): ActionResult {
    if (this.st !== 'lost') return { ok: false, reason: 'notPlaying', events: [] };
    this.st = 'playing';
    return { ok: true, events: [this.addTraySlot()] };
  }

  usePowerUp(id: PowerUpId, targetScrewId?: number): ActionResult {
    if (this.st !== 'playing') return { ok: false, reason: 'notPlaying', events: [] };
    switch (id) {
      case 'drill': return this.drill(targetScrewId);
      case 'addSlot': return this.addSlot();
      case 'addBox': return this.addBox();
      case 'recolor': return this.recolor();
      case 'magnet': return this.magnet();
      case 'hint': {
        const ids = solveNextMoves(this.snapshot(), 3);
        return ids.length ? { ok: true, events: [], hintScrewIds: ids } : { ok: false, reason: 'nothingToDo', events: [], hintScrewIds: [] };
      }
    }
  }

  /* --------------------------------------------------------- power-ups */

  private drill(targetScrewId?: number): ActionResult {
    if (targetScrewId === undefined) return { ok: false, reason: 'noSuchScrew', events: [] };
    const i = this.screwIdx.get(targetScrewId);
    if (i === undefined) return { ok: false, reason: 'noSuchScrew', events: [] };
    const s = this.screws[i];
    if (s.location !== 'plate') return { ok: false, reason: 'notOnPlate', events: [] };
    // Drilling never loses the game: refuse quietly when there is no room.
    if (!this.findBoxWithRoom(s.color) && this.firstFreeTraySlot() < 0) return { ok: false, reason: 'trayFull', events: [] };
    return this.removeScrew(s, false);
  }

  private addSlot(): ActionResult {
    if (this.bonus >= MAX_BONUS_SLOTS) return { ok: false, reason: 'maxSlots', events: [] };
    return { ok: true, events: [this.addTraySlot()] };
  }

  private addTraySlot(): GameEvent {
    this.bonus++;
    this.tray.push(null);
    this.trayStamp.push(0);
    return { type: 'traySlotAdded', slotIndex: this.tray.length - 1 };
  }

  private addBox(): ActionResult {
    if (this.boxes.length >= MAX_ACTIVE_BOXES) return { ok: false, reason: 'maxBoxes', events: [] };
    const future = new Set(this.queue.slice(this.nextQ));
    if (future.size === 0) return { ok: false, reason: 'nothingToDo', events: [] };
    const active = new Set(this.boxes.map((b) => b.color));
    const needs = colorNeeds(this);
    let candidates = [...future].filter((c) => !active.has(c));
    if (candidates.length === 0) candidates = [...future];
    const color = rankByNeed(needs, candidates)[0];
    this.consumeFutureColor(color);
    let position = this.level.activeBoxCount;
    while (this.boxes.some((b) => b.position === position)) position++;
    const events: GameEvent[] = [];
    this.spawnBox(color, position, events);
    this.checkWin(events);
    return { ok: true, events };
  }

  private recolor(): ActionResult {
    const empty = this.boxes.filter((b) => b.screws.length === 0);
    if (empty.length === 0) return { ok: false, reason: 'noEmptyBox', events: [] };
    const needs = colorNeeds(this);
    const active = new Set(this.boxes.map((b) => b.color));
    // Target: the empty box whose colour currently helps least.
    const usefulness = (c: ScrewColor) => needs.get(c)!.tray * 100 + needs.get(c)!.reachable;
    empty.sort((a, b) => usefulness(a.color) - usefulness(b.color) || a.position - b.position);
    const box = empty[0];
    const future = new Set(this.queue.slice(this.nextQ));
    let candidates = [...future].filter((c) => !active.has(c));
    if (candidates.length === 0) candidates = [...future].filter((c) => c !== box.color);
    if (candidates.length === 0) return { ok: false, reason: 'nothingToDo', events: [] };
    const color = rankByNeed(needs, candidates)[0];
    // Old colour returns to the FRONT of the remaining queue, new colour is consumed.
    this.queue.splice(this.nextQ, 0, box.color);
    this.consumeFutureColor(color);
    box.color = color;
    const events: GameEvent[] = [{ type: 'boxRecolored', boxId: box.id, color }];
    this.fillFromTray(box, events);
    this.checkWin(events);
    return { ok: true, events };
  }

  private consumeFutureColor(color: ScrewColor): void {
    const idx = this.queue.indexOf(color, this.nextQ);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  private magnet(): ActionResult {
    const events: GameEvent[] = [];
    let count = 0;
    while (this.st === 'playing') {
      let best: Screw | undefined;
      let bestFill = -1;
      this.screws.forEach((s, i) => {
        if (s.location !== 'plate' || this.isBlockedIdx(i)) return;
        const box = this.findBoxWithRoom(s.color);
        if (box && box.screws.length > bestFill) { best = s; bestFill = box.screws.length; }
      });
      if (!best) break;
      const r = this.removeScrew(best, true);
      events.push(...r.events);
      count++;
    }
    if (count === 0) return { ok: false, reason: 'nothingToDo', events: [] };
    return { ok: true, events };
  }

  /* -------------------------------------------------------- rules core */

  private findBoxWithRoom(color: ScrewColor): BoxState | undefined {
    let best: BoxState | undefined;
    for (const b of this.boxes) {
      if (b.color === color && b.screws.length < BOX_CAPACITY && (!best || b.screws.length > best.screws.length)) best = b;
    }
    return best;
  }

  private firstFreeTraySlot(): number {
    return this.tray.indexOf(null);
  }

  /** Removes a screw from its panel (already validated as on-panel). */
  private removeScrew(s: Screw, loseOnFull: boolean): ActionResult {
    const events: GameEvent[] = [];
    const box = this.findBoxWithRoom(s.color);
    let slot = -1;
    if (!box) {
      slot = this.firstFreeTraySlot();
      if (slot < 0) {
        if (!loseOnFull) return { ok: false, reason: 'trayFull', events: [] };
        this.st = 'lost';
        return { ok: false, reason: 'trayFull', events: [{ type: 'lose', reason: 'trayFull' }] };
      }
    }
    this.movesCount++;
    if (!s.revealed) {
      s.revealed = true;
      events.push({ type: 'screwRevealed', screwId: s.id, color: s.color });
    }
    const panel = this.panels[this.panelIdx.get(s.panelId)!];
    panel.remainingScrews.splice(panel.remainingScrews.indexOf(s.id), 1);
    if (box) {
      this.placeInBox(s, box, 'plate', events);
    } else {
      s.location = 'tray';
      s.traySlot = slot;
      this.tray[slot] = s.id;
      this.trayStamp[slot] = ++this.stamp;
      events.push({ type: 'screwToTray', screwId: s.id, traySlot: slot });
    }
    if (panel.remainingScrews.length === 0 && !panel.dropped) this.dropPanel(panel, events);
    this.checkWin(events);
    return { ok: true, events };
  }

  private placeInBox(s: Screw, box: BoxState, from: 'plate' | 'tray', events: GameEvent[]): void {
    if (from === 'tray' && s.traySlot !== undefined) {
      this.tray[s.traySlot] = null;
      this.trayStamp[s.traySlot] = 0;
    }
    s.traySlot = undefined;
    s.location = 'box';
    s.boxId = box.id;
    s.boxSlot = box.screws.length;
    box.screws.push(s.id);
    events.push({ type: 'screwToBox', screwId: s.id, boxId: box.id, boxSlot: s.boxSlot, from });
    if (box.screws.length >= BOX_CAPACITY) this.completeBox(box, events);
  }

  private completeBox(box: BoxState, events: GameEvent[]): void {
    box.completed = true;
    for (const id of box.screws) this.screws[this.screwIdx.get(id)!].location = 'gone';
    this.boxes.splice(this.boxes.indexOf(box), 1);
    events.push({ type: 'boxComplete', boxId: box.id, position: box.position });
    if (box.position < this.level.activeBoxCount) this.spawnBoxAt(box.position, events);
  }

  private nextQueueColor(): ScrewColor | undefined {
    if (this.nextQ < this.queue.length) return this.queue[this.nextQ++];
    if (this.opts.boxColorProvider) {
      const c = this.opts.boxColorProvider(this);
      if (c) {
        this.queue.push(c);
        this.nextQ++;
        return c;
      }
    }
    return undefined;
  }

  private spawnBoxAt(position: number, events: GameEvent[]): void {
    const color = this.nextQueueColor();
    if (color) this.spawnBox(color, position, events);
  }

  private spawnBox(color: ScrewColor, position: number, events: GameEvent[]): void {
    const box: BoxState = { id: this.nextBoxId++, color, screws: [], position, completed: false };
    this.boxes.push(box);
    this.boxes.sort((a, b) => a.position - b.position);
    events.push({ type: 'boxSpawn', box: { ...box, screws: [] } });
    this.fillFromTray(box, events);
  }

  /** Move matching tray screws (oldest first) into the box; chains through completion/spawn. */
  private fillFromTray(box: BoxState, events: GameEvent[]): void {
    while (!box.completed && box.screws.length < BOX_CAPACITY) {
      let bestSlot = -1;
      for (let i = 0; i < this.tray.length; i++) {
        const id = this.tray[i];
        if (id === null) continue;
        if (this.screws[this.screwIdx.get(id)!].color !== box.color) continue;
        if (bestSlot < 0 || this.trayStamp[i] < this.trayStamp[bestSlot]) bestSlot = i;
      }
      if (bestSlot < 0) return;
      this.placeInBox(this.screws[this.screwIdx.get(this.tray[bestSlot]!)!], box, 'tray', events);
    }
  }

  private dropPanel(panel: PanelState, events: GameEvent[]): void {
    panel.dropped = true;
    events.push({ type: 'panelDrop', panelId: panel.id });
    const pi = this.panelIdx.get(panel.id)!;
    const unblocked: Screw[] = [];
    this.screws.forEach((s, i) => {
      if (s.location === 'plate' && this.blockers[i].includes(pi) && !this.isBlockedIdx(i)) unblocked.push(s);
    });
    if (unblocked.length === 0) return;
    events.push({ type: 'screwsUnblocked', screwIds: unblocked.map((s) => s.id) });
    for (const s of unblocked) {
      if (!s.revealed) {
        s.revealed = true;
        events.push({ type: 'screwRevealed', screwId: s.id, color: s.color });
      }
    }
  }

  private checkWin(events: GameEvent[]): void {
    if (this.st !== 'playing') return;
    if (this.screws.every((s) => s.location === 'gone')) {
      this.st = 'won';
      events.push({ type: 'win' });
    }
  }
}
