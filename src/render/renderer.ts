import * as THREE from 'three';
import type { GameEvent, GameSnapshot, PlateDef, ScrewDef } from '../core/types';
import { plateContainsWorldPoint } from '../core/geometry';
import { SceneRig } from './scene';
import { TweenManager } from './tween';
import { Effects } from './effects';
import { InputHandler } from './input';
import { EventPlayer } from './events';
import type { World } from './world';
import { boxSlotWorld, trayTargetWorld } from './world';
import { createPlateVisual, disposePlateVisual, plateColorFor } from './plateMesh';
import { ScrewField } from './screwField';
import { createScrewVisual, disposeScrewCaches, disposeScrewVisual } from './screwMesh';
import { createBoxVisual, disposeBoxCaches, disposeBoxVisual } from './boxMesh';
import { createTrayVisual, disposeTrayCaches, disposeTrayVisual } from './trayMesh';
import { boxPositionsX, plateTopZ } from './layout';

export interface RendererOptions {
  onScrewTap: (screwId: number) => void;
}

/**
 * three.js view of the game. Sees only snapshots (loadLevel) and events
 * (playEvents); never touches the Game itself.
 *
 * v2 scale: up to 150 screws across ~40 thin plates on 15 layers. Screws that a
 * higher plate covers are not drawn (their heads would poke through the 0.02
 * unit air gap) and are not raycast; everything still seated on a plate is
 * drawn from one InstancedMesh.
 */
export class GameRenderer {
  private readonly container: HTMLElement;
  private readonly options: RendererOptions;
  /** Debug handle for the dev harness; not part of the contract. */
  readonly rig: SceneRig;
  private readonly tweens = new TweenManager();
  private readonly effects: Effects;
  private readonly field: ScrewField;
  private readonly world: World;
  private readonly player: EventPlayer;
  private readonly input: InputHandler;
  private lastFrameMs = 0;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.resize();
  private raf = 0;
  private active = true;
  private disposed = false;
  private targeting = false;
  private pressedId: number | null = null;
  private timeMs = 0;
  private plateDefs: PlateDef[] = [];
  /** Layer the depth tint is currently anchored to (tweened, so it can be fractional). */
  private displayMaxLayer = 0;
  private tintTween: { cancel(complete?: boolean): void } | null = null;
  /** Debug: animation speed multiplier (0 pauses animations). Not part of the contract. */
  timeScale = 1;

  constructor(container: HTMLElement, options: RendererOptions) {
    this.container = container;
    this.options = options;
    this.rig = new SceneRig(container);
    this.effects = new Effects(this.rig.scene);
    this.field = new ScrewField(this.rig.boardRoot);
    this.world = {
      rig: this.rig,
      tweens: this.tweens,
      effects: this.effects,
      field: this.field,
      screws: new Map(),
      plates: new Map(),
      boxes: new Map(),
      tray: null,
      traySlots: [],
      boxPositionCount: 0,
      maxLayer: 0,
      generation: 0,
      recomputeCover: () => this.recomputeCover(),
    };
    this.player = new EventPlayer(this.world);
    this.input = new InputHandler({
      canvas: this.rig.canvas,
      camera: this.rig.camera,
      hitTargets: () => this.field.hitTargets(),
      onTap: (id) => this.options.onScrewTap(id),
      onPress: (id) => this.setPressed(id),
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('orientationchange', this.onWindowResize);
    this.resize();
    this.loop();
  }

  /** Build the whole scene from a snapshot (level start / restart). Clears any previous level. */
  loadLevel(snapshot: GameSnapshot): void {
    const w = this.world;
    this.clearLevel();
    const level = snapshot.level;

    const plateLayer = new Map<number, number>();
    let maxLayer = 0;
    for (const p of level.plates) {
      plateLayer.set(p.id, p.layer);
      if (p.layer > maxLayer) maxLayer = p.layer;
    }
    w.maxLayer = maxLayer;
    this.displayMaxLayer = maxLayer;
    this.plateDefs = level.plates;

    const droppedPlates = new Set(snapshot.plates.filter((p) => p.dropped).map((p) => p.id));
    for (const p of level.plates) {
      if (droppedPlates.has(p.id)) continue;
      const pv = createPlateVisual(p, maxLayer);
      w.plates.set(pv.id, pv);
      w.rig.boardRoot.add(pv.mesh);
    }

    // Boxes and their positions.
    let positions = level.activeBoxCount;
    for (const b of snapshot.boxes) positions = Math.max(positions, b.position + 1);
    w.boxPositionCount = Math.max(1, positions);
    const xs = boxPositionsX(w.boxPositionCount);
    for (const b of snapshot.boxes) {
      if (b.completed) continue;
      const bv = createBoxVisual(b, xs[Math.min(b.position, xs.length - 1)] ?? 0);
      w.boxes.set(bv.id, bv);
      w.rig.boardRoot.add(bv.group);
    }

    // Tray.
    w.traySlots = [...snapshot.tray];
    w.tray = createTrayVisual(Math.max(1, snapshot.tray.length));
    w.rig.boardRoot.add(w.tray.group);

    // Screws.
    const defs = new Map<number, ScrewDef>();
    for (const d of level.screws) defs.set(d.id, d);
    const blocked = new Map<number, boolean>();
    for (const st of snapshot.screws) {
      const def = defs.get(st.id);
      if (!def || st.location === 'gone') continue;
      const layer = plateLayer.get(st.plateId) ?? 0;
      const sv = createScrewVisual({
        id: st.id,
        plateId: st.plateId,
        color: st.color,
        revealed: st.revealed || !def.hidden,
        location: st.location,
        layer,
        x: def.x,
        y: def.y,
        z: plateTopZ(layer),
      });
      blocked.set(sv.id, st.blocked && st.location === 'plate');
      w.screws.set(sv.id, sv);
    }

    this.field.build(w.screws.values(), maxLayer);

    // Park the screws that are not on a plate; they always own real meshes.
    for (const st of snapshot.screws) {
      const sv = w.screws.get(st.id);
      if (!sv) continue;
      if (st.location === 'tray') {
        const slot = st.traySlot ?? Math.max(0, w.traySlots.indexOf(st.id));
        sv.pos.copy(trayTargetWorld(w, slot));
      } else if (st.location === 'box') {
        const bv = st.boxId !== undefined ? w.boxes.get(st.boxId) : undefined;
        if (!bv) continue;
        const slot = st.boxSlot ?? Math.max(0, bv.screws.indexOf(st.id));
        sv.pos.copy(boxSlotWorld(bv, slot));
      } else {
        continue;
      }
      this.field.detach(sv);
    }

    this.recomputeCover(blocked);
    this.field.setTargeting(this.targeting);
  }

  /** Animate events. Safe to call while earlier events are still animating; resolves when these finish. */
  playEvents(events: GameEvent[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.player.play(events);
  }

  /** Highlight these screws (pulsing glow) until cleared. Empty array clears. */
  setHint(screwIds: number[]): void {
    this.field.setHint(screwIds);
  }

  /** Toggle "drill targeting" mode: on-plate screws show a crosshair/outline. */
  setTargetingMode(on: boolean): void {
    this.targeting = on;
    this.field.setTargeting(on);
  }

  /** Pixels reserved by HTML overlays; the camera frames the board between them. */
  setInsets(topPx: number, bottomPx: number): void {
    this.rig.setInsets(topPx, bottomPx);
  }

  /** Pause/resume rendering (menus). Animations keep advancing so promises resolve. */
  setActive(active: boolean): void {
    this.active = active;
    this.input.enabled = active;
    if (active && !this.raf && !this.disposed) this.loop();
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.rig.resize(w, h);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('orientationchange', this.onWindowResize);
    this.input.dispose();
    this.clearLevel();
    this.field.dispose();
    this.effects.dispose();
    disposeScrewCaches();
    disposeBoxCaches();
    disposeTrayCaches();
    this.rig.dispose();
  }

  /* ------------------------------------------------------------------ */

  private clearLevel(): void {
    const w = this.world;
    w.generation++;
    this.tweens.cancelAll(false);
    this.effects.clear();
    this.player.reset();
    for (const s of w.screws.values()) disposeScrewVisual(s);
    for (const p of w.plates.values()) disposePlateVisual(p);
    for (const b of w.boxes.values()) disposeBoxVisual(b);
    if (w.tray) disposeTrayVisual(w.tray);
    this.field.clear();
    w.screws.clear();
    w.plates.clear();
    w.boxes.clear();
    w.tray = null;
    w.traySlots = [];
    w.boxPositionCount = 0;
    w.maxLayer = 0;
    w.rig.boardRoot.clear();
    this.plateDefs = [];
    this.displayMaxLayer = 0;
    this.tintTween?.cancel();
    this.tintTween = null;
    this.pressedId = null;
  }

  /**
   * How many live plates on a higher layer cover each on-plate screw.
   *
   * 0 → drawn and tappable. 1 → hidden, but drillable as an x-ray ghost in
   * targeting mode (it is the next thing the player will uncover). 2+ → not
   * drawn at all. Only the 0/1/2+ distinction matters, so the scan stops at 2;
   * it runs on load and after each plate actually leaves the board.
   *
   * `override` (from a snapshot's `blocked` flags) wins where it disagrees,
   * because the core is authoritative about reachability.
   */
  private recomputeCover(override?: Map<number, boolean>): void {
    const w = this.world;
    const live: PlateDef[] = [];
    for (const p of this.plateDefs) {
      const pv = w.plates.get(p.id);
      if (pv && !pv.dropped) live.push(p);
    }
    for (const s of w.screws.values()) {
      if (s.location !== 'plate') continue;
      let c = 0;
      for (const p of live) {
        if (p.layer <= s.layer) continue;
        if (plateContainsWorldPoint(p, s.home.x, s.home.y)) {
          c++;
          if (c >= 2) break;
        }
      }
      const forced = override?.get(s.id);
      if (forced === false) c = 0;
      else if (forced === true && c === 0) c = 1;
      s.coverCount = c;
    }
    this.field.markDirty();
    this.retargetDepthTint(live);
  }

  /**
   * Keep the depth ramp anchored to the *highest surviving* layer.
   *
   * Without this the whole board keeps fading as the player peels it: a level
   * whose tallest tower reached layer 14 would still tint its remaining layer-5
   * top plate as if nine layers sat above it. The anchor follows the live top
   * over ~400 ms so it reads as the stack settling, not as a colour pop.
   */
  private retargetDepthTint(live: PlateDef[]): void {
    let top = 0;
    for (const p of live) if (p.layer > top) top = p.layer;
    if (live.length === 0 || Math.abs(top - this.displayMaxLayer) < 0.01) return;
    this.world.maxLayer = top;
    const from = this.displayMaxLayer;
    this.tintTween?.cancel();
    this.tintTween = this.tweens.add({
      duration: 400,
      onUpdate: (e) => {
        this.displayMaxLayer = from + (top - from) * e;
        this.applyDepthTint();
      },
      onComplete: () => {
        this.displayMaxLayer = top;
        this.applyDepthTint();
        this.tintTween = null;
      },
    });
  }

  private applyDepthTint(): void {
    const m = this.displayMaxLayer;
    for (const def of this.plateDefs) {
      const pv = this.world.plates.get(def.id);
      if (pv && !pv.dropped) pv.mesh.material.color.copy(plateColorFor(def, m));
    }
    this.field.setMaxLayer(m);
  }

  private setPressed(id: number | null): void {
    if (this.pressedId !== null && this.pressedId !== id) {
      const prev = this.world.screws.get(this.pressedId);
      if (prev && prev.location === 'plate') {
        prev.scale = 1;
        this.field.setPose(prev);
      }
    }
    this.pressedId = id;
    if (id !== null) {
      const s = this.world.screws.get(id);
      if (s && s.location === 'plate') {
        s.scale = 0.92;
        this.field.setPose(s);
      }
    }
  }

  private loop = (): void => {
    if (this.disposed) {
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = (this.lastFrameMs ? Math.min(100, now - this.lastFrameMs) : 16) * this.timeScale;
    this.lastFrameMs = now;
    this.timeMs += dt;
    this.tweens.update(dt);
    this.effects.update(dt);
    this.field.flush();
    this.field.updateHint(this.timeMs);
    if (this.active) this.rig.render();
  };
}
