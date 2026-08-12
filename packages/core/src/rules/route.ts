/**
 * Longest-route search — the Longest Road metric.
 *
 * **This is the single most commonly mis-implemented rule in Catan.** The rulebook says "a
 * continuous road of at least 5 road segments ... not counting forks", which is a longest
 * **trail**: edges may not repeat, but *vertices may*. A network shaped like a cycle with a tail
 * has a trail that goes round the loop and out along the tail, passing through its starting
 * intersection a second time. The natural implementation — a depth-first search that marks visited
 * *vertices* — silently under-counts every such network, and will happily award the card to the
 * wrong player.
 *
 * So the search marks visited **edges** and never vertices.
 *
 * Blocking is checked on *transit*, not on arrival. An opponent's settlement, city (or, later, a
 * Cities & Knights knight) at an intermediate intersection stops a route passing through, but the
 * segments on either side still count separately, and a route may legitimately *end* there.
 *
 * Everything the rules layer varies is injected, so this file never grows a Seafarers or a Traders
 * & Barbarians special case:
 *
 * - `canTransit` decides a specific `edge -> vertex -> edge` turn. Base game defers to
 *   `canTraverseVertex`; Seafarers needs it because joining a road to a shipping route requires
 *   your own settlement at the junction, which is a property of the *pair* of edges, not of the
 *   vertex alone.
 * - `weight` scores each segment. Always 1 in the base game; a Traders & Barbarians road sharing a
 *   path with a camel counts 2.
 */

import type { Topology } from '../board/topology.js';
import type { EdgeId, VertexId } from '../ids.js';

export interface RouteRules {
  /** Whether this segment belongs to the player whose route is being measured. */
  ownsEdge(edge: EdgeId): boolean;
  /** Whether the player may pass *through* this intersection. */
  canTraverseVertex(vertex: VertexId): boolean;
  /** Whether the player may continue from `from` through `via` onto `to`. */
  canTransit(from: EdgeId, via: VertexId, to: EdgeId): boolean;
  /** Score for a segment. 1 in the base game. */
  weight(edge: EdgeId): number;
}

export interface Route {
  /** Total weight. With base-game weights this is the number of segments. */
  readonly length: number;
  /** The segments, in order along the route. Useful for highlighting it in the UI. */
  readonly path: readonly EdgeId[];
}

export const EMPTY_ROUTE: Route = { length: 0, path: [] };

/** Base-game defaults: every segment scores 1, and transit depends only on the intersection. */
export function baseRouteRules(
  ownsEdge: (edge: EdgeId) => boolean,
  canTraverseVertex: (vertex: VertexId) => boolean,
): RouteRules {
  return {
    ownsEdge,
    canTraverseVertex,
    canTransit: (_from, via, _to) => canTraverseVertex(via),
    weight: () => 1,
  };
}

/**
 * The player's longest continuous route.
 *
 * Exhaustive depth-first search from every endpoint of every owned segment. That is exponential in
 * general — longest-trail is NP-hard — but a player holds at most 15 roads (plus 15 ships later)
 * and an intersection has at most 3 borders, so the search space is trivially small. Being exact
 * matters more than being clever here: this metric is worth 2 victory points and can decide the
 * game.
 */
export function longestRoute(topology: Topology, rules: RouteRules): Route {
  const owned = topology.edges.filter((e) => rules.ownsEdge(e));
  if (owned.length === 0) return EMPTY_ROUTE;

  const used = new Set<EdgeId>();
  const path: EdgeId[] = [];
  let best = 0;
  let bestPath: readonly EdgeId[] = [];

  const walk = (fromVertex: VertexId, viaEdge: EdgeId, total: number): void => {
    if (total > best) {
      best = total;
      bestPath = [...path];
    }

    const ends = topology.edgeVertices.get(viaEdge);
    if (ends === undefined) return;
    const nextVertex = ends[0] === fromVertex ? ends[1] : ends[0];

    // Checked here rather than on arrival: a route may end at a blocked intersection, just not
    // continue through it.
    if (!rules.canTraverseVertex(nextVertex)) return;

    for (const onward of topology.vertexEdges.get(nextVertex) ?? []) {
      if (used.has(onward) || !rules.ownsEdge(onward)) continue;
      if (!rules.canTransit(viaEdge, nextVertex, onward)) continue;

      used.add(onward);
      path.push(onward);
      walk(nextVertex, onward, total + rules.weight(onward));
      path.pop();
      used.delete(onward);
    }
  };

  for (const start of owned) {
    for (const from of topology.edgeVertices.get(start) ?? []) {
      used.add(start);
      path.push(start);
      walk(from, start, rules.weight(start));
      path.pop();
      used.delete(start);
    }
  }

  return { length: best, path: bestPath };
}
