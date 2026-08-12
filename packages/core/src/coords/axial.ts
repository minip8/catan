/**
 * Axial hex coordinates.
 *
 * `q` and `r` are two of the three cube axes; the third is implied by `q + r + s = 0`. All
 * arithmetic here is exact integer arithmetic — **there is no floating point anywhere in the
 * topology layer.** Pixel positions are a rendering concern and live in `layout.ts`.
 *
 * Orientation (pointy-top vs flat-top) is deliberately *not* represented here. The adjacency graph
 * is identical either way; orientation only changes where things are drawn, so it is a parameter
 * of `layout.ts` alone.
 */

import type { HexId } from '../ids.js';

export interface HexCoord {
  readonly q: number;
  readonly r: number;
}

/**
 * The six neighbour offsets **in cyclic order**.
 *
 * The cyclic property is load-bearing, not cosmetic: consecutive entries are themselves
 * neighbours of each other, which is what makes "hex plus two consecutive neighbours" a valid
 * triple of mutually-touching hexes — i.e. a corner. See `vertex.ts`.
 */
export const DIRECTIONS: readonly HexCoord[] = [
  { q: +1, r: 0 },
  { q: +1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: +1 },
  { q: 0, r: +1 },
];

export const DIRECTION_COUNT = 6;

export function hexId(h: HexCoord): HexId {
  return `${h.q},${h.r}` as HexId;
}

export function parseHexId(id: HexId): HexCoord {
  const comma = id.indexOf(',');
  if (comma < 0) throw new Error(`parseHexId: malformed hex id ${JSON.stringify(id)}`);
  const q = Number(id.slice(0, comma));
  const r = Number(id.slice(comma + 1));
  if (!Number.isInteger(q) || !Number.isInteger(r)) {
    throw new Error(`parseHexId: malformed hex id ${JSON.stringify(id)}`);
  }
  return { q, r };
}

export function hexEquals(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

export function add(a: HexCoord, b: HexCoord): HexCoord {
  return { q: a.q + b.q, r: a.r + b.r };
}

/** The neighbour in direction `d` (0-5, cyclic per `DIRECTIONS`). */
export function neighbor(h: HexCoord, d: number): HexCoord {
  const dir = DIRECTIONS[((d % DIRECTION_COUNT) + DIRECTION_COUNT) % DIRECTION_COUNT] as HexCoord;
  return add(h, dir);
}

/** All six neighbours, in cyclic order. */
export function neighbors(h: HexCoord): readonly HexCoord[] {
  return DIRECTIONS.map((d) => add(h, d));
}

/** Number of steps between two hexes, in the cube metric. */
export function hexDistance(a: HexCoord, b: HexCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

/** Distance from the origin. */
export function hexRadius(h: HexCoord): number {
  return hexDistance(h, { q: 0, r: 0 });
}

/**
 * A total order on hex coordinates: by `q`, then by `r`.
 *
 * Its only job is to make vertex and edge ids canonical — the *same* set of hexes must always
 * produce the *same* id string, whatever order it was discovered in.
 */
export function compareHex(a: HexCoord, b: HexCoord): number {
  return a.q === b.q ? a.r - b.r : a.q - b.q;
}

/** The `radius`-step ring around the origin. `ring(0)` is just the origin. */
export function ring(radius: number): readonly HexCoord[] {
  if (radius < 0) throw new Error(`ring: radius must be >= 0, got ${radius}`);
  if (radius === 0) return [{ q: 0, r: 0 }];

  const out: HexCoord[] = [];
  // Start on one corner of the ring, then walk the six sides.
  let h: HexCoord = { q: -radius, r: radius };
  for (let d = 0; d < DIRECTION_COUNT; d++) {
    for (let step = 0; step < radius; step++) {
      out.push(h);
      h = neighbor(h, d);
    }
  }
  return out;
}

/** Every hex within `radius` of the origin, innermost ring first. */
export function spiral(radius: number): readonly HexCoord[] {
  const out: HexCoord[] = [];
  for (let k = 0; k <= radius; k++) out.push(...ring(k));
  return out;
}

/** Total hexes within `radius` of the origin: the centred hexagonal numbers 1, 7, 19, 37, 61… */
export function hexCountWithinRadius(radius: number): number {
  return 3 * radius * (radius + 1) + 1;
}
