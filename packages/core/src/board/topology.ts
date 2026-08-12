/**
 * The board graph.
 *
 * `Topology` is built once from a `Scenario` and then **frozen**. It holds ids and adjacency and
 * nothing else — no terrain, no number tokens, no pieces, no ownership. Those are mutable state
 * (`HexState`, `Board`), and keeping them out of the graph is what lets Cities & Knights swap two
 * number tokens, Traders & Barbarians hide them, and Seafarers reveal terrain mid-game without any
 * of it touching this layer.
 *
 * Because every relation is precomputed here, runtime rule checks — the distance rule, road
 * connectivity, production lookup — are `Map` reads rather than graph walks.
 */

import { compareHex, type HexCoord, hexId, neighbor, parseHexId } from '../coords/axial.js';
import { edgeEndpointsOf, edgeId, vertexEdgesOf } from '../coords/edge.js';
import { cornerHexes, parseVertexId, vertexId } from '../coords/vertex.js';
import type { EdgeId, HexId, VertexId } from '../ids.js';
import type { Cell, CellPlacement } from './scenario.js';

export interface Topology {
  readonly hexes: readonly HexId[];
  readonly vertices: readonly VertexId[];
  readonly edges: readonly EdgeId[];

  readonly hexAxial: ReadonlyMap<HexId, HexCoord>;
  /** In cyclic order. Exactly 6 for any hex fully surrounded by declared cells. */
  readonly hexVertices: ReadonlyMap<HexId, readonly VertexId[]>;
  /** In cyclic order. Exactly 6 for any hex fully surrounded by declared cells. */
  readonly hexEdges: ReadonlyMap<HexId, readonly EdgeId[]>;

  /** Always exactly 3 — a vertex is defined by its three hexes. */
  readonly vertexHexes: ReadonlyMap<VertexId, readonly HexId[]>;
  /**
   * Up to 3, and **2 is normal for a coastal vertex** — including one that touches land.
   *
   * A coastal vertex's third border is the sea-sea edge between the two water hexes flanking it,
   * and out at the rim that edge's far endpoint lies outside the declared area, so rule 3 prunes
   * it. Harmless: the borders that touch land are exactly the ones a road can occupy, and those
   * always exist because a land cell has all six of its own borders.
   */
  readonly vertexEdges: ReadonlyMap<VertexId, readonly EdgeId[]>;
  /**
   * Up to 3 — always the same count as `vertexEdges`, since neighbours are derived from them.
   * This is the adjacency the **distance rule** uses.
   */
  readonly vertexNeighbors: ReadonlyMap<VertexId, readonly VertexId[]>;

  /** Always exactly 2. */
  readonly edgeHexes: ReadonlyMap<EdgeId, readonly HexId[]>;
  /** Always exactly 2 — see the existence rule below. */
  readonly edgeVertices: ReadonlyMap<EdgeId, readonly [VertexId, VertexId]>;
}

export class ScenarioError extends Error {}

/**
 * Whether a declared cell participates in the graph.
 *
 * `void` is declared but explicitly a hole, so it suppresses vertices exactly as an undeclared
 * position does.
 */
function isSolid(cell: Cell | undefined): boolean {
  return cell !== undefined && cell.kind !== 'void';
}

/**
 * Build the graph from a scenario's cells.
 *
 * Existence rules, in dependency order:
 *
 * 1. A **hex** exists if it is declared and is not `void`.
 * 2. A **vertex** exists if all three of its lattice hexes exist. (This is why sea must be
 *    declared: a coastal intersection's other two hexes are water.)
 * 3. An **edge** exists if both its hexes exist *and both its endpoint vertices exist*.
 *
 * Rule 3's second clause prunes the degenerate borders on the outer rim of the declared area,
 * where one endpoint would need a hex nobody declared. Without it, `edgeVertices` would sometimes
 * hold one vertex instead of two and every consumer would need a special case for it. Any scenario
 * that genuinely wants shipping lanes at its rim simply declares one more ring of sea.
 */
export function buildTopology(cells: readonly CellPlacement[]): Topology {
  const declared = new Map<HexId, Cell>();
  for (const { q, r, cell } of cells) {
    const id = hexId({ q, r });
    if (declared.has(id)) {
      throw new ScenarioError(`buildTopology: cell ${id} declared more than once`);
    }
    declared.set(id, cell);
  }

  const hexAxial = new Map<HexId, HexCoord>();
  for (const [id, cell] of declared) {
    if (isSolid(cell)) hexAxial.set(id, parseHexId(id));
  }
  if (hexAxial.size === 0) {
    throw new ScenarioError('buildTopology: scenario declares no solid cells');
  }

  const exists = (h: HexCoord): boolean => hexAxial.has(hexId(h));

  // ── Vertices ──
  const vertexHexes = new Map<VertexId, readonly HexId[]>();
  for (const h of hexAxial.values()) {
    for (let i = 0; i < 6; i++) {
      const corner = cornerHexes(h, i);
      if (!corner.every(exists)) continue;
      const v = vertexId(corner);
      if (!vertexHexes.has(v)) {
        vertexHexes.set(v, parseVertexId(v).map(hexId));
      }
    }
  }

  // ── Edges ──
  const edgeHexes = new Map<EdgeId, readonly HexId[]>();
  const edgeVertices = new Map<EdgeId, readonly [VertexId, VertexId]>();
  for (const h of hexAxial.values()) {
    for (let i = 0; i < 6; i++) {
      const other = neighbor(h, i);
      if (!exists(other)) continue;
      const e = edgeId(h, other);
      if (edgeHexes.has(e)) continue;
      const [v0, v1] = edgeEndpointsOf(h, other);
      if (!vertexHexes.has(v0) || !vertexHexes.has(v1)) continue;
      // Stored in the same canonical order the id encodes, so `edgeHexes` and the id agree.
      const [a, b] = compareHex(h, other) <= 0 ? [h, other] : [other, h];
      edgeHexes.set(e, [hexId(a), hexId(b)]);
      edgeVertices.set(e, [v0, v1]);
    }
  }

  // ── Vertex-to-edge and vertex-to-vertex ──
  const vertexEdgesMap = new Map<VertexId, readonly EdgeId[]>();
  const vertexNeighborsMap = new Map<VertexId, readonly VertexId[]>();
  for (const v of vertexHexes.keys()) {
    const hexes = parseVertexId(v);
    // May be fewer than 3 at the rim: the vertex itself exists, but one of its borders is a
    // sea-sea edge whose *far* endpoint needs a hex nobody declared, so rule 3 pruned it. That is
    // faithful — two frame pieces meeting is not a path — and it never affects a land vertex.
    const es = vertexEdgesOf(hexes).filter((e) => edgeHexes.has(e));
    vertexEdgesMap.set(v, es);

    // Derived from the surviving edges rather than filtered independently, so "is a neighbour" and
    // "is reachable along an edge" cannot drift apart. A neighbour you cannot walk to is not one.
    vertexNeighborsMap.set(
      v,
      es.map((e) => {
        const ends = edgeVertices.get(e) as readonly [VertexId, VertexId];
        return ends[0] === v ? ends[1] : ends[0];
      }),
    );
  }

  // ── Hex-to-vertex and hex-to-edge, in cyclic order ──
  const hexVertices = new Map<HexId, readonly VertexId[]>();
  const hexEdgesMap = new Map<HexId, readonly EdgeId[]>();
  for (const [id, h] of hexAxial) {
    const vs: VertexId[] = [];
    const es: EdgeId[] = [];
    for (let i = 0; i < 6; i++) {
      const v = vertexId(cornerHexes(h, i));
      if (vertexHexes.has(v)) vs.push(v);
      const e = edgeId(h, neighbor(h, i));
      if (edgeHexes.has(e)) es.push(e);
    }
    hexVertices.set(id, vs);
    hexEdgesMap.set(id, es);
  }

  const topology: Topology = Object.freeze({
    hexes: Object.freeze([...hexAxial.keys()]),
    vertices: Object.freeze([...vertexHexes.keys()]),
    edges: Object.freeze([...edgeHexes.keys()]),
    hexAxial,
    hexVertices,
    hexEdges: hexEdgesMap,
    vertexHexes,
    vertexEdges: vertexEdgesMap,
    vertexNeighbors: vertexNeighborsMap,
    edgeHexes,
    edgeVertices,
  });

  validateLandIsEnclosed(topology, declared);
  return topology;
}

/**
 * Every land cell must have all six corners and all six borders.
 *
 * A land hex missing a corner means the scenario forgot to declare a neighbouring sea cell, which
 * would silently produce a board with an unreachable intersection — a bug that is very hard to
 * spot by looking at a rendered board but trivial to catch here.
 */
function validateLandIsEnclosed(topology: Topology, declared: ReadonlyMap<HexId, Cell>): void {
  for (const [id, cell] of declared) {
    if (cell.kind !== 'land' && cell.kind !== 'unexplored') continue;
    const vs = topology.hexVertices.get(id) ?? [];
    const es = topology.hexEdges.get(id) ?? [];
    if (vs.length !== 6 || es.length !== 6) {
      throw new ScenarioError(
        `buildTopology: ${cell.kind} cell ${id} has ${vs.length} corners and ${es.length} borders, ` +
          'expected 6 and 6 — it is not fully surrounded by declared cells. ' +
          'Wrap the island in a sea ring (see withSeaRing).',
      );
    }
    // Every corner of a land cell must have at least one border that also touches land — that is
    // what guarantees a settlement placed there can be reached by a road.
    //
    // Note the weaker claim: a corner of a land cell can legitimately have only *two* borders. Its
    // third is the sea-sea edge between the two water hexes flanking it, and at the rim that edge's
    // far endpoint lies outside the declared area. Both of its land-touching borders always exist,
    // because this cell has all six of its own.
    for (const v of vs) {
      const ve = topology.vertexEdges.get(v) ?? [];
      const reachable = ve.some((e) =>
        (topology.edgeHexes.get(e) ?? []).some((h) => {
          const c = declared.get(h);
          return c !== undefined && (c.kind === 'land' || c.kind === 'unexplored');
        }),
      );
      if (!reachable) {
        throw new ScenarioError(
          `buildTopology: vertex ${v} on ${cell.kind} cell ${id} has no border touching land, ` +
            'so nothing built there could ever be connected',
        );
      }
    }
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────────────────────

export function hexVerticesOf(topology: Topology, hex: HexId): readonly VertexId[] {
  return topology.hexVertices.get(hex) ?? [];
}

export function vertexHexesOf(topology: Topology, vertex: VertexId): readonly HexId[] {
  return topology.vertexHexes.get(vertex) ?? [];
}

export function edgeVerticesOf(topology: Topology, edge: EdgeId): readonly VertexId[] {
  return topology.edgeVertices.get(edge) ?? [];
}

export function edgeHexesOf(topology: Topology, edge: EdgeId): readonly HexId[] {
  return topology.edgeHexes.get(edge) ?? [];
}

export function vertexEdgesOfTopology(topology: Topology, vertex: VertexId): readonly EdgeId[] {
  return topology.vertexEdges.get(vertex) ?? [];
}

export function vertexNeighborsOfTopology(
  topology: Topology,
  vertex: VertexId,
): readonly VertexId[] {
  return topology.vertexNeighbors.get(vertex) ?? [];
}

/** The two hexes an edge separates — `undefined` if the edge is not in this topology. */
export function otherEndOfEdge(
  topology: Topology,
  edge: EdgeId,
  from: VertexId,
): VertexId | undefined {
  const ends = topology.edgeVertices.get(edge);
  if (ends === undefined) return undefined;
  if (ends[0] === from) return ends[1];
  if (ends[1] === from) return ends[0];
  return undefined;
}

export function hasVertex(topology: Topology, vertex: VertexId): boolean {
  return topology.vertexHexes.has(vertex);
}

export function hasEdge(topology: Topology, edge: EdgeId): boolean {
  return topology.edgeHexes.has(edge);
}

export function hasHex(topology: Topology, hex: HexId): boolean {
  return topology.hexAxial.has(hex);
}
