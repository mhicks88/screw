import * as THREE from 'three';

/**
 * Free-orbit (trackball) controller for the ASSEMBLY, not the camera
 * (CONTRACT_V3 §1, §5).
 *
 * The drag is accumulated as quaternions in world space: every pointer delta
 * becomes one small rotation about an axis built from the camera's own right/up
 * vectors, pre-multiplied onto the current orientation. Nothing is ever stored
 * as euler angles, so there is no gimbal pinch and no accumulated roll — the
 * object simply keeps turning the way the finger pushed it.
 *
 * Tracking: a drag of `radiusPx` pixels rotates by one radian, where radiusPx
 * is the projected pixel radius of the assembly's bounding sphere. That makes
 * the point under the finger follow it almost exactly near the centre of the
 * object and lag slightly at the silhouette, which is what a real trackball
 * does too.
 */

/** Below this (rad/ms) the inertia is considered settled and is dropped. */
const SPIN_STOP = 0.00014;
/** Hard cap on spin speed (rad/ms) so a flick cannot disorient the player. */
const SPIN_MAX = 0.0052;
/** Exponential decay time constant of the inertia, in ms. */
const SPIN_TAU = 165;
/** How quickly the sampled drag velocity follows the pointer (0..1 per event). */
const VEL_SMOOTH = 0.35;

export class Orbit {
  /** Current orientation of the assembly group. */
  readonly quaternion = new THREE.Quaternion();
  /** Pixel radius of the assembly's bounding sphere on screen. */
  private radiusPx = 320;
  private dragging = false;
  /** Angular velocity: unit axis + speed in rad/ms. */
  private readonly spinAxis = new THREE.Vector3(0, 1, 0);
  private spinSpeed = 0;
  /** Set whenever the orientation actually changed, cleared by `consumeDirty`. */
  private dirty = true;
  private lastMoveMs = 0;

  private readonly camera: THREE.Camera;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(camera: THREE.Camera) {
    this.camera = camera;
  }

  /** Called by the rig after framing: projected radius of the bounding sphere. */
  setRadiusPx(px: number): void {
    if (px > 8) this.radiusPx = px;
  }

  get isSpinning(): boolean {
    return this.spinSpeed > 0;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  begin(): void {
    this.dragging = true;
    this.spinSpeed = 0;
    this.lastMoveMs = 0;
  }

  /**
   * Apply a pointer delta in CSS pixels (dy positive = finger moved down).
   * `dtMs` is the time since the previous move, used to seed the inertia.
   */
  drag(dx: number, dy: number, dtMs: number): void {
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    const angle = len / this.radiusPx;
    this.axisFromDelta(dx, dy, len);
    this.q.setFromAxisAngle(this.axis, angle);
    this.quaternion.premultiply(this.q).normalize();
    this.dirty = true;

    // Velocity for the release inertia. Pointer events arrive irregularly, so
    // the sample is smoothed and clamped rather than trusted frame by frame.
    const dt = Math.max(8, Math.min(60, dtMs || 16));
    const speed = Math.min(SPIN_MAX, angle / dt);
    if (this.spinSpeed === 0) {
      this.spinAxis.copy(this.axis);
      this.spinSpeed = speed;
    } else {
      this.spinAxis.lerp(this.axis, VEL_SMOOTH).normalize();
      this.spinSpeed += (speed - this.spinSpeed) * VEL_SMOOTH;
    }
    this.lastMoveMs = 0;
  }

  /** Release: keep spinning with the sampled velocity, then settle. */
  end(): void {
    this.dragging = false;
    // A finger that stopped before lifting must not fling the object.
    if (this.lastMoveMs > 90) this.spinSpeed = 0;
    if (this.spinSpeed < SPIN_STOP * 2.5) this.spinSpeed = 0;
  }

  cancel(): void {
    this.dragging = false;
    this.spinSpeed = 0;
  }

  /** Advance the inertia. Returns true if the orientation changed this frame. */
  update(dtMs: number): boolean {
    if (this.dragging) {
      this.lastMoveMs += dtMs;
      const changed = this.dirty;
      this.dirty = false;
      return changed;
    }
    if (this.spinSpeed > 0) {
      const angle = this.spinSpeed * dtMs;
      this.q.setFromAxisAngle(this.spinAxis, angle);
      this.quaternion.premultiply(this.q).normalize();
      this.spinSpeed *= Math.exp(-dtMs / SPIN_TAU);
      if (this.spinSpeed < SPIN_STOP) this.spinSpeed = 0;
      this.dirty = true;
    }
    const changed = this.dirty;
    this.dirty = false;
    return changed;
  }

  /** Force a recompute on the next frame (level load, resize). */
  markDirty(): void {
    this.dirty = true;
  }

  reset(q?: THREE.Quaternion): void {
    this.quaternion.copy(q ?? new THREE.Quaternion());
    this.spinSpeed = 0;
    this.dragging = false;
    this.dirty = true;
  }

  /** Rotation axis in WORLD space for a screen-space drag (see class comment). */
  private axisFromDelta(dx: number, dy: number, len: number): void {
    const m = this.camera.matrixWorld.elements;
    this.right.set(m[0], m[1], m[2]).normalize();
    this.up.set(m[4], m[5], m[6]).normalize();
    // Drag right → spin about the camera's up axis; drag down → spin about its
    // right axis. Both are right-handed, which is what makes the near surface
    // of the object follow the finger.
    this.axis
      .set(0, 0, 0)
      .addScaledVector(this.up, dx / len)
      .addScaledVector(this.right, dy / len)
      .normalize();
  }
}
