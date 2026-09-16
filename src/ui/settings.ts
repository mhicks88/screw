import type { ResumeInfo } from '../storage/progress';
import { h, svg, isIOS, isStandalone } from './dom';
import { ICONS } from './icons';
import { INSTALL_HINT_GENERIC, INSTALL_HINT_IOS } from './howto';

export interface SettingsOptions {
  version: string;
  getSound(): boolean;
  setSound(on: boolean): void;
  /** The board saved mid-level, if any (levels run long now, so it is worth surfacing). */
  getResume(): ResumeInfo | null;
  onResume(level: number): void;
  onDiscardSaved(): void;
  onBack(): void;
  onHowToPlay(): void;
  onResetProgress(): void;
}

export interface SettingsScreen {
  el: HTMLElement;
  refresh(): void;
}

export function createSettings(o: SettingsOptions): SettingsScreen {
  const soundSwitch = h('span', { class: 'switch', role: 'switch' });
  const soundIcon = h('span', { class: 'ico' });

  const soundRow = h(
    'button',
    {
      class: 'row',
      onClick: () => {
        o.setSound(!o.getSound());
        refresh();
      },
    },
    soundIcon,
    h('div', { class: 'label' }, 'Sound effects', h('small', null, 'Synthesized, no downloads')),
    soundSwitch,
  );

  const resumeRow = h('button', { class: 'row', onClick: () => {
    const r = o.getResume();
    if (r) o.onResume(r.level);
  } });
  const discardRow = h(
    'button',
    { class: 'row danger', onClick: o.onDiscardSaved },
    h('span', { class: 'ico' }, svg(ICONS.trash)),
    h('div', { class: 'label' }, 'Discard saved board', h('small', null, 'Start this level from scratch next time')),
    h('span', { class: 'chev' }, svg(ICONS.chevronRight)),
  );
  const savedCard = h('div', { class: 'card' }, resumeRow, discardRow);

  const standalone = isStandalone();
  const install = standalone
    ? h('div', { class: 'install' }, h('b', null, 'Installed. '), 'You are playing the home-screen version, which works offline.')
    : h(
        'div',
        { class: 'install' },
        h('b', null, isIOS() ? 'Install on iPhone: ' : 'Install: '),
        isIOS() ? INSTALL_HINT_IOS : INSTALL_HINT_GENERIC,
      );

  const el = h(
    'section',
    { class: 'screen', id: 'screen-settings' },
    h(
      'header',
      { class: 'page-header' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onClick: o.onBack }, svg(ICONS.back)),
      h('h1', null, 'Settings'),
      h('span', { class: 'spacer' }),
    ),
    h(
      'div',
      { class: 'settings-body' },
      h(
        'div',
        { class: 'card' },
        soundRow,
        h(
          'button',
          { class: 'row', onClick: o.onHowToPlay },
          h('span', { class: 'ico' }, svg(ICONS.book)),
          h('div', { class: 'label' }, 'How to play', h('small', null, 'Rules and power-ups')),
          h('span', { class: 'chev' }, svg(ICONS.chevronRight)),
        ),
      ),
      savedCard,
      h(
        'div',
        { class: 'card' },
        h(
          'button',
          { class: 'row danger', onClick: o.onResetProgress },
          h('span', { class: 'ico' }, svg(ICONS.trash)),
          h('div', { class: 'label' }, 'Reset progress', h('small', null, 'Clears completed levels and the saved board')),
          h('span', { class: 'chev' }, svg(ICONS.chevronRight)),
        ),
      ),
      h(
        'div',
        { class: 'card about-card' },
        h(
          'div',
          { class: 'about' },
          h('div', null, h('b', null, 'Screwdom 3D'), ` · version ${o.version}`),
          h('div', null, 'All power-ups are free and unlimited. No coins, no lives, no ads, no timers.'),
          install,
        ),
      ),
    ),
  );

  function refresh(): void {
    const r = o.getResume();
    savedCard.style.display = r ? '' : 'none';
    if (r) {
      const pct = r.total > 0 ? Math.round((r.removed / r.total) * 100) : 0;
      resumeRow.replaceChildren(
        h('span', { class: 'ico cyan' }, svg(ICONS.play)),
        h(
          'div',
          { class: 'label' },
          `Continue level ${r.level}`,
          h('small', null, `${r.removed} / ${r.total} · ${pct}% · saved ${timeAgo(r.savedAt)}`),
        ),
        h('span', { class: 'chev' }, svg(ICONS.chevronRight)),
      );
    }
    const on = o.getSound();
    soundSwitch.classList.toggle('on', on);
    soundSwitch.setAttribute('aria-checked', String(on));
    soundIcon.replaceChildren(svg(on ? ICONS.soundOn : ICONS.soundOff));
  }
  refresh();

  return { el, refresh };
}

function timeAgo(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
