/**
 * The one-time "drag to turn the model" coach mark (CONTRACT_V3 §5/§6).
 *
 * v3 made rotation a required gesture, and a gesture nobody is told about is a
 * wall. The How-to-play card teaches it in words; this is the moment-of-need
 * version: a quiet pill above the power-up bar with a looping ghost finger.
 *
 * Deliberately `pointer-events: none` — it never eats a tap on a screw and has
 * no button to hit. It leaves on the player's first real drag (which is also
 * recorded, so it is never shown again), or by itself after a few seconds.
 *
 * The in-scene nudge that points at removable screws currently facing away is
 * the renderer's job (CONTRACT_V3 §6); this is only the first-run teach.
 */
import { h, svg } from './dom';
import { ROTATE_COACH_TEXT, ROTATE_COACH_TITLE } from './howto';

/** Same threshold the renderer uses to tell a tap from a drag (CONTRACT §2). */
const DRAG_PX = 12;
/** How long the mark stays up if the player does not rotate. */
const AUTO_HIDE_MS = 9000;

export interface RotateCoachOptions {
  /** The player rotated the model (or the mark taught them and they did it). */
  onLearned(): void;
}

export interface RotateCoach {
  el: HTMLElement;
  /** Show the mark. Caller decides whether it is still owed. */
  show(): void;
  hide(): void;
  isVisible(): boolean;
  /** Sit the pill this many pixels above the bottom of the screen. */
  setBottom(px: number): void;
  /**
   * Watch `host` for a rotate drag. Installed for the whole session, not just
   * while the mark is up: a player who works the gesture out alone has learned
   * it just as well, and must not be taught it later.
   */
  watch(host: HTMLElement): void;
  dispose(): void;
}

/**
 * A fingertip sweeping along a double-headed arc. Deliberately not a hand: a
 * literal hand glyph at this size reads as a rude gesture on a dark pill.
 */
const DRAG_ICON =
  '<svg viewBox="0 0 46 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path class="cm-arc" d="M8 22.5c6 4.5 24 4.5 30 0"/>' +
  '<path class="cm-arc" d="M8 22.5l4-3.4M8 22.5l3.6 3.6M38 22.5l-4-3.4M38 22.5l-3.6 3.6"/>' +
  '<g class="cm-dot">' +
  '<circle cx="23" cy="12" r="5.4" fill="currentColor" stroke="none" opacity="0.28"/>' +
  '<circle cx="23" cy="12" r="5.4"/>' +
  '</g></svg>';

export function createRotateCoach(o: RotateCoachOptions): RotateCoach {
  const el = h(
    'div',
    { class: 'coach-mark', role: 'status', 'aria-live': 'polite' },
    svg(DRAG_ICON, 'cm-ico'),
    h('div', { class: 'cm-copy' }, h('b', null, ROTATE_COACH_TITLE), h('small', null, ROTATE_COACH_TEXT)),
  );

  let visible = false;
  let hideTimer = 0;
  let learned = false;
  let watched: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let down = false;

  function stopTimer(): void {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }

  function hide(): void {
    stopTimer();
    if (!visible) return;
    visible = false;
    el.classList.remove('show');
  }

  const onDown = (ev: PointerEvent): void => {
    down = true;
    startX = ev.clientX;
    startY = ev.clientY;
  };

  const onMove = (ev: PointerEvent): void => {
    if (!down || learned) return;
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return;
    down = false;
    learned = true;
    hide();
    o.onLearned();
  };

  const onUp = (): void => {
    down = false;
  };

  return {
    el,
    show() {
      if (learned || visible) return;
      visible = true;
      el.classList.add('show');
      stopTimer();
      hideTimer = window.setTimeout(hide, AUTO_HIDE_MS);
    },
    hide,
    isVisible: () => visible,
    setBottom(px) {
      el.style.bottom = `${Math.round(px)}px`;
    },
    watch(host) {
      if (watched === host) return;
      this.dispose();
      watched = host;
      host.addEventListener('pointerdown', onDown, { passive: true });
      host.addEventListener('pointermove', onMove, { passive: true });
      host.addEventListener('pointerup', onUp, { passive: true });
      host.addEventListener('pointercancel', onUp, { passive: true });
    },
    dispose() {
      stopTimer();
      if (!watched) return;
      watched.removeEventListener('pointerdown', onDown);
      watched.removeEventListener('pointermove', onMove);
      watched.removeEventListener('pointerup', onUp);
      watched.removeEventListener('pointercancel', onUp);
      watched = null;
    },
  };
}
