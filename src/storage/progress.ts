/**
 * Player progress + settings persisted in localStorage.
 * Versioned and tolerant of missing / corrupt data.
 *
 * Schema history
 * --------------
 * v1: { version: 1, currentLevel, completed[], settings: { sound } }
 * v2: adds `resume` — a small descriptor of the board the player left mid-game.
 *     The board itself is much too big to live in the hot record (a 150-screw
 *     level serialises to tens of KB), so it is stored under its own key and
 *     the record only carries what the menu needs to offer "Resume level N".
 *
 * v1 records are migrated in place on load (same key, `resume: null`), so an
 * existing save keeps its completed levels and settings.
 */
import type { GameSnapshot } from '../core/types';

export const PROGRESS_VERSION = 2 as const;

/** Unchanged from v1 on purpose: v1 payloads are migrated in place. */
const KEY = 'screwdom.progress.v1';
/** The in-progress board. Separate key so a big write can never corrupt the record above. */
const SAVE_KEY = 'screwdom.save.v2';

export interface Settings {
  sound: boolean;
}

/** Everything the menu needs to advertise a saved game without parsing the board. */
export interface ResumeInfo {
  level: number;
  /** Screws already boxed, and the level total (for "84 / 150"). */
  removed: number;
  total: number;
  moves: number;
  /** Date.now() of the last save. */
  savedAt: number;
}

export interface Progress {
  version: typeof PROGRESS_VERSION;
  /** Level the player last chose / is on (1-based). */
  currentLevel: number;
  /** Completed level numbers (sorted ascending, unique). */
  completed: number[];
  settings: Settings;
  /** Descriptor of the saved in-progress board, or null. */
  resume: ResumeInfo | null;
}

export interface SavedGame {
  version: typeof PROGRESS_VERSION;
  level: number;
  savedAt: number;
  snapshot: GameSnapshot;
}

export function defaultProgress(): Progress {
  return {
    version: PROGRESS_VERSION,
    currentLevel: 1,
    completed: [],
    settings: { sound: true },
    resume: null,
  };
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
}

function normalizeResume(raw: unknown): ResumeInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isFiniteInt(o.level) || o.level < 1) return null;
  if (!isFiniteInt(o.total) || o.total < 1) return null;
  const removed = isFiniteInt(o.removed) ? Math.max(0, Math.min(o.total, o.removed)) : 0;
  return {
    level: o.level,
    removed,
    total: o.total,
    moves: isFiniteInt(o.moves) && o.moves >= 0 ? o.moves : 0,
    savedAt: isFiniteInt(o.savedAt) && o.savedAt > 0 ? o.savedAt : Date.now(),
  };
}

/**
 * Coerce anything (including a v1 record) into a well-formed v2 Progress.
 * Never throws; unknown fields are dropped, missing fields get defaults.
 */
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

  // v1 has no `resume`; anything older or malformed simply starts without one.
  if (o.version === PROGRESS_VERSION) base.resume = normalizeResume(o.resume);

  return base;
}

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function loadProgress(): Progress {
  const text = read(KEY);
  if (!text) return defaultProgress();
  let p: Progress;
  try {
    p = normalizeProgress(JSON.parse(text));
  } catch {
    return defaultProgress();
  }
  // A resume descriptor with no board behind it (cleared storage, quota loss)
  // must not be advertised.
  if (p.resume && !read(SAVE_KEY)) p.resume = null;
  return p;
}

export function saveProgress(p: Progress): void {
  const clean = normalizeProgress(p);
  if (!write(KEY, JSON.stringify(clean)) && clean.resume) {
    // Out of quota: the board is the only thing worth sacrificing.
    remove(SAVE_KEY);
    clean.resume = null;
    p.resume = null;
    write(KEY, JSON.stringify(clean));
  }
}

export function clearProgress(): void {
  remove(KEY);
  remove(SAVE_KEY);
}

/* ------------------------------------------------------------------ */
/* In-progress board                                                   */
/* ------------------------------------------------------------------ */

function looksLikeSnapshot(v: unknown): v is GameSnapshot {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const level = o.level as Record<string, unknown> | undefined;
  return (
    !!level &&
    typeof level === 'object' &&
    Array.isArray(level.screws) &&
    Array.isArray(level.plates) &&
    Array.isArray(level.boxQueue) &&
    isFiniteInt(level.level) &&
    Array.isArray(o.screws) &&
    Array.isArray(o.plates) &&
    Array.isArray(o.boxes) &&
    Array.isArray(o.tray) &&
    isFiniteInt(o.totalScrews) &&
    (o.status === 'playing' || o.status === 'won' || o.status === 'lost')
  );
}

/**
 * Persist the board the player is on, plus the descriptor the menu reads.
 * Only 'playing' boards are worth resuming. There is a single slot: saving one
 * board replaces the previous one, but a board with nothing worth saving never
 * evicts *another* level's save.
 */
export function saveGameState(p: Progress, level: number, snap: GameSnapshot): void {
  if (snap.status !== 'playing' || snap.moves <= 0) {
    if (p.resume?.level === level) clearGameState(p);
    return;
  }
  const payload: SavedGame = { version: PROGRESS_VERSION, level, savedAt: Date.now(), snapshot: snap };
  if (!write(SAVE_KEY, JSON.stringify(payload))) {
    clearGameState(p);
    return;
  }
  p.resume = {
    level,
    removed: snap.removedScrews,
    total: snap.totalScrews,
    moves: snap.moves,
    savedAt: payload.savedAt,
  };
  saveProgress(p);
}

/** The saved board, if it is intact and (optionally) for `level`. */
export function loadGameState(level?: number): GameSnapshot | null {
  const text = read(SAVE_KEY);
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<SavedGame>;
    if (!raw || raw.version !== PROGRESS_VERSION) return null;
    if (level !== undefined && raw.level !== level) return null;
    if (!looksLikeSnapshot(raw.snapshot)) return null;
    if (raw.snapshot.status !== 'playing') return null;
    return raw.snapshot;
  } catch {
    return null;
  }
}

export function clearGameState(p?: Progress): void {
  remove(SAVE_KEY);
  if (p && p.resume) {
    p.resume = null;
    saveProgress(p);
  }
}

/* ------------------------------------------------------------------ */
/* Mutating helpers (they save immediately)                            */
/* ------------------------------------------------------------------ */

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
