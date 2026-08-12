/**
 * Vertex (intersection) identity.
 *
 * A vertex is named by **the three hexes that touch it**, sorted, on the infinite lattice. This is
 * the single most important encoding decision in the engine, so the reasoning is worth stating:
 *
 * - It is **canonical**. Three hexes touch a vertex, and each of them can reach it as one of its
 *   six corners. Naming the vertex by the sorted set means all three routes produce the same id,
 *   with no "which hex owns this corner" tie-breaking rule to get wrong.
 * - It is **total**, because the lattice is infinite. The id does not depend on which cells the
 *   scenario happens to declare. Coastal vertices, vertices between two islands, and vertices
 *   whose terrain has not been revealed yet all encode identically to inland ones.
 * - It is **stable**. Ids never need rewriting when the board changes — which matters because
 *   pieces, harbours and saved replays all refer to vertices by id.
 *
 * The alternative — offsetting from a single "owning" hex — needs a special case for every board
 * edge, and breaks outright on a board with more than one island.
 */

import type { VertexId } from '../ids.js';
import {
  compareHex,
  DIRECTION_COUNT,
  type HexCoord,
  hexId,
  neighbor,
  parseHexId,
} from './axial.js';

/** The three hexes meeting at a vertex, in canonical (sorted) order. */
export type VertexHexes = readonly [HexCoord, HexCoord, HexCoord];

/**
 * Build a vertex id from the three hexes touching it, in any order.
 *
 * Does not verify that the three hexes are mutually adjacent — the callers here construct them
 * from `DIRECTIONS`, which guarantees it. The topology builder validates the resulting graph.
 */
export function vertexId(hexes: VertexHexes): VertexId {
  const sorted = [...hexes].sort(compareHex);
  return `${hexId(sorted[0] as HexCoord)}|${hexId(sorted[1] as HexCoord)}|${hexId(
    sorted[2] as HexCoord,
  )}` as VertexId;
}

export function parseVertexId(id: VertexId): VertexHexes {
  const parts = id.split('|');
  if (parts.length !== 3) {
    throw new Error(`parseVertexId: expected 3 hexes, got ${JSON.stringify(id)}`);
  }
  return parts.map((p) => parseHexId(p as never)) as unknown as VertexHexes;
}

/**
 * The three hexes forming corner `i` of hex `h`.
 *
 * Corner `i` sits between neighbour `i` and neighbour `i + 1`. Because `DIRECTIONS` is in cyclic
 * order, those two neighbours are adjacent to each other as well as to `h`, so the three hexes
 * genuinely meet at a point.
 */
export function cornerHexes(h: HexCoord, i: number): VertexHexes {
  return [h, neighbor(h, i), neighbor(h, i + 1)];
}

/** All six corners of a hex, in cyclic order. */
export function hexCorners(h: HexCoord): readonly VertexId[] {
  const out: VertexId[] = [];
  for (let i = 0; i < DIRECTION_COUNT; i++) out.push(vertexId(cornerHexes(h, i)));
  return out;
}
