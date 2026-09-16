/** "How to play" copy, shared by the settings screen and the first-run modal. */

export interface HowToStep {
  text: string;
  free?: boolean;
}

export const HOW_TO_PLAY: HowToStep[] = [
  { text: 'Tap a screw to unscrew it. Only screws that are not covered by another plate can be removed.' },
  { text: 'Each box takes 3 screws of one colour. A full box slides away and a new one takes its place.' },
  { text: 'A screw with no matching box waits in the tray. When a matching box appears, it jumps in by itself.' },
  { text: 'Do not fill the tray! If every hole is taken and a screw has nowhere to go, you are out of space.' },
  { text: 'When the last screw leaves a plate, the plate falls away and uncovers the screws underneath.' },
  { text: 'Clear every screw to finish the level. Every power-up is free and unlimited, so use them whenever you like!', free: true },
];

export const INSTALL_HINT_IOS =
  'Open this page in Safari, tap the Share button, then choose "Add to Home Screen". The game then runs full-screen and works offline.';

export const INSTALL_HINT_GENERIC =
  'Use your browser menu and choose "Install app" or "Add to Home Screen" to play full-screen and offline.';
