/**
 * WebAudio-synthesized sound effects. No asset files.
 *
 * The AudioContext is created lazily and resumed on the first user gesture
 * (pointerdown / touchend / keydown), which iOS Safari requires.
 */

export type SfxName =
  | 'tap' | 'screwOut' | 'screwIn' | 'boxComplete' | 'boxSpawn' | 'plateDrop'
  | 'blocked' | 'win' | 'lose' | 'powerup' | 'click';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let enabled = true;
let unlockInstalled = false;

type Ctor = typeof AudioContext;
function getCtor(): Ctor | null {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const C = getCtor();
  if (!C) return null;
  try {
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

function resume(): void {
  const c = ensureContext();
  if (c && c.state !== 'running') {
    c.resume().catch(() => {});
  }
}

/** Install the one-time gesture unlock listeners. Safe to call repeatedly. */
export function installAudioUnlock(): void {
  if (unlockInstalled) return;
  unlockInstalled = true;
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  const handler = () => {
    resume();
    if (ctx && ctx.state === 'running') {
      window.removeEventListener('pointerdown', handler, opts);
      window.removeEventListener('touchend', handler, opts);
      window.removeEventListener('keydown', handler, opts);
    }
  };
  window.addEventListener('pointerdown', handler, opts);
  window.addEventListener('touchend', handler, opts);
  window.addEventListener('keydown', handler, opts);
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (on) resume();
}

export function isSoundEnabled(): boolean {
  return enabled;
}

/* ------------------------------------------------------------------ */
/* Synth helpers                                                       */
/* ------------------------------------------------------------------ */

function getNoise(c: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const len = c.sampleRate * 1;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** Optional frequency target (exponential glide) at end of duration. */
  freqTo?: number;
  start?: number; // seconds after now
  dur: number; // seconds
  vol?: number;
  attack?: number;
  /** Detune in cents. */
  detune?: number;
}

function tone(c: AudioContext, o: ToneOpts): void {
  if (!master) return;
  const t0 = c.currentTime + (o.start ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.detune) osc.detune.value = o.detune;
  if (o.freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqTo), t0 + o.dur);
  const vol = o.vol ?? 0.3;
  const a = o.attack ?? 0.005;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

interface NoiseOpts {
  start?: number;
  dur: number;
  vol?: number;
  /** Band-pass centre frequency; omit for lowpass. */
  freq?: number;
  freqTo?: number;
  q?: number;
  type?: BiquadFilterType;
  attack?: number;
}

function noise(c: AudioContext, o: NoiseOpts): void {
  if (!master) return;
  const t0 = c.currentTime + (o.start ?? 0);
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  const f = c.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.frequency.setValueAtTime(o.freq ?? 1200, t0);
  if (o.freqTo) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqTo), t0 + o.dur);
  f.Q.value = o.q ?? 1;
  const g = c.createGain();
  const vol = o.vol ?? 0.2;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack ?? 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + o.dur + 0.02);
}

/* ------------------------------------------------------------------ */
/* The effects                                                         */
/* ------------------------------------------------------------------ */

const FX: Record<SfxName, (c: AudioContext) => void> = {
  tap(c) {
    tone(c, { type: 'triangle', freq: 900, freqTo: 600, dur: 0.06, vol: 0.18 });
    noise(c, { dur: 0.03, vol: 0.08, freq: 3000 });
  },

  // Rising ratchet: a burst of short clicks with rising pitch, then a pop.
  screwOut(c) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const st = i * 0.035;
      tone(c, { type: 'square', freq: 500 + i * 110, dur: 0.028, vol: 0.09, start: st });
      noise(c, { start: st, dur: 0.02, vol: 0.12, freq: 2500 + i * 300, q: 2 });
    }
    tone(c, { type: 'sine', freq: 700, freqTo: 1300, dur: 0.16, vol: 0.16, start: n * 0.035 });
  },

  // Short descending click: the screw seats into the hole.
  screwIn(c) {
    tone(c, { type: 'triangle', freq: 1100, freqTo: 420, dur: 0.09, vol: 0.2 });
    noise(c, { dur: 0.04, vol: 0.15, freq: 1800, q: 1.5 });
    tone(c, { type: 'sine', freq: 180, dur: 0.08, vol: 0.12, start: 0.02 });
  },

  // Happy three-note arpeggio.
  boxComplete(c) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      tone(c, { type: 'triangle', freq: f, dur: 0.22, vol: 0.2, start: i * 0.07 });
      tone(c, { type: 'sine', freq: f * 2, dur: 0.18, vol: 0.06, start: i * 0.07 });
    });
    noise(c, { start: 0.2, dur: 0.25, vol: 0.06, freq: 6000, q: 0.5 });
  },

  // Whoosh: a filtered noise sweep.
  boxSpawn(c) {
    noise(c, { dur: 0.32, vol: 0.22, freq: 300, freqTo: 2400, q: 0.8, attack: 0.05 });
    tone(c, { type: 'sine', freq: 200, freqTo: 480, dur: 0.3, vol: 0.06, attack: 0.05 });
  },

  // Low thud with a bit of rattle.
  plateDrop(c) {
    tone(c, { type: 'sine', freq: 120, freqTo: 45, dur: 0.35, vol: 0.4 });
    noise(c, { dur: 0.18, vol: 0.18, freq: 250, type: 'lowpass', q: 0.7 });
    noise(c, { start: 0.06, dur: 0.12, vol: 0.07, freq: 1500, q: 2 });
  },

  // Dull buzz: refused.
  blocked(c) {
    tone(c, { type: 'sawtooth', freq: 140, dur: 0.16, vol: 0.14 });
    tone(c, { type: 'square', freq: 143, dur: 0.16, vol: 0.08 });
    tone(c, { type: 'sawtooth', freq: 120, dur: 0.14, vol: 0.12, start: 0.17 });
  },

  // Fanfare.
  win(c) {
    const seq: [number, number][] = [
      [523.25, 0], [659.25, 0.12], [783.99, 0.24], [1046.5, 0.36],
      [783.99, 0.58], [1046.5, 0.7], [1318.5, 0.86],
    ];
    for (const [f, st] of seq) {
      tone(c, { type: 'triangle', freq: f, dur: 0.3, vol: 0.22, start: st });
      tone(c, { type: 'square', freq: f / 2, dur: 0.25, vol: 0.05, start: st });
    }
    tone(c, { type: 'sine', freq: 1318.5, dur: 0.9, vol: 0.12, start: 0.86, attack: 0.03 });
    noise(c, { start: 0.86, dur: 0.6, vol: 0.08, freq: 7000, q: 0.5, attack: 0.02 });
  },

  // Descending "oh no".
  lose(c) {
    const seq: [number, number][] = [[440, 0], [392, 0.18], [349.2, 0.36], [261.6, 0.56]];
    for (const [f, st] of seq) {
      tone(c, { type: 'triangle', freq: f, freqTo: f * 0.92, dur: 0.28, vol: 0.2, start: st });
    }
    tone(c, { type: 'sawtooth', freq: 130, freqTo: 80, dur: 0.6, vol: 0.08, start: 0.56 });
  },

  // Sparkle.
  powerup(c) {
    for (let i = 0; i < 6; i++) {
      const f = 1200 + i * 260 + (i % 2) * 90;
      tone(c, { type: 'sine', freq: f, dur: 0.14, vol: 0.12, start: i * 0.045 });
    }
    tone(c, { type: 'triangle', freq: 600, freqTo: 1800, dur: 0.3, vol: 0.08 });
    noise(c, { dur: 0.3, vol: 0.05, freq: 8000, q: 0.6, attack: 0.02 });
  },

  // UI click.
  click(c) {
    tone(c, { type: 'sine', freq: 1500, freqTo: 900, dur: 0.05, vol: 0.14 });
    noise(c, { dur: 0.02, vol: 0.06, freq: 4000 });
  },
};

/** Play a named effect (no-op when sound is disabled or audio is unavailable). */
export function play(name: SfxName): void {
  if (!enabled) return;
  const c = ensureContext();
  if (!c || !master) return;
  if (c.state !== 'running') {
    resume();
    // resume() is async; on iOS the first gesture may still leave it suspended.
    if ((c.state as AudioContextState) !== 'running') return;
  }
  try {
    FX[name](c);
  } catch {
    /* never let audio break the game */
  }
}
