/**
 * Minimal tween helper driven by the render loop clock (no external lib).
 * Durations are in milliseconds.
 */

export type Ease = (t: number) => number;

export const Easing = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  inBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
  },
  outElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  /** Smooth up-and-back-down bump (0 → 1 → 0). */
  bump: (t: number) => Math.sin(t * Math.PI),
} satisfies Record<string, Ease>;

export interface TweenOptions {
  duration: number;
  ease?: Ease;
  delay?: number;
  /** Called with the eased progress (0..1) and the raw progress. */
  onUpdate?: (eased: number, raw: number) => void;
  onComplete?: () => void;
}

export class Tween {
  private elapsed = 0;
  private started = false;
  done = false;
  private readonly opts: TweenOptions;
  private readonly resolvers: (() => void)[] = [];

  constructor(opts: TweenOptions) {
    this.opts = opts;
  }

  /** Advance by dt ms; returns true when finished. */
  tick(dt: number): boolean {
    if (this.done) return true;
    this.elapsed += dt;
    const delay = this.opts.delay ?? 0;
    if (this.elapsed < delay) return false;
    const local = this.elapsed - delay;
    if (!this.started) {
      this.started = true;
    }
    const raw = this.opts.duration <= 0 ? 1 : Math.min(1, local / this.opts.duration);
    const eased = (this.opts.ease ?? Easing.outQuad)(raw);
    this.opts.onUpdate?.(eased, raw);
    if (raw >= 1) {
      this.finish();
      return true;
    }
    return false;
  }

  /** Stop the tween. With `complete` the final state is applied first. */
  cancel(complete = false): void {
    if (this.done) return;
    if (complete) {
      this.opts.onUpdate?.(1, 1);
      this.finish();
    } else {
      this.done = true;
      for (const r of this.resolvers) r();
      this.resolvers.length = 0;
    }
  }

  promise(): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  private finish(): void {
    this.done = true;
    this.opts.onComplete?.();
    for (const r of this.resolvers) r();
    this.resolvers.length = 0;
  }
}

export class TweenManager {
  private tweens: Tween[] = [];
  private pendingAdd: Tween[] = [];
  private updating = false;

  add(opts: TweenOptions): Tween {
    const t = new Tween(opts);
    if (this.updating) this.pendingAdd.push(t);
    else this.tweens.push(t);
    return t;
  }

  /** Run a tween and resolve when it completes (or is cancelled). */
  run(opts: TweenOptions): Promise<void> {
    return this.add(opts).promise();
  }

  /** Resolve after `ms` of tween-clock time. */
  delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return this.run({ duration: ms, ease: Easing.linear });
  }

  update(dt: number): void {
    this.updating = true;
    const list = this.tweens;
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t.tick(dt)) list[write++] = t;
    }
    list.length = write;
    this.updating = false;
    if (this.pendingAdd.length) {
      this.tweens.push(...this.pendingAdd);
      this.pendingAdd.length = 0;
    }
  }

  cancelAll(complete = false): void {
    const all = [...this.tweens, ...this.pendingAdd];
    this.tweens.length = 0;
    this.pendingAdd.length = 0;
    for (const t of all) t.cancel(complete);
  }

  get count(): number {
    return this.tweens.length + this.pendingAdd.length;
  }
}

/** Quadratic bezier helper. */
export function quadBezier(
  p0: { x: number; y: number; z: number },
  p1: { x: number; y: number; z: number },
  p2: { x: number; y: number; z: number },
  t: number,
  out: { x: number; y: number; z: number },
): void {
  const u = 1 - t;
  out.x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
  out.y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
  out.z = u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z;
}
