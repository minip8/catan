/**
 * Edge (path) identity, and the vertex-to-edge relations that are defined in terms of edges.
 *
 * An edge is named by **the two hexes it separates**, sorted. Two adjacent hexes share exactly one
 * border, so this is canonical for the same reason the vertex triple is.
 *
 * Naming edges by hexes rather than by their two endpoint vertices is a deliberate choice:
 *
 * - Placement legality is a function of the **flanking terrain**. A land/land border takes a road;
 *   a sea/sea border takes a ship; a coastal border takes one or the other. With hex keys that is
 *   a direct lookup instead of "find the endpoints, then find the hexes around both, then
 *   intersect".
 * - "This hex's six borders" — which is how the pirate blocks shipping — is one lookup.
 *
 * `edgeVertices` is still stored by the topology builder, because route-finding walks vertices.
 */

import type { EdgeId, VertexId } from '../ids.js';
import {
  compareHex,
  DIRECTION_COUNT,
  DIRECTIONS,
  type HexCoord,
  hexEquals,
  hexId,
  neighbor,
  parseHexId,
} from './axial.js';
import { parseVertexId, type VertexHexes, vertexId } from './vertex.js';

/** The two hexes an edge separates, in canonical (sorted) order. */
export type EdgeHexes = readonly [HexCoord, HexCoord];

export function edgeId(a: HexCoord, b: HexCoord): EdgeId {
  const [first, second] = compareHex(a, b) <= 0 ? [a, b] : [b, a];
  return `${hexId(first)}|${hexId(second)}` as EdgeId;
}

export function parseEdgeId(id: EdgeId): EdgeHexes {
  const parts = id.split('|');
  if (parts.length !== 2) {
    throw new Error(`parseEdgeId: expected 2 hexes, got ${JSON.stringify(id)}`);
  }
  return parts.map((p) => parseHexId(p as never)) as unknown as EdgeHexes;
}

/** All six borders of a hex, in cyclic order. */
export function hexEdges(h: HexCoord): readonly EdgeId[] {
  return DIRECTIONS.map((_, i) => edgeId(h, neighbor(h, i)));
}

/**
 * The direction index `i` such that `to === from + DIRECTIONS[i]`, or `-1` if not adjacent.
 */
export function directionIndex(from: HexCoord, to: HexCoord): number {
  for (let i = 0; i < DIRECTION_COUNT; i++) {
    if (hexEquals(neighbor(from, i), to)) return i;
  }
  return -1;
}

/**
 * The two vertices at the ends of the border between adjacent hexes `a` and `b`.
 *
 * Both endpoints contain `a` and `b`; they differ in the third hex, which is the neighbour on
 * either side of the shared border.
 */
export function edgeEndpointsOf(a: HexCoord, b: HexCoord): readonly [VertexId, VertexId] {
  const i = directionIndex(a, b);
  if (i < 0) {
    throw new Error(`edgeEndpointsOf: ${hexId(a)} and ${hexId(b)} are not adjacent`);
  }
  // Corner (i-1) and corner (i) of `a` are precisely the two corners bordering neighbour i.
  return [
    vertexId([a, b, neighbor(a, i - 1 + DIRECTION_COUNT)]),
    vertexId([a, b, neighbor(a, i + 1)]),
  ];
}

export function edgeEndpoints(edge: EdgeId): readonly [VertexId, VertexId] {
  const [a, b] = parseEdgeId(edge);
  return edgeEndpointsOf(a, b);
}

/**
 * The three edges meeting at a vertex.
 *
 * A vertex is three mutually-adjacent hexes, so it has exactly three borders radiating from it:
 * one for each pair.
 */
export function vertexEdgesOf(hexes: VertexHexes): readonly [EdgeId, EdgeId, EdgeId] {
  const [a, b, c] = hexes;
  return [edgeId(a, b), edgeId(b, c), edgeId(a, c)];
}

export function vertexEdges(vertex: VertexId): readonly [EdgeId, EdgeId, EdgeId] {
  return vertexEdgesOf(parseVertexId(vertex));
}

/**
 * The three vertices one step away from `vertex` — the other endpoint of each of its edges.
 *
 * This is the adjacency the **distance rule** uses. Note that it is vertex adjacency along the
 * graph, not hex adjacency and not Euclidean proximity: two vertices facing each other across a
 * sea border are neighbours, which is correct — a settlement on a new island still has to respect
 * the distance rule against one across the water.
 */
export function vertexNeighborsOf(hexes: VertexHexes): readonly VertexId[] {
  const self = vertexId(hexes);
  const out: VertexId[] = [];
  for (const edge of vertexEdgesOf(hexes)) {
    for (const end of edgeEndpoints(edge)) {
      if (end !== self) out.push(end);
    }
  }
  return out;
}

export function vertexNeighbors(vertex: VertexId): readonly VertexId[] {
  return vertexNeighborsOf(parseVertexId(vertex));
}
