import type { ResumeInfo } from '../storage/progress';
import { h, svg } from './dom';
import { ICONS } from './icons';

export interface MenuHandlers {
  onPlay(): void;
  onLevels(): void;
  onSettings(): void;
}

export interface MenuState {
  /** Level "Play" would start. */
  nextLevel: number;
  completedCount: number;
  total: number;
  /** Saved in-progress board, if any — "Play" then resumes it. */
  resume: ResumeInfo | null;
}

export interface MenuScreen {
  el: HTMLElement;
  update(state: MenuState): void;
}

export function createMenu(handlers: MenuHandlers): MenuScreen {
  const playLabel = h('span', { class: 'lbl' }, 'Play');
  const levelLabel = h('span', { class: 'sub' }, 'Level 1');
  const resumeBar = h('span', { class: 'resume-bar' }, h('i'));
  const playBtn = h(
    'button',
    { class: 'btn primary big play-btn', onClick: handlers.onPlay },
    playLabel,
    levelLabel,
    resumeBar,
  );
  const progressText = h('div', null, h('b', null, '0'), ' / 1000 levels completed');
  const progressFill = h('i');

  const el = h(
    'section',
    { class: 'screen', id: 'screen-menu' },
    h(
      'div',
      { class: 'menu-hero' },
      h('img', {
        class: 'menu-logo',
        // BASE_URL so a sub-path deploy (GitHub Pages) still finds the icon.
        src: `${import.meta.env.BASE_URL}icons/icon-192.png`,
        alt: '',
        draggable: 'false',
      }),
      h('h1', { class: 'menu-title' }, 'SCREWDOM', h('small', null, '3D')),
      h('p', { class: 'menu-tagline' }, 'Unscrew. Sort. Take it apart.'),
    ),
    h(
      'div',
      { class: 'menu-actions' },
      playBtn,
      h(
        'div',
        { class: 'menu-row' },
        h('button', { class: 'btn ghost', onClick: handlers.onLevels }, svg(ICONS.grid), 'Levels'),
        h('button', { class: 'btn ghost', onClick: handlers.onSettings }, svg(ICONS.settings), 'Settings'),
      ),
      h('div', { class: 'menu-progress' }, progressText, h('div', { class: 'bar' }, progressFill)),
    ),
  );

  return {
    el,
    update(state) {
      const r = state.resume;
      playBtn.classList.toggle('resuming', !!r);
      playLabel.textContent = r ? 'Resume' : 'Play';
      levelLabel.textContent = r
        ? `Level ${r.level} · ${r.removed} / ${r.total} screws`
        : `Level ${state.nextLevel}`;
      const fill = resumeBar.firstElementChild as HTMLElement | null;
      if (fill) fill.style.width = r && r.total > 0 ? `${Math.min(100, (r.removed / r.total) * 100)}%` : '0%';
      progressText.replaceChildren(h('b', null, String(state.completedCount)), ` / ${state.total} levels completed`);
      progressFill.style.width = `${state.total ? (state.completedCount / state.total) * 100 : 0}%`;
    },
  };
}
