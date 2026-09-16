# Screwdom 3D (local build)

A from-scratch clone of the *Screwdom 3D* screw-puzzle game that runs entirely on
your phone with no account, no server, no purchases and no leagues. Every level
is open and every power-up is free and unlimited.

- 1000 procedurally generated, deterministic, solvable levels ramping from
  12-screw tutorials to 189-screw machines.
- Each level is a solid 3D assembly of panels, brackets and struts in up to
  six nested shells. **Drag anywhere to turn the model** — screws hide on the
  faces pointing away from you.
- A screw comes out when nothing blocks the path it withdraws along. Strip a
  panel of its screws and it falls away, exposing the structure beneath.
- Levels are machine-verified to stay open: at least three distinct panels
  workable at once, never fewer than three screws available, and no viewing
  angle that shows an empty model.
- Six power-ups, all free and unlimited: Drill, Extra Hole, Magic Box,
  Repaint, Magnet and Hint.
- WebAudio-synthesized sound, no asset downloads.
- Your board is saved as you play, so you can leave a long level and resume
  exactly where you were, even after closing the app.
- Tuned specifically for iPhone 17 Pro Max (440x956 pt at 3x).

Level size by band:

| Levels | Screws | Panels | Shells | Tray slots | Boxes |
|---|---|---|---|---|---|
| 1-3 | 12 | 6 | 1 | 5 | 3 |
| 4-30 | 15-30 | 8-10 | 1-2 | 5 | 3 |
| 31-120 | 33-60 | 13-20 | 2-3 | 5-6 | 3 |
| 121-350 | 60-99 | 21-31 | 3-4 | 6-7 | 3 |
| 351-700 | 102-138 | 30-44 | 4-5 | 7 | 3 |
| 701-1000 | 141-189 | 39-56 | 5-6 | 8 | 4 |

## Run it on your iPhone

### Option A — free HTTPS URL via GitHub Pages (recommended: works offline)

1. Merge this branch into `main`.
2. In the GitHub repo: **Settings → Pages → Source: GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) runs the tests, builds,
   and publishes to `https://<your-user>.github.io/screw/`.
4. On the iPhone open that URL in **Safari**, tap **Share → Add to Home Screen
   → Add**. The icon launches full-screen and keeps working with no network.

### Option B — straight from your computer on the same Wi-Fi

```bash
npm install
npm run build
npm run preview      # prints http://<your-computer-ip>:4173
```

Open that address in Safari on the phone and **Add to Home Screen** the same
way. This works immediately, but because it is plain HTTP the browser will not
install the offline cache, so the computer has to keep serving while you play.

Any static HTTPS host also works (Netlify, Vercel, Cloudflare Pages): upload
the `dist/` folder. If the site lives under a sub-path, build with
`VITE_BASE=/that-path/ npm run build`.

## Optional: real native app via Xcode

If you would rather have an `.app` installed through Xcode (free Apple ID is
enough for a 7-day personal signing certificate):

```bash
npm run build
npm i -D @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Screwdom 3D" com.yourname.screwdom --web-dir dist
npx cap add ios
npx cap sync ios
npx cap open ios      # opens Xcode: pick your team, plug in the phone, Run
```

## Development

```bash
npm run dev          # dev server with hot reload (use --host to test on phone)
npm test             # vitest: rules + 139 sampled levels verified solvable (~80 s)
npm run sweep        # verify all 1000 levels and print the stats table (~12 min)
npm run build        # typecheck + production build into dist/
```

Level generation takes roughly half a second and runs in a Web Worker, so the
interface stays responsive; the game shows a loading card while it works.

Code layout: `src/core` (rules, 3D blocking, assembly generator, solver),
`src/render` (three.js scene, rotation, animations), `src/ui` (screens and
HUD), `src/audio`, `src/storage`.

The design contracts are versioned and worth reading in order:
`CONTRACT.md` sets the module boundaries and the renderer API,
`CONTRACT_V2.md` records why screw counts were limited and how the spacing
rule was relaxed, and `CONTRACT_V3.md` defines the current 3D model — the
withdrawal-axis blocking rule, the rotation scheme, and why the earlier
flat-stack model was the wrong shape for this game.
