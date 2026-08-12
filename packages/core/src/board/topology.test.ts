import { describe, expect, it } from 'vitest';

import { type HexCoord, hexDistance, hexId, spiral } from '../coords/axial.js';
import { edgeEndpoints, edgeId, vertexEdges } from '../coords/edge.js';
import { parseVertexId } from '../coords/vertex.js';
import type { EdgeId, HexId } from '../ids.js';
import type { CellPlacement } from './scenario.js';
import { seaRingAround, withSeaRing } from './scenario.js';
import { buildTopology, hasEdge, otherEndOfEdge, ScenarioError } from './topology.js';

/** The edge between two hexes, or `undefined` if they are not adjacent. */
function edgeIdOf(a: HexCoord, b: HexCoord): EdgeId | undefined {
  return hexDistance(a, b) === 1 ? edgeId(a, b) : undefined;
}

/** The base-game island: 19 land hexes in a radius-2 hexagon, wrapped in sea. */
function baseIsland(): readonly CellPlacement[] {
  return withSeaRing(
    spiral(2).map(({ q, r }) => ({ q, r, cell: { kind: 'land', terrain: 'fields' } as const })),
  );
}

describe('buildTopology', () => {
  /**
   * The headline check. 19 hexes / 54 intersections / 72 paths are the published counts for a
   * Catan board, so if the encoding or the existence rules were wrong these numbers would move.
   */
  it('reproduces the published counts for the base board: 19 hexes, 54 intersections, 72 paths', () => {
    const topology = buildTopology(baseIsland());
    const land = new Set<HexId>(spiral(2).map(hexId));

    expect(land.size).toBe(19);

    const touchesLand = (ids: readonly HexId[]): boolean => ids.some((h) => land.has(h));

    const landVertices = topology.vertices.filter((v) =>
      touchesLand(topology.vertexHexes.get(v) ?? []),
    );
    const landEdges = topology.edges.filter((e) => touchesLand(topology.edgeHexes.get(e) ?? []));

    expect(landVertices.length).toBe(54);
    expect(landEdges.length).toBe(72);
  });

  it('gives every land hex exactly 6 corners and 6 borders', () => {
    const topology = buildTopology(baseIsland());
    for (const h of spiral(2)) {
      expect(topology.hexVertices.get(hexId(h))).toHaveLength(6);
      expect(topology.hexEdges.get(hexId(h))).toHaveLength(6);
    }
  });

  /**
   * This is the error that would otherwise produce a board with silently unreachable
   * intersections — easy to miss by eye, so it must fail loudly at build time.
   */
  it('rejects an island that is not wrapped in sea', () => {
    const bare = spiral(2).map(({ q, r }) => ({
      q,
      r,
      cell: { kind: 'land', terrain: 'fields' } as const,
    }));
    expect(() => buildTopology(bare)).toThrow(ScenarioError);
    expect(() => buildTopology(bare)).toThrow(/not fully surrounded/);
  });

  it('rejects a duplicated cell', () => {
    expect(() =>
      buildTopology([
        { q: 0, r: 0, cell: { kind: 'sea' } },
        { q: 0, r: 0, cell: { kind: 'sea' } },
      ]),
    ).toThrow(/declared more than once/);
  });

  it('rejects an empty scenario', () => {
    expect(() => buildTopology([])).toThrow(/no solid cells/);
    expect(() => buildTopology([{ q: 0, r: 0, cell: { kind: 'void' } }])).toThrow(/no solid cells/);
  });

  it('excludes void cells from the graph, and suppresses vertices that would touch them', () => {
    // A single land hex ringed by sea, except one neighbour is an explicit hole.
    const cells: CellPlacement[] = [
      { q: 0, r: 0, cell: { kind: 'sea' } },
      ...seaRingAround([{ q: 0, r: 0 }]).map(({ q, r }) => ({
        q,
        r,
        cell: { kind: 'sea' } as const,
      })),
    ];
    const holed = cells.map((c) =>
      c.q === 1 && c.r === 0 ? { ...c, cell: { kind: 'void' } as const } : c,
    );
    const topology = buildTopology(holed);

    expect(topology.hexes).not.toContain(hexId({ q: 1, r: 0 }));
    // The centre keeps only the corners that avoid the hole: two of its six corners touch it.
    expect(topology.hexVertices.get(hexId({ q: 0, r: 0 }))).toHaveLength(4);
  });

  describe('structural invariants hold across the whole graph', () => {
    const topology = buildTopology(baseIsland());

    const land = new Set<HexId>(spiral(2).map(hexId));
    const isLandVertex = (v: string): boolean =>
      (topology.vertexHexes.get(v as never) ?? []).some((h) => land.has(h));

    it('every vertex has exactly 3 hexes', () => {
      for (const v of topology.vertices) {
        expect(topology.vertexHexes.get(v)).toHaveLength(3);
      }
    });

    /**
     * The property placement actually depends on — and note it is weaker than "3 edges".
     *
     * A coastal land vertex can have only two borders: its third is the sea-sea edge between the
     * two water hexes flanking it, and at the rim that edge is pruned. That is harmless, because
     * the two borders that touch land are exactly the ones a road can use.
     */
    it('every vertex touching land has at least one land-touching border', () => {
      for (const v of topology.vertices) {
        if (!isLandVertex(v)) continue;
        const es = topology.vertexEdges.get(v) ?? [];
        const landBorders = es.filter((e) =>
          (topology.edgeHexes.get(e) ?? []).some((h) => land.has(h)),
        );
        expect(landBorders.length).toBeGreaterThanOrEqual(1);
      }
    });

    /** Conversely, every border of a land hex does exist — no road position is ever missing. */
    it('every border of a land hex exists', () => {
      for (const h of spiral(2)) {
        const es = topology.hexEdges.get(hexId(h)) ?? [];
        expect(es).toHaveLength(6);
        for (const e of es) expect(hasEdge(topology, e)).toBe(true);
      }
    });

    it('every vertex has at most 3 edges, and at least 2', () => {
      for (const v of topology.vertices) {
        const n = (topology.vertexEdges.get(v) ?? []).length;
        expect(n).toBeGreaterThanOrEqual(2);
        expect(n).toBeLessThanOrEqual(3);
      }
    });

    it('every edge has exactly 2 hexes and 2 vertices', () => {
      for (const e of topology.edges) {
        expect(topology.edgeHexes.get(e)).toHaveLength(2);
        expect(topology.edgeVertices.get(e)).toHaveLength(2);
      }
    });

    it('every id in an adjacency map exists in the graph', () => {
      for (const v of topology.vertices) {
        for (const h of topology.vertexHexes.get(v) ?? [])
          expect(topology.hexAxial.has(h)).toBe(true);
        for (const e of topology.vertexEdges.get(v) ?? [])
          expect(topology.edgeHexes.has(e)).toBe(true);
        for (const n of topology.vertexNeighbors.get(v) ?? [])
          expect(topology.vertexHexes.has(n)).toBe(true);
      }
      for (const e of topology.edges) {
        for (const h of topology.edgeHexes.get(e) ?? [])
          expect(topology.hexAxial.has(h)).toBe(true);
        for (const v of topology.edgeVertices.get(e) ?? [])
          expect(topology.vertexHexes.has(v)).toBe(true);
      }
    });

    it('vertex/edge incidence agrees in both directions', () => {
      for (const v of topology.vertices) {
        for (const e of topology.vertexEdges.get(v) ?? []) {
          expect(topology.edgeVertices.get(e)).toContain(v);
        }
      }
      for (const e of topology.edges) {
        for (const v of topology.edgeVertices.get(e) ?? []) {
          expect(topology.vertexEdges.get(v)).toContain(e);
        }
      }
    });

    it('vertex adjacency is symmetric and matches walking an edge', () => {
      for (const v of topology.vertices) {
        for (const n of topology.vertexNeighbors.get(v) ?? []) {
          expect(topology.vertexNeighbors.get(n)).toContain(v);
        }
        for (const e of topology.vertexEdges.get(v) ?? []) {
          const other = otherEndOfEdge(topology, e, v);
          expect(other).toBeDefined();
          expect(topology.vertexNeighbors.get(v)).toContain(other);
        }
      }
    });

    /**
     * Neighbours are derived from surviving edges, so "is a neighbour" and "is one edge away" are
     * the same relation by construction. A board where they differed would let the distance rule
     * and road connectivity disagree about the same pair of intersections.
     */
    it('has exactly one neighbour per edge at every vertex', () => {
      for (const v of topology.vertices) {
        expect(topology.vertexNeighbors.get(v)).toHaveLength(
          (topology.vertexEdges.get(v) ?? []).length,
        );
      }
    });

    /**
     * The pure coordinate helpers describe the infinite lattice; the topology is the declared
     * subset of it. So the topology's edges at a vertex must be a *subset* of the lattice's three,
     * never a different set — a mismatch would mean the builder invented an edge the geometry does
     * not have.
     */
    it('agrees with the pure coordinate helpers, holding a subset of the lattice', () => {
      for (const v of topology.vertices) {
        const lattice = new Set<string>(vertexEdges(v));
        for (const e of topology.vertexEdges.get(v) ?? []) {
          expect(lattice).toContain(e);
        }
        expect(new Set(topology.vertexHexes.get(v))).toEqual(new Set(parseVertexId(v).map(hexId)));
      }
      // Edges, by contrast, always carry both endpoints, so these agree exactly.
      for (const e of topology.edges) {
        expect(new Set(topology.edgeVertices.get(e))).toEqual(new Set(edgeEndpoints(e)));
      }
    });

    /** Rule 3: an edge only exists when both its endpoints do. */
    it('has no edge with a missing endpoint', () => {
      for (const e of topology.edges) {
        for (const v of edgeEndpoints(e)) {
          expect(topology.vertexHexes.has(v)).toBe(true);
        }
      }
    });

    /**
     * The graph is genuinely bounded rather than trailing off. Two adjacent sea hexes on the outer
     * ring share a border whose far endpoint would need a radius-4 hex, so it is pruned — which is
     * also what the rulebook says, since two frame pieces meeting is not a path.
     */
    it('prunes sea-sea borders on the outer rim', () => {
      const rim = spiral(3).filter(
        (h) => Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(-h.q - h.r)) === 3,
      );
      const pruned = rim.filter((h) =>
        // A rim hex's border with the next rim hex round the ring.
        rim.some((other) => {
          const e = edgeIdOf(h, other);
          return e !== undefined && !hasEdge(topology, e);
        }),
      );
      expect(pruned.length).toBeGreaterThan(0);
    });
  });

  it('is frozen', () => {
    const topology = buildTopology(baseIsland());
    expect(Object.isFrozen(topology)).toBe(true);
  });
});
