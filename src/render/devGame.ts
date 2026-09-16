/**
 * Minimal stand-in `Game` for the renderer dev harness.
 *
 * It implements just enough of the v3 rules to drive every GameEvent the
 * renderer animates — including the 3D blocking rule of CONTRACT_V3 §3 (cast
 * the withdrawal ray and see which panels it passes through) — so the renderer
 * can be developed and screenshot-tested while src/core is being rewritten.
 * Nothing here ships in the game bundle; only render-dev.html pulls it in.
 */
import * as THREE from 'three';
import type {
  ActionResult,
  BoxState,
  GameApi,
  GameEvent,
  GameSnapshot,
  LevelDef,
  PanelDef,
  PowerUpId,
  ScrewColor,
  ScrewDef,
  ScrewState,
  Vec2,
} from '../core/types';
import { ASSEMBLY_RADIUS, BOX_CAPACITY } from '../core/types';
import { buildAssemblyLevel } from './devLevels';

/** A small assembly, for eyeballing animations without 160 screws in the way. */
export function buildFakeLevel(): LevelDef {
  return buildAssemblyLevel({
    level: 1,
    seed: 7,
    shells: 2,
    targetScrews: 21,
    colors: 4,
    activeBoxCount: 2,
    traySlots: 5,
  });
}

/* --------------------------- 3D blocking rule --------------------------- */

function pointInPoly(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

interface PanelRay {
  /** Inverse rotation of the panel. */
  inv: THREE.Quaternion;
  origin: THREE.Vector3;
  def: PanelDef;
}

/**
 * CONTRACT_V3 §3: transform the ray into panel-local space, intersect it with
 * the panel's slab (local z = 0 and z = thickness) and run the 2D
 * point-in-polygon test on the entry point.
 */
function rayHitsPanel(p: PanelRay, origin: THREE.Vector3, dir: THREE.Vector3, maxT: number, tmp: THREE.Vector3[]): boolean {
  const o = tmp[0].copy(origin).sub(p.origin).applyQuaternion(p.inv);
  const d = tmp[1].copy(dir).applyQuaternion(p.inv);
  const th = p.def.thickness;
  let t0: number;
  if (Math.abs(d.z) < 1e-6) {
    if (o.z < 0 || o.z > th) return false;
    t0 = 0;
  } else {
    const ta = -o.z / d.z;
    const tb = (th - o.z) / d.z;
    t0 = Math.min(ta, tb);
    const t1 = Math.max(ta, tb);
    if (t1 < 0 || t0 > maxT) return false;
    t0 = Math.max(0, t0);
  }
  const hit = tmp[2].copy(o).addScaledVector(d, t0);
  if (!pointInPoly(hit.x, hit.y, p.def.shape.outline)) return false;
  for (const h of p.def.shape.holes ?? []) if (pointInPoly(hit.x, hit.y, h)) return false;
  return true;
}

export class FakeGame implements GameApi {
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
  private readonly rays: PanelRay[];
  private readonly defs = new Map<number, ScrewDef>();
  private readonly tmp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDir = new THREE.Vector3();

  constructor(level: LevelDef) {
    this.level = level;
    for (const d of level.screws) this.defs.set(d.id, d);
    this.rays = level.panels.map((def) => ({
      def,
      origin: new THREE.Vector3(def.position.x, def.position.y, def.position.z),
      inv: new THREE.Quaternion(def.rotation.x, def.rotation.y, def.rotation.z, def.rotation.w).invert(),
    }));
    this.screws = level.screws.map((s) => ({
      id: s.id, color: s.color, panelId: s.panelId, location: 'plate', revealed: !s.hidden, blocked: false,
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
    const def = this.defs.get(s.id);
    if (!def) return false;
    this.rayDir.set(def.axis.x, def.axis.y, def.axis.z).normalize();
    // Start a hair along the axis so a screw never blocks itself.
    this.rayOrigin.set(def.position.x, def.position.y, def.position.z).addScaledVector(this.rayDir, 0.02);
    const maxT = 2 * ASSEMBLY_RADIUS;
    for (const p of this.rays) {
      if (p.def.id === s.panelId) continue;
      if (this.dropped.has(p.def.id)) continue;
      if (rayHitsPanel(p, this.rayOrigin, this.rayDir, maxT, this.tmp)) return true;
    }
    return false;
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
      panels: this.level.panels.map((p) => ({
        id: p.id,
        dropped: this.dropped.has(p.id),
        remainingScrews: this.screws.filter((s) => s.panelId === p.id && s.location === 'plate').map((s) => s.id),
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
    const remaining = this.screws.filter((o) => o.panelId === s.panelId && o.location === 'plate');
    if (remaining.length === 0 && !this.dropped.has(s.panelId)) {
      this.dropped.add(s.panelId);
      events.push({ type: 'panelDrop', panelId: s.panelId });
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
      const colors: ScrewColor[] = this.level.colors;
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
