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
 * v3: the flat stack of plates became a 3D assembly of panels (CONTRACT_V3 §2),
 *     so `GameSnapshot` — and therefore every saved *board* — changed shape.
 *     Adds `coach`, the first-run teaching flags (currently: has the player
 *     ever rotated the model).
 *
 * Migration rule: the record itself is migrated in place on load (same key), so
 * completed levels, the current level and settings ALWAYS survive a version
 * bump. The saved board never migrates — a v2 board restored into a v3 build
 * would be a plate stack with no panels and would crash the renderer, so older
 * boards are simply discarded (their key is deleted and `resume` is dropped).
 */
import type { GameSnapshot } from '../core/types';

export const PROGRESS_VERSION = 3 as const;

/** Unchanged from v1 on purpose: older payloads are migrated in place. */
const KEY = 'screwdom.progress.v1';
/**
 * The in-progress board. Separate key so a big write can never corrupt the
 * record above, and *versioned* so a board written by an older schema can never
 * be parsed by a newer build — the key simply is not there.
 */
const SAVE_KEY = 'screwdom.save.v3';
/** Boards from superseded schemas. Deleted on load so they do not squat on quota. */
const LEGACY_SAVE_KEYS = ['screwdom.save.v2'];

export interface Settings {
  sound: boolean;
}

/** One-time teaching moments the player has already had. */
export interface Coach {
  /** True once the player has rotated the model (or waved the coach mark away). */
  rotateDone: boolean;
  /** How many times the "drag to turn" mark has been shown without a rotation. */
  rotateShown: number;
}

/** After this many quiet appearances the coach mark stops asking. */
export const ROTATE_COACH_MAX_SHOWS = 3;

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
  /** First-run coach marks (v3). */
  coach: Coach;
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
    coach: { rotateDone: false, rotateShown: 0 },
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
 * Coerce anything (including a v1 or v2 record) into a well-formed v3 Progress.
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

  const c = o.coach;
  if (c && typeof c === 'object') {
    const co = c as Record<string, unknown>;
    if (typeof co.rotateDone === 'boolean') base.coach.rotateDone = co.rotateDone;
    if (isFiniteInt(co.rotateShown) && co.rotateShown >= 0) base.coach.rotateShown = co.rotateShown;
  }

  // Only a current-version record can point at a board this build can restore.
  // v1 has no `resume` at all; a v2 `resume` describes a plate-stack board that
  // v3 cannot load, so it is dropped with the board it refers to.
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
  // Boards written by a superseded schema are unreadable here; reclaim the space.
  for (const k of LEGACY_SAVE_KEYS) if (read(k) !== null) remove(k);
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
    Array.isArray(level.panels) &&
    Array.isArray(level.boxQueue) &&
    isFiniteInt(level.level) &&
    Array.isArray(o.screws) &&
    Array.isArray(o.panels) &&
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

/** Remember that the player has been taught (or has worked out) the drag gesture. */
export function markRotateLearned(p: Progress): Progress {
  if (p.coach.rotateDone) return p;
  p.coach.rotateDone = true;
  saveProgress(p);
  return p;
}

/** Count one quiet appearance of the "drag to turn" coach mark. */
export function noteRotateCoachShown(p: Progress): Progress {
  p.coach.rotateShown = Math.min(ROTATE_COACH_MAX_SHOWS, p.coach.rotateShown + 1);
  saveProgress(p);
  return p;
}

/** Should the game screen still offer the one-time "drag to turn" coach mark? */
export function shouldShowRotateCoach(p: Progress): boolean {
  return !p.coach.rotateDone && p.coach.rotateShown < ROTATE_COACH_MAX_SHOWS;
}

/** First level that has not been completed yet (1 if none). */
export function firstUncompleted(p: Progress, total: number): number {
  const done = new Set(p.completed);
  for (let n = 1; n <= total; n++) if (!done.has(n)) return n;
  return total;
}
