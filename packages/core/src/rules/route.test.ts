import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { baseScenario34, island34 } from '../board/presets.js';
import { buildTopology, type Topology } from '../board/topology.js';
import { hexId } from '../coords/axial.js';
import { edgeId } from '../coords/edge.js';
import type { EdgeId, VertexId } from '../ids.js';
import { baseRouteRules, longestRoute } from './route.js';

const topology = buildTopology(baseScenario34().cells);

function ends(edge: EdgeId): readonly VertexId[] {
  const v = topology.edgeVertices.get(edge);
  if (v === undefined) throw new Error(`edge ${edge} not in topology`);
  return v;
}

/** Measure a route with base-game rules over an explicit edge set. */
function measure(owned: readonly EdgeId[], blocked: readonly VertexId[] = []): number {
  const ownedSet = new Set(owned);
  const blockedSet = new Set(blocked);
  return longestRoute(
    topology,
    baseRouteRules(
      (e) => ownedSet.has(e),
      (v) => !blockedSet.has(v),
    ),
  ).length;
}

// ── Independent reference ───────────────────────────────────────────────────────────────────
//
// Deliberately *not* another depth-first search. This decides trail-hood from Euler's theorem —
// a connected edge set admits a trail using all of its edges iff it has 0 or 2 odd-degree
// vertices — and takes the largest subset that qualifies. Two implementations sharing an approach
// would share its bugs; these two share nothing but the answer.

function isTrail(edges: readonly EdgeId[]): boolean {
  if (edges.length === 0) return false;

  const degree = new Map<VertexId, number>();
  for (const e of edges) {
    for (const v of ends(e)) degree.set(v, (degree.get(v) ?? 0) + 1);
  }
  const odd = [...degree.values()].filter((d) => d % 2 === 1).length;
  if (odd !== 0 && odd !== 2) return false;

  // Connected: walk the subgraph from one endpoint and check we reach every edge.
  const adjacency = new Map<VertexId, EdgeId[]>();
  for (const e of edges) {
    for (const v of ends(e)) adjacency.set(v, [...(adjacency.get(v) ?? []), e]);
  }
  const seenEdges = new Set<EdgeId>();
  const queue: VertexId[] = [ends(edges[0] as EdgeId)[0] as VertexId];
  const seenVertices = new Set<VertexId>(queue);
  while (queue.length > 0) {
    const v = queue.pop() as VertexId;
    for (const e of adjacency.get(v) ?? []) {
      seenEdges.add(e);
      for (const w of ends(e)) {
        if (!seenVertices.has(w)) {
          seenVertices.add(w);
          queue.push(w);
        }
      }
    }
  }
  return seenEdges.size === edges.length;
}

/** Largest subset of `owned` that forms a single trail. Exponential, hence small inputs only. */
function bruteForceLongestTrail(owned: readonly EdgeId[]): number {
  let best = 0;
  for (let mask = 1; mask < 1 << owned.length; mask++) {
    const subset = owned.filter((_, i) => (mask & (1 << i)) !== 0);
    if (subset.length > best && isTrail(subset)) best = subset.length;
  }
  return best;
}

/** Grow a connected network by random walk, which is what real road networks look like. */
function randomNetwork(seed: number, size: number): readonly EdgeId[] {
  let x = seed | 0;
  const rand = (n: number): number => {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    return Math.abs(x) % n;
  };

  const start = topology.edges[rand(topology.edges.length)] as EdgeId;
  const chosen = new Set<EdgeId>([start]);
  const frontier = new Set<VertexId>(ends(start));

  while (chosen.size < size) {
    const vs = [...frontier];
    if (vs.length === 0) break;
    const v = vs[rand(vs.length)] as VertexId;
    const options = (topology.vertexEdges.get(v) ?? []).filter((e) => !chosen.has(e));
    if (options.length === 0) {
      frontier.delete(v);
      continue;
    }
    const e = options[rand(options.length)] as EdgeId;
    chosen.add(e);
    for (const w of ends(e)) frontier.add(w);
  }
  return [...chosen];
}

describe('longestRoute', () => {
  it('is zero when the player owns nothing', () => {
    expect(measure([])).toBe(0);
  });

  it('counts a single segment', () => {
    const e = topology.edges[0] as EdgeId;
    expect(measure([e])).toBe(1);
  });

  it('counts a straight chain', () => {
    // Six borders radiating around the centre hex form a ring; take a path along part of it.
    const chain = chainFromCentre(4);
    expect(measure(chain)).toBe(4);
  });

  it('ignores forks, counting only the longest single branch', () => {
    // A vertex with all three of its borders owned: the best route uses two of them, not three.
    const v = ends(topology.edges[0] as EdgeId)[0] as VertexId;
    const spokes = topology.vertexEdges.get(v) ?? [];
    expect(spokes).toHaveLength(3);
    expect(measure(spokes)).toBe(2);
  });

  it('counts a full cycle around one hex', () => {
    const ring = topology.hexEdges.get(hexId({ q: 0, r: 0 })) ?? [];
    expect(ring).toHaveLength(6);
    expect(measure(ring)).toBe(6);
  });

  it('counts a cycle plus a tail leading out of it', () => {
    const centre = hexId({ q: 0, r: 0 });
    const ring = topology.hexEdges.get(centre) ?? [];
    // A border of a neighbouring hex that touches the ring but is not part of it.
    const junction = ends(ring[0] as EdgeId)[0] as VertexId;
    const tail = (topology.vertexEdges.get(junction) ?? []).find((e) => !ring.includes(e));
    expect(tail).toBeDefined();

    expect(measure([...ring, tail as EdgeId])).toBe(7);
  });

  /**
   * **The case that actually pins edge-disjoint semantics, and the reason this file exists.**
   *
   * Two adjacent hexes share a border, so their combined 11 segments form a theta: two
   * intersections of degree 3 joined by three independent paths (5, 5 and 1 segments long). Exactly
   * two odd-degree vertices, so a trail covers all 11.
   *
   * Covering them requires *continuing* through an intersection already visited — round one hex,
   * back through the junction, then across the shared border. A search that marks visited vertices
   * cannot do it and reports 10.
   *
   * Verified by mutation: replacing edge-marking with vertex-marking fails this test. It does *not*
   * fail the single-cycle or cycle-plus-tail tests above, because a closing segment gets counted
   * before the vertex check rejects going further — which is exactly why those two are regression
   * guards on the answer rather than proofs of the semantics. Nor does it fail the property tests,
   * whose networks cap out below the 11 segments this shape needs: the honeycomb has girth 6, so
   * the smallest shape that distinguishes the two readings is this one.
   */
  it('counts a theta network, continuing through an already-visited intersection', () => {
    const a = topology.hexEdges.get(hexId({ q: 0, r: 0 })) ?? [];
    const b = topology.hexEdges.get(hexId({ q: 1, r: 0 })) ?? [];
    const theta = [...new Set([...a, ...b])];
    expect(theta).toHaveLength(11);

    expect(measure(theta)).toBe(11);
    // And it agrees with the independent reference on the same shape.
    expect(bruteForceLongestTrail(theta)).toBe(11);
  });

  /** A dumbbell: two rings joined by a path, which also needs a revisit to cover fully. */
  it('counts two rings joined by a shared border, in full', () => {
    const a = topology.hexEdges.get(hexId({ q: 0, r: 0 })) ?? [];
    const b = topology.hexEdges.get(hexId({ q: 1, r: 0 })) ?? [];
    const c = topology.hexEdges.get(hexId({ q: 0, r: 1 })) ?? [];
    const network = [...new Set([...a, ...b, ...c])];
    expect(measure(network)).toBe(bruteForceLongestTrail(network));
  });

  describe('blocking', () => {
    it('stops a route passing through a blocked intersection', () => {
      const chain = chainFromCentre(4);
      // The intersection between the second and third segments.
      const between = sharedVertex(chain[1] as EdgeId, chain[2] as EdgeId);
      // Two segments either side, counted separately: the longer side wins.
      expect(measure(chain, [between])).toBe(2);
    });

    it('still counts a route that merely ends at a blocked intersection', () => {
      const chain = chainFromCentre(3);
      // The far end of the chain, which the route reaches but never passes through.
      const far = endpointOf(chain);
      expect(measure(chain, [far])).toBe(3);
    });

    it('counts both sides separately when a block splits a chain', () => {
      const chain = chainFromCentre(5);
      const between = sharedVertex(chain[1] as EdgeId, chain[2] as EdgeId);
      // Split into 2 and 3; the longest single route is 3.
      expect(measure(chain, [between])).toBe(3);
    });

    /**
     * A subtle one, and a case human players argue about: a closed loop through a blocked
     * intersection still counts in full.
     *
     * Blocking forbids passing *through*, and a route that starts and ends at the blocked
     * intersection never does — it leaves along one border and arrives back along another, with the
     * two uses at opposite ends of the route rather than consecutive.
     */
    it('counts a closed loop that begins and ends at a blocked intersection', () => {
      const ring = topology.hexEdges.get(hexId({ q: 0, r: 0 })) ?? [];
      const onRing = ends(ring[0] as EdgeId)[0] as VertexId;
      expect(measure(ring, [onRing])).toBe(6);
    });

    it('blocks nothing when the blocked intersection is not on the network', () => {
      const chain = chainFromCentre(4);
      const elsewhere = topology.vertices.find(
        (v) => !chain.some((e) => ends(e).includes(v)),
      ) as VertexId;
      expect(measure(chain, [elsewhere])).toBe(4);
    });
  });

  describe('against an independent brute-force reference', () => {
    /**
     * The reference decides trail-hood via Euler's theorem rather than by searching, so the two
     * implementations agree only if both are right.
     */
    it('matches on random connected networks', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 3000 }),
          fc.integer({ min: 1, max: 9 }),
          (seed, size) => {
            const network = randomNetwork(seed, size);
            expect(measure(network)).toBe(bruteForceLongestTrail(network));
          },
        ),
        { numRuns: 400 },
      );
    });

    /**
     * Larger networks, because the shapes that distinguish a trail from a vertex-simple path need
     * at least 11 segments on a honeycomb — see the theta test above. 15 is also the real ceiling:
     * a player never owns more than 15 roads.
     */
    it('matches on larger networks, where cycles and revisits appear', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1500 }),
          fc.integer({ min: 10, max: 15 }),
          (seed, size) => {
            const network = randomNetwork(seed, size);
            expect(measure(network)).toBe(bruteForceLongestTrail(network));
          },
        ),
        { numRuns: 120 },
      );
    });

    /** Networks built from whole hex rings, which is where cycles are guaranteed. */
    it('matches on networks built from complete hex rings', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.integer({ min: 0, max: 18 }), { minLength: 1, maxLength: 3 }),
          (hexIndices) => {
            const land = island34();
            const network = [
              ...new Set(
                hexIndices.flatMap((i) => topology.hexEdges.get(hexId(land[i] as never)) ?? []),
              ),
            ];
            expect(measure(network)).toBe(bruteForceLongestTrail(network));
          },
        ),
        { numRuns: 120 },
      );
    });

    it('matches on random unconnected scatterings of segments', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.integer({ min: 0, max: topology.edges.length - 1 }), {
            minLength: 1,
            maxLength: 8,
          }),
          (indices) => {
            const network = indices.map((i) => topology.edges[i] as EdgeId);
            expect(measure(network)).toBe(bruteForceLongestTrail(network));
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('the returned path', () => {
    it('is a walk of distinct segments, all owned, matching the reported length', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 2000 }), (seed) => {
          const network = randomNetwork(seed, 8);
          const owned = new Set(network);
          const route = longestRoute(
            topology,
            baseRouteRules(
              (e) => owned.has(e),
              () => true,
            ),
          );

          expect(route.path).toHaveLength(route.length);
          expect(new Set(route.path).size).toBe(route.path.length);
          for (const e of route.path) expect(owned.has(e)).toBe(true);

          // Consecutive segments share an intersection, i.e. it really is one continuous route.
          for (let i = 1; i < route.path.length; i++) {
            const a = ends(route.path[i - 1] as EdgeId);
            const b = ends(route.path[i] as EdgeId);
            expect(a.some((v) => b.includes(v))).toBe(true);
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('injected rules', () => {
    it('honours segment weights', () => {
      const chain = chainFromCentre(3);
      const owned = new Set(chain);
      const doubled = longestRoute(topology, {
        ownsEdge: (e) => owned.has(e),
        canTraverseVertex: () => true,
        canTransit: () => true,
        weight: () => 2,
      });
      expect(doubled.length).toBe(6);
      expect(doubled.path).toHaveLength(3);
    });

    /**
     * `canTransit` sees the pair of segments, not just the intersection. Seafarers needs exactly
     * this: joining a road to a shipping route requires your own settlement at the junction.
     */
    it('honours a transit rule that forbids a specific pair of segments', () => {
      const chain = chainFromCentre(4);
      const owned = new Set(chain);
      const forbiddenFrom = chain[1] as EdgeId;
      const forbiddenTo = chain[2] as EdgeId;

      const route = longestRoute(topology, {
        ownsEdge: (e) => owned.has(e),
        canTraverseVertex: () => true,
        canTransit: (from, _via, to) =>
          !(
            (from === forbiddenFrom && to === forbiddenTo) ||
            (from === forbiddenTo && to === forbiddenFrom)
          ),
        weight: () => 1,
      });
      // The chain is cut between segments 2 and 3, leaving 2 and 2.
      expect(route.length).toBe(2);
    });
  });
});

// ── Helpers for building specific shapes ────────────────────────────────────────────────────

/** A chain of `n` connected segments, grown greedily outward from the centre hex. */
function chainFromCentre(n: number): readonly EdgeId[] {
  const start = edgeId({ q: 0, r: 0 }, { q: 1, r: 0 });
  const chain: EdgeId[] = [start];
  let tip = ends(start)[1] as VertexId;
  const used = new Set<EdgeId>(chain);

  while (chain.length < n) {
    const next = (topology.vertexEdges.get(tip) ?? []).find((e) => !used.has(e));
    if (next === undefined) throw new Error(`chainFromCentre: ran out of room at ${chain.length}`);
    used.add(next);
    chain.push(next);
    tip = (ends(next).find((v) => v !== tip) ?? tip) as VertexId;
  }
  return chain;
}

function sharedVertex(a: EdgeId, b: EdgeId): VertexId {
  const v = ends(a).find((x) => ends(b).includes(x));
  if (v === undefined) throw new Error(`edges ${a} and ${b} do not meet`);
  return v;
}

/** An intersection touched by exactly one segment of the chain — one of its two loose ends. */
function endpointOf(chain: readonly EdgeId[]): VertexId {
  const counts = new Map<VertexId, number>();
  for (const e of chain) {
    for (const v of ends(e)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const v = [...counts].find(([, n]) => n === 1)?.[0];
  if (v === undefined) throw new Error('chain has no loose end');
  return v;
}

/** Guards the assumption the shape helpers rely on. */
export function _topologyForTests(): Topology {
  return topology;
}
