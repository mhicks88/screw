/**
 * Level generation worker. Generation can take up to ~2 s for a deep level, so
 * it must not run on the UI thread — the loading overlay has to keep animating.
 *
 * Protocol: { id, level } in, { id, ok, def | error, ms } out.
 */
import { generateLevel } from '../core';

export interface LevelRequest {
  id: number;
  level: number;
}

export type LevelResponse =
  | { id: number; ok: true; level: number; def: unknown; ms: number }
  | { id: number; ok: false; level: number; error: string };

self.onmessage = (ev: MessageEvent<LevelRequest>) => {
  const { id, level } = ev.data ?? { id: -1, level: 0 };
  const t0 = performance.now();
  try {
    const def = generateLevel(level);
    const res: LevelResponse = { id, ok: true, level, def, ms: performance.now() - t0 };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    const res: LevelResponse = { id, ok: false, level, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(res);
  }
};
