/**
 * The board, checked as data.
 *
 * Rendering is hard to test and mostly uninteresting; *what* gets rendered is neither. These tests
 * pin the parts that would be wrong silently: a token showing the wrong odds, a harbour badged
 * twice, a piece drawn on the wrong kind of locus, or a viewBox that crops the island.
 */

import { boundsOf, type HexId } from '@catan/core';
import { describe, expect, it } from 'vitest';

import { advance, fixture } from './fixture.testkit.js';
import { boardScene, HEX_SIZE, sceneLayout } from './scene.js';
import { affordances } from './targets.js';
import { pipsFor } from './theme.js';

describe('boardScene', () => {
  it('draws every hex of the topology as a hexagon', () => {
    const f = fixture();
    const scene = boardScene(f.ctx, f.view, []);

    expect(scene.hexes).toHaveLength(f.ctx.topology.hexes.length);
    expect(scene.hexes.every((hex) => hex.points.length === 6)).toBe(true);
    expect(scene.hexes.filter((hex) => hex.class === 'land')).toHaveLength(19);
  });

  it('fits the whole island in the viewBox', () => {
    const f = fixture();
    const scene = boardScene(f.ctx, f.view, []);
    const [x, y, width, height] = scene.viewBox.split(' ').map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const bounds = boundsOf(sceneLayout(), f.ctx.topology.hexes);

    expect(x).toBeLessThanOrEqual(bounds.minX);
    expect(y).toBeLessThanOrEqual(bounds.minY);
    expect(x + width).toBeGreaterThanOrEqual(bounds.maxX);
    expect(y + height).toBeGreaterThanOrEqual(bounds.maxY);
  });

  it('gives every numbered hex the odds printed on its token', () => {
    const f = fixture();
    const scene = boardScene(f.ctx, f.view, []);
    const tokens = scene.hexes.flatMap((hex) => hex.tokens);

    // 18 tokens on the 3-4 player board: nineteen land hexes, and the desert takes none.
    expect(tokens).toHaveLength(18);
    expect(tokens.every((t) => t.pips === pipsFor(t.value, 6))).toBe(true);
    expect(
      tokens
        .filter((t) => t.hot)
        .map((t) => t.value)
        .sort(),
    ).toEqual([6, 6, 8, 8]);
    expect(tokens.some((t) => t.value === 7)).toBe(false);
  });

  it('leaves the desert bare and gives it the robber', () => {
    const f = fixture();
    const scene = boardScene(f.ctx, f.view, []);
    const desert = scene.hexes.find((hex) => hex.terrain === 'desert');

    expect(desert?.tokens).toEqual([]);
    expect(desert?.yields).toBeNull();
    expect(desert?.blocked).toBe(true);
    expect(scene.hexes.filter((hex) => hex.blocked)).toHaveLength(1);

    const robber = scene.pieces.find((piece) => piece.kind === 'robber');
    expect(robber?.locus).toBe('hex');
    expect(robber?.seat).toBeNull();
    expect(robber?.at).toEqual(desert?.center);
  });

  it('badges each harbour once, out in the water', () => {
    const f = fixture();
    const scene = boardScene(f.ctx, f.view, []);

    // Nine harbours on the 3-4 player board, each controlled from two intersections.
    expect(scene.docks).toHaveLength(9);
    expect(scene.docks.filter((dock) => dock.anchors.length === 2)).toHaveLength(9);
    expect(scene.docks.filter((dock) => dock.kind === null)).toHaveLength(4);
    expect(scene.docks.map((dock) => dock.label)).toContain('2:1');

    // The badge is pushed off the coast, so it should sit beyond every anchor's distance from the
    // island's centre.
    for (const dock of scene.docks) {
      const middle = midpoint(dock.anchors);
      expect(Math.hypot(dock.at.x - middle.x, dock.at.y - middle.y)).toBeCloseTo(HEX_SIZE * 0.5, 5);

      // …and squarely between its two intersections, since either may trade through it. The
      // distance above pins how far the badge went; only this pins which way, and a badge pushed
      // straight out from the land drifts along the chord towards whichever corner touches more
      // of it.
      const [a, b] = dock.anchors;
      if (a === undefined || b === undefined) continue;
      expect(Math.hypot(dock.at.x - a.x, dock.at.y - a.y)).toBeCloseTo(
        Math.hypot(dock.at.x - b.x, dock.at.y - b.y),
        5,
      );
    }
  });

  it('places pieces on the locus their kind declares', () => {
    const f = advance(fixture(), 4);
    const scene = boardScene(f.ctx, f.view, []);
    const built = scene.pieces.filter((piece) => piece.owner !== null);

    expect(built.length).toBeGreaterThan(0);
    for (const piece of built) {
      const meta = f.ctx.rules.pieceKinds[piece.kind];
      expect(piece.locus).toBe(meta?.locus);
      expect(piece.seat).not.toBeNull();
      // Only edge pieces are rotated; a settlement drawn at an angle would be a bug.
      if (piece.locus !== 'edge') expect(piece.angle).toBe(0);
    }
  });

  it('turns offered actions into spots on the board', () => {
    const f = fixture();
    const actor = f.state.seatOrder[0];
    if (actor === undefined) throw new Error('no seats');
    const { targets } = affordances(f.ctx, f.session.options(actor));
    const scene = boardScene(f.ctx, f.view, targets);

    expect(scene.targets).toHaveLength(targets.length);
    expect(scene.targets.every((t) => t.kind === 'vertex')).toBe(true);
    expect(scene.targets.every((t) => t.options === 1)).toBe(true);
    // Every target must land somewhere inside the drawn board.
    const [x, y, width, height] = scene.viewBox.split(' ').map(Number) as [
      number,
      number,
      number,
      number,
    ];
    for (const target of scene.targets) {
      expect(target.at.x).toBeGreaterThanOrEqual(x);
      expect(target.at.x).toBeLessThanOrEqual(x + width);
      expect(target.at.y).toBeGreaterThanOrEqual(y);
      expect(target.at.y).toBeLessThanOrEqual(y + height);
    }
  });

  it('hides tokens the ruleset has turned face down', () => {
    const f = fixture();
    const hidden = f.ctx.topology.hexes.find(
      (hex: HexId) => (f.state.board.hexes[hex]?.numbers.length ?? 0) > 0,
    );
    if (hidden === undefined) throw new Error('no numbered hex');
    const state = f.session.state;
    const hex = state.board.hexes[hidden];
    if (hex === undefined) throw new Error('no such hex');
    hex.numbersHidden = true;

    const scene = boardScene(f.ctx, f.session.view(null), []);
    expect(scene.hexes.find((h) => h.hex === hidden)?.tokens).toEqual([]);
  });
});

describe('pipsFor', () => {
  it('counts the ways two dice make a number', () => {
    expect(pipsFor(7, 6)).toBe(6);
    expect(pipsFor(6, 6)).toBe(5);
    expect(pipsFor(8, 6)).toBe(5);
    expect(pipsFor(2, 6)).toBe(1);
    expect(pipsFor(12, 6)).toBe(1);
    expect(pipsFor(13, 6)).toBe(0);
    // Not a table: four-sided dice have their own distribution.
    expect(pipsFor(5, 4)).toBe(4);
  });
});

function midpoint(points: readonly { x: number; y: number }[]): { x: number; y: number } {
  const x = points.reduce((a, p) => a + p.x, 0) / points.length;
  const y = points.reduce((a, p) => a + p.y, 0) / points.length;
  return { x, y };
}
