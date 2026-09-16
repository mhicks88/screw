/**
 * Inline SVG icons (24x24 viewBox, currentColor). Stroke-based so they read
 * crisply at small sizes on the power-up bar.
 */
import type { PowerUpId } from '../core/types';

const wrap = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${body}</svg>`;

export const ICONS = {
  back: wrap('<path d="M15 5l-7 7 7 7"/>'),
  chevronLeft: wrap('<path d="M15 5l-7 7 7 7"/>'),
  chevronRight: wrap('<path d="M9 5l7 7-7 7"/>'),
  close: wrap('<path d="M6 6l12 12M18 6L6 18"/>'),
  restart: wrap('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 3v5h5"/>'),
  settings: wrap(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
  grid: wrap('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'),
  play: wrap('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  check: wrap('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="3"'),
  star: wrap('<path d="M12 2.8l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.7l-5.9 3.1 1.2-6.5L2.5 9.7l6.6-.9z" fill="currentColor" stroke="none"/>'),
  trophy: wrap(
    '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>',
  ),
  sad: wrap('<circle cx="12" cy="12" r="9"/><path d="M8.5 16.5c1-1.5 2.2-2 3.5-2s2.5.5 3.5 2"/><path d="M9 10h.01M15 10h.01" stroke-width="3"/>'),
  soundOn: wrap('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12"/>'),
  soundOff: wrap('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l4 6M21 9l-4 6"/>'),
  trash: wrap('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  book: wrap('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 1 2-2h13"/><path d="M9 7h6"/>'),
  info: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" stroke-width="2.5"/>'),
  share: wrap('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
  plus: wrap('<path d="M12 5v14M5 12h14"/>', 'stroke-width="3"'),
  screw: wrap(
    '<circle cx="12" cy="12" r="8.5" fill="currentColor" stroke="none" opacity="0.25"/><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M7.5 12h9" stroke-width="2.5"/>',
  ),
};

export const POWERUP_ICONS: Record<PowerUpId, string> = {
  // Power drill.
  drill: wrap(
    '<path d="M3 8h11a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H3z"/><path d="M16 11h5M18 9.5v3"/><path d="M6 14l-1 6h5l1-6"/><path d="M3 8V6h6v2"/>',
  ),
  // Tray bar with holes and a plus.
  addSlot: wrap(
    '<rect x="2.5" y="9" width="19" height="7" rx="3"/><circle cx="7" cy="12.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12.5" r="1.3" fill="currentColor" stroke="none"/><path d="M17 10.5v4M15 12.5h4" stroke-width="2.2"/>',
  ),
  // Box with sparkle.
  addBox: wrap(
    '<path d="M4 9h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M3 6h18v3H3z"/><path d="M10 13h4"/><path d="M18 2v3M16.5 3.5h3" stroke-width="1.8"/>',
  ),
  // Paint roller.
  recolor: wrap(
    '<rect x="4" y="4" width="13" height="6" rx="2"/><path d="M17 7h3v5h-8v2"/><rect x="10.5" y="14" width="3" height="7" rx="1"/>',
  ),
  // Horseshoe magnet.
  magnet: wrap(
    '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 3h4v8a2 2 0 0 0 4 0V3h4"/><path d="M6 7h4M14 7h4"/>',
  ),
  // Lightbulb.
  hint: wrap(
    '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  ),
};
