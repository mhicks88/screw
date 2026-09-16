import { h, svg } from './dom';
import { ICONS } from './icons';

export interface MenuHandlers {
  onPlay(): void;
  onLevels(): void;
  onSettings(): void;
}

export interface MenuScreen {
  el: HTMLElement;
  /** Refresh the "Level N" label and the completion meter. */
  update(nextLevel: number, completedCount: number, total: number): void;
}

export function createMenu(handlers: MenuHandlers): MenuScreen {
  const levelLabel = h('span', { class: 'sub' }, 'Level 1');
  const progressText = h('div', null, h('b', null, '0'), ' / 1000 levels completed');
  const progressFill = h('i');

  const el = h(
    'section',
    { class: 'screen', id: 'screen-menu' },
    h(
      'div',
      { class: 'menu-hero' },
      h('img', { class: 'menu-logo', src: '/icons/icon-192.png', alt: '', draggable: 'false' }),
      h('h1', { class: 'menu-title' }, 'SCREWDOM', h('small', null, '3D')),
      h('p', { class: 'menu-tagline' }, 'Unscrew. Sort. Drop the plates.'),
    ),
    h(
      'div',
      { class: 'menu-actions' },
      h(
        'button',
        { class: 'btn primary big', onClick: handlers.onPlay },
        h('span', null, 'Play'),
        levelLabel,
      ),
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
    update(nextLevel, completedCount, total) {
      levelLabel.textContent = `Level ${nextLevel}`;
      progressText.replaceChildren(h('b', null, String(completedCount)), ` / ${total} levels completed`);
      progressFill.style.width = `${total ? (completedCount / total) * 100 : 0}%`;
    },
  };
}
