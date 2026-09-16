/**
 * Player progress + settings persisted in localStorage.
 * Versioned and tolerant of missing / corrupt data.
 */

export const PROGRESS_VERSION = 1 as const;
const KEY = 'screwdom.progress.v1';

export interface Settings {
  sound: boolean;
}

export interface Progress {
  version: typeof PROGRESS_VERSION;
  /** Level the player last chose / is on (1-based). */
  currentLevel: number;
  /** Completed level numbers (sorted ascending, unique). */
  completed: number[];
  settings: Settings;
}

export function defaultProgress(): Progress {
  return {
    version: PROGRESS_VERSION,
    currentLevel: 1,
    completed: [],
    settings: { sound: true },
  };
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
}

/** Coerce anything into a well-formed Progress; never throws. */
export function normalizeProgress(raw: unknown): Progress {
  const base = defaultProgress();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;

  if (isFiniteInt(o.currentLevel) && o.currentLevel >= 1) base.currentLevel = o.currentLevel;

  if (Array.isArray(o.completed)) {
    const set = new Set<number>();
    for (const n of o.completed) if (isFiniteInt(n) && n >= 1) set.add(n);
    base.completed = [...set].sort((a, b) => a - b);
  }

  const s = o.settings;
  if (s && typeof s === 'object') {
    const so = s as Record<string, unknown>;
    if (typeof so.sound === 'boolean') base.settings.sound = so.sound;
  }
  return base;
}

function readStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function loadProgress(): Progress {
  const text = readStorage();
  if (!text) return defaultProgress();
  try {
    return normalizeProgress(JSON.parse(text));
  } catch {
    return defaultProgress();
  }
}

export function saveProgress(p: Progress): void {
  try {
    const clean = normalizeProgress(p);
    globalThis.localStorage?.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* quota / private mode: ignore */
  }
}

export function clearProgress(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Mutating helpers (they save immediately). */
export function markCompleted(p: Progress, level: number): Progress {
  if (!p.completed.includes(level)) {
    p.completed.push(level);
    p.completed.sort((a, b) => a - b);
  }
  saveProgress(p);
  return p;
}

export function setCurrentLevel(p: Progress, level: number): Progress {
  p.currentLevel = Math.max(1, Math.floor(level));
  saveProgress(p);
  return p;
}

/** First level that has not been completed yet (1 if none). */
export function firstUncompleted(p: Progress, total: number): number {
  const done = new Set(p.completed);
  for (let n = 1; n <= total; n++) if (!done.has(n)) return n;
  return total;
}
