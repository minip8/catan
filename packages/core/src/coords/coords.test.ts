import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  compareHex,
  DIRECTIONS,
  type HexCoord,
  hexCountWithinRadius,
  hexDistance,
  hexId,
  hexRadius,
  neighbor,
  neighbors,
  parseHexId,
  ring,
  spiral,
} from './axial.js';
import {
  directionIndex,
  edgeEndpoints,
  edgeEndpointsOf,
  edgeId,
  hexEdges,
  parseEdgeId,
  vertexEdges,
  vertexNeighbors,
} from './edge.js';
import { hexToPixel, makeLayout, vertexToPixel } from './layout.js';
import { cornerHexes, hexCorners, parseVertexId, vertexId } from './vertex.js';

/** Small hexes, well inside safe integer range, for property tests. */
const arbHex = fc.record({
  q: fc.integer({ min: -20, max: 20 }),
  r: fc.integer({ min: -20, max: 20 }),
});

describe('axial coordinates', () => {
  it('round-trips hex ids', () => {
    fc.assert(
      fc.property(arbHex, (h) => {
        expect(parseHexId(hexId(h))).toEqual(h);
      }),
    );
  });

  it('has exactly six distinct neighbours, each one step away', () => {
    fc.assert(
      fc.property(arbHex, (h) => {
        const ns = neighbors(h);
        expect(new Set(ns.map(hexId)).size).toBe(6);
        for (const n of ns) expect(hexDistance(h, n)).toBe(1);
      }),
    );
  });

  it('neighbour relation is symmetric', () => {
    fc.assert(
      fc.property(arbHex, fc.integer({ min: 0, max: 5 }), (h, d) => {
        const n = neighbor(h, d);
        expect(neighbors(n).some((x) => x.q === h.q && x.r === h.r)).toBe(true);
      }),
    );
  });

  /**
   * The corner construction depends on this and nothing else. If `DIRECTIONS` were ever reordered
   * so that consecutive entries stopped touching, every vertex in the engine would silently become
   * a triple of hexes that do not actually meet at a point.
   */
  it('DIRECTIONS is in cyclic order — consecutive directions are themselves adjacent', () => {
    for (let i = 0; i < 6; i++) {
      const a = DIRECTIONS[i] as HexCoord;
      const b = DIRECTIONS[(i + 1) % 6] as HexCoord;
      expect(hexDistance(a, b)).toBe(1);
    }
  });

  it('ring(k) holds 6k hexes, all at radius k', () => {
    for (let k = 1; k <= 5; k++) {
      const r = ring(k);
      expect(r.length).toBe(6 * k);
      expect(new Set(r.map(hexId)).size).toBe(6 * k);
      for (const h of r) expect(hexRadius(h)).toBe(k);
    }
  });

  it('spiral(k) is the centred hexagonal number — 1, 7, 19, 37, 61', () => {
    expect(spiral(0).length).toBe(1);
    expect(spiral(1).length).toBe(7);
    // The base game board is exactly spiral(2).
    expect(spiral(2).length).toBe(19);
    expect(spiral(3).length).toBe(37);
    expect(spiral(4).length).toBe(61);
    for (let k = 0; k <= 5; k++) {
      expect(spiral(k).length).toBe(hexCountWithinRadius(k));
      expect(new Set(spiral(k).map(hexId)).size).toBe(hexCountWithinRadius(k));
    }
  });

  it('compareHex is a total order', () => {
    fc.assert(
      fc.property(arbHex, arbHex, (a, b) => {
        const ab = compareHex(a, b);
        const ba = compareHex(b, a);
        if (a.q === b.q && a.r === b.r) {
          expect(ab).toBe(0);
        } else {
          expect(Math.sign(ab)).toBe(-Math.sign(ba));
        }
      }),
    );
  });
});

describe('vertex identity', () => {
  it('round-trips vertex ids', () => {
    fc.assert(
      fc.property(arbHex, fc.integer({ min: 0, max: 5 }), (h, i) => {
        const v = vertexId(cornerHexes(h, i));
        const back = parseVertexId(v);
        expect(back.length).toBe(3);
        expect(vertexId(back)).toBe(v);
      }),
    );
  });

  /**
   * This is the property the whole encoding exists for. A vertex is touched by three hexes, and
   * each of them sees it as one of its own six corners. All three routes must produce the *same*
   * string, or pieces placed "from" different hexes would land on different vertices.
   */
  it('is canonical — all three touching hexes name the vertex identically', () => {
    for (const h of spiral(3)) {
      for (let i = 0; i < 6; i++) {
        const hexes = cornerHexes(h, i);
        const v = vertexId(hexes);
        for (const owner of hexes) {
          expect(hexCorners(owner)).toContain(v);
        }
      }
    }
  });

  it('is order-independent in its input', () => {
    fc.assert(
      fc.property(arbHex, fc.integer({ min: 0, max: 5 }), (h, i) => {
        const [a, b, c] = cornerHexes(h, i);
        const expected = vertexId([a, b, c]);
        for (const perm of [
          [a, c, b],
          [b, a, c],
          [b, c, a],
          [c, a, b],
          [c, b, a],
        ] as const) {
          expect(vertexId(perm)).toBe(expected);
        }
      }),
    );
  });

  it('gives every hex six distinct corners', () => {
    fc.assert(
      fc.property(arbHex, (h) => {
        expect(new Set(hexCorners(h)).size).toBe(6);
      }),
    );
  });

  it('names a vertex by three mutually adjacent hexes', () => {
    for (const h of spiral(2)) {
      for (let i = 0; i < 6; i++) {
        const [a, b, c] = cornerHexes(h, i);
        expect(hexDistance(a, b)).toBe(1);
        expect(hexDistance(b, c)).toBe(1);
        expect(hexDistance(a, c)).toBe(1);
      }
    }
  });
});

describe('edge identity', () => {
  it('round-trips and is order-independent', () => {
    fc.assert(
      fc.property(arbHex, fc.integer({ min: 0, max: 5 }), (h, d) => {
        const n = neighbor(h, d);
        expect(edgeId(h, n)).toBe(edgeId(n, h));
        const [a, b] = parseEdgeId(edgeId(h, n));
        expect(edgeId(a, b)).toBe(edgeId(h, n));
      }),
    );
  });

  it('gives every hex six distinct edges', () => {
    fc.assert(
      fc.property(arbHex, (h) => {
        expect(new Set(hexEdges(h)).size).toBe(6);
      }),
    );
  });

  it('directionIndex inverts neighbor, and reports -1 for non-neighbours', () => {
    fc.assert(
      fc.property(arbHex, fc.integer({ min: 0, max: 5 }), (h, d) => {
        expect(directionIndex(h, neighbor(h, d))).toBe(d);
      }),
    );
    expect(directionIndex({ q: 0, r: 0 }, { q: 0, r: 0 })).toBe(-1);
    expect(directionIndex({ q: 0, r: 0 }, { q: 2, r: 0 })).toBe(-1);
  });

  it('both endpoints of an edge contain both of its hexes', () => {
    fc.assert(
      fc.property(arbHex, fc.integer({ min: 0, max: 5 }), (h, d) => {
        const n = neighbor(h, d);
        const ends = edgeEndpointsOf(h, n);
        expect(ends[0]).not.toBe(ends[1]);
        for (const end of ends) {
          const ids = parseVertexId(end).map(hexId);
          expect(ids).toContain(hexId(h));
          expect(ids).toContain(hexId(n));
        }
      }),
    );
  });

  it('gives every vertex exactly three edges, and each edge has that vertex as an endpoint', () => {
    for (const h of spiral(2)) {
      for (const v of hexCorners(h)) {
        const es = vertexEdges(v);
        expect(new Set(es).size).toBe(3);
        for (const e of es) expect(edgeEndpoints(e)).toContain(v);
      }
    }
  });

  it('gives every vertex three neighbours, each sharing exactly two hexes with it', () => {
    for (const h of spiral(2)) {
      for (const v of hexCorners(h)) {
        const ns = vertexNeighbors(v);
        expect(new Set(ns).size).toBe(3);
        const mine = new Set(parseVertexId(v).map(hexId));
        for (const n of ns) {
          expect(n).not.toBe(v);
          const shared = parseVertexId(n)
            .map(hexId)
            .filter((x) => mine.has(x));
          expect(shared.length).toBe(2);
        }
      }
    }
  });

  it('vertex adjacency is symmetric', () => {
    for (const h of spiral(2)) {
      for (const v of hexCorners(h)) {
        for (const n of vertexNeighbors(v)) {
          expect(vertexNeighbors(n)).toContain(v);
        }
      }
    }
  });
});

describe('layout', () => {
  const layout = makeLayout(10);

  it('places a vertex exactly one circumradius from each of its three hex centres', () => {
    fc.assert(
      fc.property(arbHex, fc.integer({ min: 0, max: 5 }), (h, i) => {
        const hexes = cornerHexes(h, i);
        const v = vertexToPixel(layout, vertexId(hexes));
        for (const hx of hexes) {
          const c = hexToPixel(layout, hx);
          expect(Math.hypot(v.x - c.x, v.y - c.y)).toBeCloseTo(layout.size, 6);
        }
      }),
    );
  });

  it('places adjacent hex centres one edge-spacing apart', () => {
    // For a regular grid with circumradius `size`, centres of neighbours are `sqrt(3) * size` apart.
    const expected = Math.sqrt(3) * layout.size;
    for (const orientation of ['pointy', 'flat'] as const) {
      const l = makeLayout(10, orientation);
      for (let d = 0; d < 6; d++) {
        const a = hexToPixel(l, { q: 0, r: 0 });
        const b = hexToPixel(l, neighbor({ q: 0, r: 0 }, d));
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(expected, 6);
      }
    }
  });

  it('gives distinct pixel positions to distinct vertices', () => {
    const seen = new Map<string, string>();
    for (const h of spiral(2)) {
      for (const v of hexCorners(h)) {
        const p = vertexToPixel(layout, v);
        const key = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
        const prior = seen.get(key);
        if (prior !== undefined) expect(prior).toBe(v);
        seen.set(key, v);
      }
    }
  });
});
