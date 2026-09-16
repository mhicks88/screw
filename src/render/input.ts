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
  /** The gesture turned into a rotation (the 12 px threshold was crossed). */
  onDragStart?: () => void;
  /** Incremental pointer movement in CSS px while rotating. */
  onDrag?: (dx: number, dy: number, dtMs: number) => void;
  onDragEnd?: () => void;
}

const DRAG_CANCEL_PX = 12;

/**
 * Pointer handling for the canvas.
 *
 * One finger does both jobs (CONTRACT_V3 §5): the screw under the finger is
 * resolved on pointerdown for instant feedback, and the gesture commits as a
 * TAP on pointerup — unless the pointer travelled more than 12 px first, in
 * which case it becomes a ROTATE and keeps feeding deltas to the orbit
 * controller until release. The threshold is the same 12 px v2 already used to
 * cancel a tap, so nothing about the feel of tapping changes.
 *
 * A drag anywhere rotates, including one that started on a screw: the player
 * should never have to hunt for empty background to turn the object.
 */
export class InputHandler {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private active: {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    lastMs: number;
    screwId: number | null;
    dragging: boolean;
  } | null = null;
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
    // Nearest to the camera wins: on a solid, the screw in front is the one the
    // player can see and therefore the one they meant.
    let best = hits[0];
    for (let i = 1; i < hits.length; i++) if (hits[i].distance < best.distance) best = hits[i];
    const id = best.object.userData.screwId;
    return typeof id === 'number' ? id : null;
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.active) return; // ignore multi-touch: one finger rotates
    const screwId = this.pick(e.clientX, e.clientY);
    this.active = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      lastMs: e.timeStamp || performance.now(),
      screwId,
      dragging: false,
    };
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
    if (!a || a.pointerId !== e.pointerId || !this.enabled) return;
    const now = e.timeStamp || performance.now();
    if (!a.dragging) {
      const dx = e.clientX - a.startX;
      const dy = e.clientY - a.startY;
      if (dx * dx + dy * dy <= DRAG_CANCEL_PX * DRAG_CANCEL_PX) return;
      // Crossed the threshold: this is a rotation, not a tap.
      a.dragging = true;
      a.screwId = null;
      this.opts.onPress?.(null);
      this.opts.onDragStart?.();
      // Hand over the whole movement so far, so the object does not jump.
      this.opts.onDrag?.(dx, dy, Math.max(1, now - a.lastMs));
    } else {
      this.opts.onDrag?.(e.clientX - a.lastX, e.clientY - a.lastY, Math.max(1, now - a.lastMs));
    }
    a.lastX = e.clientX;
    a.lastY = e.clientY;
    a.lastMs = now;
  }

  private pointerUp(e: PointerEvent): void {
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId) return;
    this.active = null;
    this.release(e.pointerId);
    if (a.dragging) {
      this.opts.onDragEnd?.();
    } else if (a.screwId !== null && this.enabled) {
      this.opts.onTap(a.screwId);
    }
    this.opts.onPress?.(null);
  }

  private pointerCancel(e: PointerEvent): void {
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId) return;
    this.active = null;
    this.release(e.pointerId);
    if (a.dragging) this.opts.onDragEnd?.();
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
