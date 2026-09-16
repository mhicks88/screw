/** "How to play" copy, shared by the settings screen and the first-run modal. */

export interface HowToStep {
  text: string;
  free?: boolean;
}

export const HOW_TO_PLAY: HowToStep[] = [
  { text: 'Tap a screw to unscrew it. It only comes out if nothing blocks its path.' },
  { text: 'Drag anywhere to turn the model — screws hide on the faces turned away from you.' },
  { text: 'Each box takes 3 screws of one colour. A full box slides away and a new one takes its place.' },
  { text: 'A screw with no matching box waits in the tray, and jumps in by itself when its box appears.' },
  { text: 'Do not fill the tray! If every hole is taken and a screw has nowhere to go, you are out of space.' },
  { text: 'Empty a panel and it falls away, uncovering the shell underneath.' },
  { text: 'Strip the model to the last screw to win. Every power-up is free and unlimited, so use them whenever you like!', free: true },
];

/** The one-time coach mark shown on the game screen until the player rotates. */
export const ROTATE_COACH_TITLE = 'Drag to turn the model';
export const ROTATE_COACH_TEXT = 'Screws hide on the faces turned away.';

export const INSTALL_HINT_IOS =
  'Open this page in Safari, tap the Share button, then choose "Add to Home Screen". The game then runs full-screen and works offline.';

export const INSTALL_HINT_GENERIC =
  'Use your browser menu and choose "Install app" or "Add to Home Screen" to play full-screen and offline.';
