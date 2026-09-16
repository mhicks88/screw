import * as THREE from 'three';
import { HIT_LAYER } from './screwMesh';

export interface InputOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  /** Hit meshes (invisible spheres on HIT_LAYER) to raycast against. */
  hitTargets: () => THREE.Object3D[];
  /** Called on a completed tap (pointer up without a drag > 12 px). */
  onTap: (screwId: number) => void;
  /** Called on pointer down with the screw under the finger (or null) for instant feedback. */
  onPress?: (screwId: number | null) => void;
}

const DRAG_CANCEL_PX = 12;

/**
 * Pointer handling for the canvas. The screw is resolved by raycast on
 * pointerdown (instant feedback), the tap is committed on pointerup unless the
 * pointer moved more than 12 px in between.
 */
export class InputHandler {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private active: { pointerId: number; x: number; y: number; screwId: number | null } | null = null;
  private readonly opts: InputOptions;
  private readonly onDown = (e: PointerEvent) => this.pointerDown(e);
  private readonly onMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onUp = (e: PointerEvent) => this.pointerUp(e);
  private readonly onCancel = (e: PointerEvent) => this.pointerCancel(e);
  private readonly onTouchStart = (e: TouchEvent) => {
    // Block iOS double-tap zoom / long-press callouts.
    if (e.cancelable) e.preventDefault();
  };
  private readonly onContextMenu = (e: Event) => e.preventDefault();
  enabled = true;

  constructor(opts: InputOptions) {
    this.opts = opts;
    this.raycaster.layers.set(HIT_LAYER);
    const c = opts.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onCancel);
    c.addEventListener('touchstart', this.onTouchStart, { passive: false });
    c.addEventListener('touchmove', this.onTouchStart, { passive: false });
    c.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose(): void {
    const c = this.opts.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onCancel);
    c.removeEventListener('touchstart', this.onTouchStart);
    c.removeEventListener('touchmove', this.onTouchStart);
    c.removeEventListener('contextmenu', this.onContextMenu);
    this.active = null;
  }

  /** Screw id under a canvas-relative pixel position, or null. */
  pick(clientX: number, clientY: number): number | null {
    const rect = this.opts.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.opts.camera);
    const hits = this.raycaster.intersectObjects(this.opts.hitTargets(), false);
    if (hits.length === 0) return null;
    // Topmost layer wins; ties resolved by ray distance (closest first).
    let best = hits[0];
    let bestLayer = (best.object.userData.layer as number | undefined) ?? 0;
    for (let i = 1; i < hits.length; i++) {
      const h = hits[i];
      const layer = (h.object.userData.layer as number | undefined) ?? 0;
      if (layer > bestLayer || (layer === bestLayer && h.distance < best.distance)) {
        best = h;
        bestLayer = layer;
      }
    }
    const id = best.object.userData.screwId;
    return typeof id === 'number' ? id : null;
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.active) return; // ignore multi-touch
    const screwId = this.pick(e.clientX, e.clientY);
    this.active = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, screwId };
    try {
      this.opts.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not supported in some test environments */
    }
    this.opts.onPress?.(screwId);
    if (e.cancelable) e.preventDefault();
  }

  private pointerMove(e: PointerEvent): void {
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId || a.screwId === null) return;
    const dx = e.clientX - a.x;
    const dy = e.clientY - a.y;
    if (dx * dx + dy * dy > DRAG_CANCEL_PX * DRAG_CANCEL_PX) {
      a.screwId = null;
      this.opts.onPress?.(null);
    }
  }

  private pointerUp(e: PointerEvent): void {
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId) return;
    this.active = null;
    this.release(e.pointerId);
    if (a.screwId !== null && this.enabled) this.opts.onTap(a.screwId);
    this.opts.onPress?.(null);
  }

  private pointerCancel(e: PointerEvent): void {
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId) return;
    this.active = null;
    this.release(e.pointerId);
    this.opts.onPress?.(null);
  }

  private release(pointerId: number): void {
    try {
      if (this.opts.canvas.hasPointerCapture(pointerId)) this.opts.canvas.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
  }
}
