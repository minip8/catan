/**
 * Pixel geometry — the *only* place floating point appears in the coordinate layer.
 *
 * This lives in core rather than in the client so that the engine and the renderer can never
 * disagree about where a thing is. Hit-testing, animation targets and the SVG board all derive
 * from these functions.
 *
 * The trick that keeps this short: **a vertex is the centroid of its three hex centres.** Three
 * mutually-adjacent hex centres form an equilateral triangle whose centroid is exactly the point
 * where the three hexes meet. So there is no per-orientation table of corner offsets to maintain,
 * and no risk of the corner order disagreeing with `DIRECTIONS`.
 */

import type { EdgeId, HexId, VertexId } from '../ids.js';
import { type HexCoord, parseHexId } from './axial.js';
import { parseEdgeId } from './edge.js';
import { parseVertexId } from './vertex.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Hex orientation.
 *
 * `pointy` puts a vertex at the top of each hex, which is the standard Catan look: hexes sit in
 * horizontal rows and the island reads as rows of 3/4/5/4/3.
 */
export type Orientation = 'pointy' | 'flat';

export interface Layout {
  readonly orientation: Orientation;
  /** Circumradius: centre to corner, in pixels. */
  readonly size: number;
  /** Pixel position of hex `(0, 0)`. */
  readonly origin: Point;
}

export function makeLayout(
  size: number,
  orientation: Orientation = 'pointy',
  origin: Point = { x: 0, y: 0 },
): Layout {
  return { orientation, size, origin };
}

const SQRT3 = Math.sqrt(3);

export function hexToPixel(layout: Layout, h: HexCoord): Point {
  const { size, origin } = layout;
  if (layout.orientation === 'pointy') {
    return {
      x: origin.x + size * SQRT3 * (h.q + h.r / 2),
      y: origin.y + size * 1.5 * h.r,
    };
  }
  return {
    x: origin.x + size * 1.5 * h.q,
    y: origin.y + size * SQRT3 * (h.r + h.q / 2),
  };
}

export function hexCenter(layout: Layout, hex: HexId): Point {
  return hexToPixel(layout, parseHexId(hex));
}

function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** A vertex sits at the centroid of the three hex centres that meet there. */
export function vertexToPixel(layout: Layout, vertex: VertexId): Point {
  return centroid(parseVertexId(vertex).map((h) => hexToPixel(layout, h)));
}

/** The midpoint of an edge: halfway between the two hex centres it separates. */
export function edgeToPixel(layout: Layout, edge: EdgeId): Point {
  return centroid(parseEdgeId(edge).map((h) => hexToPixel(layout, h)));
}

/**
 * Rotation in radians for a piece drawn along an edge — a road or a ship.
 *
 * Taken from the edge's two endpoints rather than from its two hex centres, because the drawn
 * piece lies *along* the border, perpendicular to the line joining the hexes.
 */
export function edgeAngle(layout: Layout, edge: EdgeId): number {
  const [a, b] = edgeEndpointPoints(layout, edge);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function edgeEndpointPoints(layout: Layout, edge: EdgeId): readonly [Point, Point] {
  const [ha, hb] = parseEdgeId(edge);
  const ca = hexToPixel(layout, ha);
  const cb = hexToPixel(layout, hb);
  // The border is the perpendicular bisector of the segment joining the two centres; its two ends
  // are half an edge-length away from the midpoint. For a regular grid the edge length equals the
  // circumradius, so this is exact.
  const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy);
  const half = layout.size / 2;
  const px = (-dy / len) * half;
  const py = (dx / len) * half;
  return [
    { x: mid.x + px, y: mid.y + py },
    { x: mid.x - px, y: mid.y - py },
  ];
}

/** The six corner points of a hex, in cyclic order — the `points` of an SVG `<polygon>`. */
export function hexPolygon(layout: Layout, hex: HexId): readonly Point[] {
  const center = hexToPixel(layout, parseHexId(hex));
  const { size } = layout;
  // Pointy-top has a corner straight up (-90°); flat-top has one straight right (0°).
  const startAngle = layout.orientation === 'pointy' ? -Math.PI / 2 : 0;
  const out: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = startAngle + (i * Math.PI) / 3;
    out.push({ x: center.x + size * Math.cos(angle), y: center.y + size * Math.sin(angle) });
  }
  return out;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Bounding box of the given hexes including their corners — an SVG `viewBox`, with `padding`. */
export function boundsOf(layout: Layout, hexes: Iterable<HexId>, padding = 0): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const hex of hexes) {
    for (const p of hexPolygon(layout, hex)) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (minX === Number.POSITIVE_INFINITY) {
    throw new Error('boundsOf: no hexes supplied');
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}
