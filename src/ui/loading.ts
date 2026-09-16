/**
 * Level loading overlay.
 *
 * Building a deep level can take up to ~2 s (CONTRACT_V2 §7), so the tap that
 * starts a level must produce something on screen immediately: a skeleton of the
 * board, the level number the player asked for, and a spinner that keeps moving
 * (generation itself runs in a worker, see levelLoader.ts).
 */
import { difficultyFor } from '../core';
import type { LevelDef } from '../core/types';
import { h, svg } from './dom';
import { ICONS } from './icons';

export type LoadingKind = 'build' | 'resume';

export interface LoadingOverlay {
  el: HTMLElement;
  show(level: number, difficulty: LevelDef['difficulty'], kind?: LoadingKind): void;
  hide(): void;
  isVisible(): boolean;
  /** Turn the overlay into an error card with a "Back" action. */
  fail(level: number, onBack: () => void): void;
}

export interface LoadingOptions {
  /** Called when the player backs out of a slow load. */
  onCancel(): void;
}

/** Shown in order, one per stage, while the level is being built. */
const BUILD_STAGES = [
  'Laying out the towers…',
  'Stacking the plates…',
  'Checking every screw can be reached…',
];

const RESUME_STAGES = ['Restoring your board…', 'Putting the screws back…'];

const STAGE_MS = 900;

export function createLoadingOverlay(o: LoadingOptions): LoadingOverlay {
  const levelLabel = h('div', { class: 'ld-level' }, 'Level 1');
  const badge = h('span', { class: 'diff-badge normal' }, 'normal');
  const stage = h('div', { class: 'ld-stage' }, BUILD_STAGES[0]);
  const spinner = h('div', { class: 'ld-spinner' }, svg(ICONS.screwHead));
  // Sets expectations for the wait: a level 700+ board really is ~150 screws deep.
  const shape = h('div', { class: 'ld-shape' });
  const bar = h('div', { class: 'ld-bar' }, h('i'));
  const skeleton = h(
    'div',
    { class: 'ld-skeleton', 'aria-hidden': 'true' },
    Array.from({ length: 6 }, (_, i) => {
      const plate = h('span', { class: `ld-plate p${i}` });
      plate.style.animationDelay = `${i * 0.16}s`;
      return plate;
    }),
  );

  // Only offered once a load is visibly slow, so a quick start never flickers a button.
  const cancel = h('button', { class: 'btn ghost ld-cancel', onClick: () => o.onCancel() }, 'Cancel');

  const card = h(
    'div',
    { class: 'ld-card' },
    spinner,
    levelLabel,
    badge,
    shape,
    stage,
    bar,
    cancel,
  );

  const el = h(
    'div',
    { class: 'loading-layer', role: 'status', 'aria-live': 'polite' },
    skeleton,
    card,
  );

  let timer = 0;
  let cancelTimer = 0;
  let visible = false;

  function stopTimer(): void {
    if (timer) {
      window.clearInterval(timer);
      timer = 0;
    }
    if (cancelTimer) {
      window.clearTimeout(cancelTimer);
      cancelTimer = 0;
    }
  }

  return {
    el,
    show(level, difficulty, kind = 'build') {
      const stages = kind === 'resume' ? RESUME_STAGES : BUILD_STAGES;
      el.classList.remove('failed');
      levelLabel.textContent = `Level ${level}`;
      badge.textContent = difficulty;
      badge.className = `diff-badge ${difficulty}`;
      badge.style.display = '';
      const d = difficultyFor(level);
      shape.replaceChildren(`≈${d.screws} screws`, h('i'), `${d.layers} layers`);
      shape.style.display = '';
      stage.textContent = stages[0];
      bar.style.display = '';
      spinner.style.display = '';
      el.classList.add('show');
      el.classList.remove('slow');
      visible = true;
      stopTimer();
      cancelTimer = window.setTimeout(() => el.classList.add('slow'), 1200);
      let i = 0;
      timer = window.setInterval(() => {
        i = Math.min(stages.length - 1, i + 1);
        stage.textContent = stages[i];
        if (i === stages.length - 1) stopTimer();
      }, STAGE_MS);
    },
    hide() {
      stopTimer();
      el.classList.remove('show', 'failed', 'slow');
      visible = false;
    },
    isVisible() {
      return visible;
    },
    fail(level, onBack) {
      stopTimer();
      visible = true;
      el.classList.add('show', 'failed');
      el.classList.remove('slow');
      levelLabel.textContent = `Level ${level}`;
      badge.style.display = 'none';
      shape.style.display = 'none';
      bar.style.display = 'none';
      spinner.style.display = 'none';
      stage.replaceChildren(
        'This level could not be built.',
        h('button', { class: 'btn ghost', onClick: onBack }, 'Back to levels'),
      );
    },
  };
}
