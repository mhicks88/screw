import * as THREE from 'three';
import type { GameEvent, GameSnapshot, ScrewDef } from '../core/types';
import { SceneRig } from './scene';
import { TweenManager } from './tween';
import { Effects } from './effects';
import { InputHandler } from './input';
import { EventPlayer } from './events';
import type { World } from './world';
import { boxSlotWorld, trayTargetWorld } from './world';
import { createPlateVisual, disposePlateVisual } from './plateMesh';
import type { ScrewVisual } from './screwMesh';
import { createScrewVisual, disposeScrewCaches, disposeScrewVisual, hintRingMaterial } from './screwMesh';
import { createBoxVisual, disposeBoxCaches, disposeBoxVisual } from './boxMesh';
import { createTrayVisual, disposeTrayCaches, disposeTrayVisual } from './trayMesh';
import { boxPositionsX, plateTopZ } from './layout';

export interface RendererOptions {
  onScrewTap: (screwId: number) => void;
}

/**
 * three.js view of the game. Sees only snapshots (loadLevel) and events
 * (playEvents); never touches the Game itself.
 */
export class GameRenderer {
  private readonly container: HTMLElement;
  private readonly options: RendererOptions;
  private readonly rig: SceneRig;
  private readonly tweens = new TweenManager();
  private readonly effects: Effects;
  private readonly world: World;
  private readonly player: EventPlayer;
  private readonly input: InputHandler;
  private lastFrameMs = 0;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.resize();
  private raf = 0;
  private active = true;
  private disposed = false;
  private hintIds = new Set<number>();
  private targeting = false;
  private pressedId: number | null = null;
  private timeMs = 0;
  /** Debug: animation speed multiplier (0 pauses animations). Not part of the contract. */
  timeScale = 1;

  constructor(container: HTMLElement, options: RendererOptions) {
    this.container = container;
    this.options = options;
    this.rig = new SceneRig(container);
    this.effects = new Effects(this.rig.scene);
    this.world = {
      rig: this.rig,
      tweens: this.tweens,
      effects: this.effects,
      screws: new Map(),
      plates: new Map(),
      boxes: new Map(),
      tray: null,
      traySlots: [],
      boxPositionCount: 0,
      generation: 0,
    };
    this.player = new EventPlayer(this.world);
    this.input = new InputHandler({
      canvas: this.rig.canvas,
      camera: this.rig.camera,
      hitTargets: () => {
        const out: THREE.Object3D[] = [];
        for (const s of this.world.screws.values()) if (s.location === 'plate') out.push(s.hit);
        return out;
      },
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
    for (const p of level.plates) plateLayer.set(p.id, p.layer);
    const droppedPlates = new Set(snapshot.plates.filter((p) => p.dropped).map((p) => p.id));
    for (const p of level.plates) {
      if (droppedPlates.has(p.id)) continue;
      const pv = createPlateVisual(p);
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
      });
      sv.hit.userData.layer = layer;
      if (st.location === 'plate') {
        sv.group.position.set(def.x, def.y, plateTopZ(layer));
      } else if (st.location === 'tray') {
        const slot = st.traySlot ?? Math.max(0, w.traySlots.indexOf(st.id));
        sv.group.position.copy(trayTargetWorld(w, slot));
      } else if (st.location === 'box') {
        const bv = st.boxId !== undefined ? w.boxes.get(st.boxId) : undefined;
        if (!bv) continue;
        const slot = st.boxSlot ?? Math.max(0, bv.screws.indexOf(st.id));
        sv.group.position.copy(boxSlotWorld(bv, slot));
      }
      w.screws.set(sv.id, sv);
      w.rig.boardRoot.add(sv.group);
    }
    this.applyTargeting();
  }

  /** Animate events. Safe to call while earlier events are still animating; resolves when these finish. */
  playEvents(events: GameEvent[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const p = this.player.play(events);
    this.applyTargeting();
    return p;
  }

  /** Highlight these screws (pulsing glow) until cleared. Empty array clears. */
  setHint(screwIds: number[]): void {
    for (const id of this.hintIds) {
      const s = this.world.screws.get(id);
      if (s) s.hintRing.visible = false;
    }
    this.hintIds = new Set(screwIds);
  }

  /** Toggle "drill targeting" mode: all on-plate screws (even blocked) show an outline. */
  setTargetingMode(on: boolean): void {
    this.targeting = on;
    this.applyTargeting();
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
    w.screws.clear();
    w.plates.clear();
    w.boxes.clear();
    w.tray = null;
    w.traySlots = [];
    w.boxPositionCount = 0;
    w.rig.boardRoot.clear();
    this.hintIds.clear();
    this.pressedId = null;
  }

  private applyTargeting(): void {
    for (const s of this.world.screws.values()) {
      s.targetRing.visible = this.targeting && s.location === 'plate';
    }
  }

  private setPressed(id: number | null): void {
    if (this.pressedId !== null && this.pressedId !== id) {
      const prev = this.world.screws.get(this.pressedId);
      if (prev && prev.location === 'plate') prev.group.scale.setScalar(1);
    }
    this.pressedId = id;
    if (id !== null) {
      const s = this.world.screws.get(id);
      if (s && s.location === 'plate') s.group.scale.setScalar(0.92);
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
    this.updateHint();
    if (this.active) this.rig.render();
  };

  private updateHint(): void {
    if (this.hintIds.size === 0) return;
    const t = this.timeMs / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 7);
    hintRingMaterial().opacity = 0.45 + 0.5 * pulse;
    const k = 1 + 0.12 * pulse;
    for (const id of this.hintIds) {
      const s: ScrewVisual | undefined = this.world.screws.get(id);
      if (!s) continue;
      const show = s.location === 'plate';
      s.hintRing.visible = show;
      if (show) s.hintRing.scale.setScalar(k);
    }
  }
}
