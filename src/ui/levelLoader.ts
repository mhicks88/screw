/**
 * Builds levels off the UI thread.
 *
 * `generateLevel` is allowed to take ~2 s per level (CONTRACT_V2 §7), so it runs
 * in a module worker; the main thread stays free to animate the loading overlay
 * and react to taps. A small cache lets "Restart" and "Next level" reuse work,
 * and the next level is prefetched while the player is busy with the current one.
 *
 * If workers are unavailable the loader falls back to generating on the main
 * thread, but only after yielding twice so the overlay has certainly painted.
 */
import { generateLevel } from '../core';
import type { LevelDef } from '../core/types';
import type { LevelResponse } from './levelWorker';

const CACHE_LIMIT = 4;

interface Pending {
  level: number;
  resolve(def: LevelDef): void;
  reject(err: Error): void;
}

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

export class LevelLoader {
  private worker: Worker | null = null;
  private workerBroken = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<number, LevelDef>();
  /** One generation per level at a time: a prefetch and a real request share it. */
  private readonly inflight = new Map<number, Promise<LevelDef>>();
  /** Level currently being prefetched (result goes to the cache, nobody waits on it). */
  private prefetching = 0;

  /** Cached level, if this one has already been built. */
  peek(level: number): LevelDef | undefined {
    return this.cache.get(level);
  }

  /** True when `request(level)` will resolve without any generation work. */
  isReady(level: number): boolean {
    return this.cache.has(level);
  }

  async request(level: number): Promise<LevelDef> {
    const hit = this.cache.get(level);
    if (hit) return hit;
    return this.start(level);
  }

  /** Build a level in the background so a later `request` is instant. Never throws. */
  prefetch(level: number): void {
    if (level < 1 || this.cache.has(level) || this.inflight.has(level)) return;
    if (this.inflight.size > 0) return; // busy with something the player is waiting for
    this.prefetching = level;
    this.start(level)
      .catch(() => {
        /* a prefetch failure is not interesting: the real request will report it */
      })
      .finally(() => {
        if (this.prefetching === level) this.prefetching = 0;
      });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.inflight.clear();
    this.cache.clear();
  }

  /** Start (or join) the single generation for this level. */
  private start(level: number): Promise<LevelDef> {
    const existing = this.inflight.get(level);
    if (existing) return existing;
    const p = this.run(level)
      .then((def) => {
        this.remember(level, def);
        return def;
      })
      .finally(() => {
        this.inflight.delete(level);
      });
    this.inflight.set(level, p);
    return p;
  }

  /* ------------------------------------------------------------------ */

  private remember(level: number, def: LevelDef): void {
    this.cache.set(level, def);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private run(level: number): Promise<LevelDef> {
    const worker = this.ensureWorker();
    if (!worker) return this.runOnMainThread(level);
    const id = this.nextId++;
    return new Promise<LevelDef>((resolve, reject) => {
      this.pending.set(id, { level, resolve, reject });
      worker.postMessage({ id, level });
    });
  }

  private async runOnMainThread(level: number): Promise<LevelDef> {
    // Two frames: one to paint the overlay, one to let its first animation tick.
    await raf();
    await raf();
    return generateLevel(level);
  }

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') {
      this.workerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL('./levelWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<LevelResponse>) => this.onMessage(ev.data);
      w.onerror = (ev) => this.onWorkerError(ev instanceof ErrorEvent ? ev.message : 'worker error');
      w.onmessageerror = () => this.onWorkerError('worker message could not be deserialized');
      this.worker = w;
      return w;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private onMessage(msg: LevelResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.def as LevelDef);
    else p.reject(new Error(msg.error));
  }

  /**
   * The worker died (or never loaded). Fall back to the main thread for this and
   * every later request rather than leaving the player stuck on a spinner.
   */
  private onWorkerError(message: string): void {
    console.warn('[levels] generation worker failed, falling back to the main thread:', message);
    this.workerBroken = true;
    this.worker?.terminate();
    this.worker = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) {
      this.runOnMainThread(p.level).then(p.resolve, p.reject);
    }
  }
}
