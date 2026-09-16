import { describe, expect, it } from 'vitest';
import {
  buildAssembly, outerShellFraction, placePanels, placeScrews, shellCount, shellRadii, trimScrews,
} from '../src/core/assembly';
import { computeBlockers } from '../src/core/blocking';
import { difficultyFor } from '../src/core/difficulty';
import { distanceToPolygonEdge, pointInShape } from '../src/core/geometry';
import {
  assemblyToPanel, dotV3, lengthV3, obbOverlap, panelMaxRadius, panelNormal, panelObb,
} from '../src/core/geometry3';
import { Rng } from '../src/core/rng';
import { SCREW_EDGE_MARGIN, spacingViolations } from '../src/core/spacing';
import { ASSEMBLY_RADIUS, type PanelDef } from '../src/core/types';

const LEVELS = [1, 4, 20, 60, 150, 400, 800, 1000];
const EPS = 1e-6;

/** Panels that may bed into a neighbour (brackets and straps bolted over joints). */
const MAX_BITE = 0.26;

function assemblyFor(level: number, attempt = 0) {
  const params = difficultyFor(level);
  const asm = buildAssembly(params, new Rng(1000 + level * 31 + attempt));
  return { params, asm };
}

describe('assembly geometry (CONTRACT_V3 §7)', () => {
  for (const level of LEVELS) {
    const { params, asm } = assemblyFor(level);
    const tag = `level ${level}`;

    it(`${tag}: every panel fits inside the bounding sphere`, () => {
      expect(asm.panels.length).toBeGreaterThanOrEqual(2);
      for (const p of asm.panels) {
        expect(panelMaxRadius(p), `panel ${p.id}`).toBeLessThanOrEqual(ASSEMBLY_RADIUS + EPS);
      }
      for (const s of asm.screws) {
        expect(lengthV3(s.position)).toBeLessThanOrEqual(ASSEMBLY_RADIUS + EPS);
      }
    });

    it(`${tag}: every screw sits on a face of its own panel, clear of the edges`, () => {
      const byId = new Map(asm.panels.map((p) => [p.id, p]));
      for (const s of asm.screws) {
        const panel = byId.get(s.panelId)!;
        const local = assemblyToPanel(panel, s.position);
        // On one of the two faces, and withdrawing along that face's normal.
        const onFront = Math.abs(local.z - panel.thickness) < 1e-6;
        const onBack = Math.abs(local.z) < 1e-6;
        expect(onFront || onBack).toBe(true);
        expect(dotV3(s.axis, panelNormal(panel))).toBeCloseTo(onFront ? 1 : -1, 6);
        expect(pointInShape(local, panel.shape)).toBe(true);
        let edge = distanceToPolygonEdge(local, panel.shape.outline);
        for (const h of panel.shape.holes ?? []) edge = Math.min(edge, distanceToPolygonEdge(local, h));
        expect(edge).toBeGreaterThanOrEqual(SCREW_EDGE_MARGIN - EPS);
      }
    });

    it(`${tag}: every panel carries at least one screw`, () => {
      const used = new Set(asm.screws.map((s) => s.panelId));
      for (const p of asm.panels) expect(used.has(p.id), `panel ${p.id} has no screw`).toBe(true);
    });

    it(`${tag}: skin panels never interpenetrate, and nothing beds in deeply`, () => {
      const obbs = asm.panels.map(panelObb);
      for (let i = 0; i < asm.panels.length; i++) {
        for (let j = i + 1; j < asm.panels.length; j++) {
          expect(obbOverlap(obbs[i], obbs[j], -MAX_BITE), `panels ${i},${j}`).toBe(false);
        }
      }
    });

    it(`${tag}: shells nest, outermost first`, () => {
      // Every mounting direction carries a STACK of panels, one per shell, and
      // within a stack a deeper shell sits closer to the middle. (Across
      // stacks the offsets differ — brackets and straps stand proud of the skin
      // they are bolted over — so the nesting is per stack, plus the blocking
      // order asserted below.)
      const stacks = new Map<string, { shell: number; offset: number }[]>();
      for (const p of asm.panels) {
        const n = panelNormal(p);
        const key = [n.x, n.y, n.z].map((v) => Math.round(v * 40) / 40).join(',');
        const list = stacks.get(key) ?? [];
        list.push({ shell: p.shell, offset: dotV3(p.position, n) });
        stacks.set(key, list);
      }
      for (const list of stacks.values()) {
        const byShell = new Map<number, number>();
        for (const e of list) byShell.set(e.shell, Math.max(byShell.get(e.shell) ?? -Infinity, e.offset));
        const shells = [...byShell.keys()].sort((a, b) => a - b);
        for (let i = 1; i < shells.length; i++) {
          expect(byShell.get(shells[i])!).toBeLessThan(byShell.get(shells[i - 1])! + EPS);
        }
      }
      // Shell indices are dense: the renderer tints by them.
      const used = [...new Set(asm.panels.map((p) => p.shell))].sort((a, b) => a - b);
      expect(used).toEqual(used.map((_, i) => i));
      expect(shellCount(asm.panels)).toBeLessThanOrEqual(params.shells);
    });

    it(`${tag}: a screw is only ever blocked by a STRICTLY outer shell`, () => {
      // This is what makes a level solvable by construction: the panel with the
      // largest shell index that still has screws always has a removable one.
      const blockers = computeBlockers(asm.panels, asm.screws);
      const byId = new Map(asm.panels.map((p) => [p.id, p]));
      asm.screws.forEach((s, i) => {
        const own = byId.get(s.panelId)!;
        for (const pi of blockers[i]) {
          expect(asm.panels[pi].shell, `screw ${i} blocked by an equal or deeper panel`).toBeLessThan(own.shell);
        }
      });
    });

    it(`${tag}: the spacing rule holds over every pair`, () => {
      expect(spacingViolations(asm.screws, asm.blockers)).toEqual([]);
    });

    it(`${tag}: the recorded blockers are exactly what the ray test finds`, () => {
      const fresh = computeBlockers(asm.panels, asm.screws).map((b) => b.map((i) => asm.panels[i].id).sort((x, y) => x - y));
      asm.blockers.forEach((b, i) => expect([...b].sort((x, y) => x - y)).toEqual(fresh[i]));
    });
  }

  it('is deterministic for a given seed', () => {
    const a = assemblyFor(700).asm;
    const b = assemblyFor(700).asm;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('screws are spread through the shells, not all on the skin', () => {
    for (const level of [200, 600, 1000]) {
      const { asm } = assemblyFor(level);
      expect(outerShellFraction(asm.panels, asm.screws), `level ${level}`).toBeLessThan(0.6);
    }
  });

  it('shell offsets decrease and stay inside the sphere', () => {
    for (const shells of [1, 3, 6]) {
      const radii = shellRadii(shells);
      expect(radii.length).toBe(shells);
      for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThan(radii[i - 1]);
      expect(radii[0]).toBeLessThan(ASSEMBLY_RADIUS);
    }
  });

  it('trimScrews cuts to an exact count and never empties a panel', () => {
    const params = difficultyFor(400);
    const rng = new Rng(5);
    const panels = placePanels(params, rng);
    const placed = placeScrews(panels, params.screws, rng);
    const asm = { panels, screws: placed.screws, blockers: placed.blockers };
    const want = Math.min(asm.screws.length, params.screws);
    const cut = trimScrews(asm, want, new Rng(9));
    expect(cut.screws.length).toBe(want);
    expect(cut.blockers.length).toBe(want);
    const counts = new Map<number, number>();
    for (const s of cut.screws) counts.set(s.panelId, (counts.get(s.panelId) ?? 0) + 1);
    for (const p of panels) {
      if (placed.screws.some((s) => s.panelId === p.id)) expect(counts.get(p.id) ?? 0).toBeGreaterThan(0);
    }
  });

  it('panels point in many directions, not just the six chassis axes', () => {
    const { asm } = assemblyFor(1000);
    const axes = new Set(asm.screws.map((s) => {
      const q = (v: number) => Math.round(v * 20) / 20;
      return `${q(s.axis.x)},${q(s.axis.y)},${q(s.axis.z)}`;
    }));
    expect(axes.size).toBeGreaterThanOrEqual(10);
  });

  it('a tutorial assembly is a closed box: something faces every direction', () => {
    const { asm } = assemblyFor(1);
    const normals = asm.panels.map(panelNormal) as { x: number; y: number; z: number }[];
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      for (const z of [-0.8, -0.3, 0.3, 0.8]) {
        const r = Math.sqrt(1 - z * z);
        const view = { x: r * Math.cos(a), y: r * Math.sin(a), z };
        expect(normals.some((n) => dotV3(n, view) > 0.35)).toBe(true);
      }
    }
  });
});

describe('panel placement', () => {
  it('honours the panel budget and keeps shells dense', () => {
    for (const level of [60, 300, 1000]) {
      const params = difficultyFor(level);
      const panels: PanelDef[] = placePanels(params, new Rng(level));
      expect(panels.length, `level ${level}`).toBeLessThanOrEqual(params.panels);
      expect(panels.length, `level ${level}`).toBeGreaterThanOrEqual(2);
      expect(panels.every((p) => p.shell < params.shells)).toBe(true);
      expect(panels.map((p) => p.id)).toEqual(panels.map((_, i) => i));
    }
  });
});
