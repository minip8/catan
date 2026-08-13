/**
 * The board as pure data: what to draw, and where.
 *
 * Every pixel in this file comes from `@catan/core`'s layout helpers. That is the point of those
 * helpers living in the engine — hit-testing, rule checks and rendering all derive from one
 * definition of where a vertex is, so the highlight a player clicks and the intersection the rules
 * validate cannot drift apart by half a pixel or by a whole coordinate convention.
 *
 * Keeping the scene separate from the SVG that draws it is what makes the interesting half
 * testable without a DOM: which hexes carry which token, how many pips they are worth, where the
 * harbours dock, and which spots are live. `board.ts` is then a mechanical translation.
 */

import {
  boundsOf,
  type CardKind,
  type EdgeId,
  edgeAngle,
  edgeToPixel,
  type HarborSpec,
  type HexId,
  hexCenter,
  hexPolygon,
  type Layout,
  type LocusId,
  type LocusKind,
  locusKindOf,
  makeLayout,
  type PieceId,
  type PieceKind,
  type PlayerId,
  type PlayerView,
  type Point,
  type RuleContext,
  type TerrainId,
  type VertexId,
  vertexToPixel,
} from '@catan/core';

import type { Target } from './targets.js';
import { pipsFor } from './theme.js';

/** Hex circumradius in scene units. The SVG scales to fit, so this only sets the detail budget. */
export const HEX_SIZE = 60;

export interface Token {
  readonly value: number;
  /** Rolls out of 36 that produce it — the printed pips. */
  readonly pips: number;
  /** The two most likely numbers, printed in red. Derived, so it is right for any dice. */
  readonly hot: boolean;
}

export interface HexShape {
  readonly hex: HexId;
  readonly points: readonly Point[];
  readonly center: Point;
  readonly class: 'land' | 'sea' | 'unexplored';
  readonly terrain: TerrainId | null;
  readonly yields: CardKind | null;
  readonly tokens: readonly Token[];
  /** A piece that stops production stands here — the robber. */
  readonly blocked: boolean;
}

export interface DockShape {
  /** One or two intersections control the harbour; either may use it. */
  readonly anchors: readonly Point[];
  /** Where the badge sits, out in the water. */
  readonly at: Point;
  readonly label: string;
  readonly kind: CardKind | null;
}

export interface PieceShape {
  readonly id: PieceId;
  readonly kind: PieceKind;
  readonly owner: PlayerId | null;
  readonly seat: number | null;
  readonly locus: LocusKind;
  readonly at: Point;
  /** Radians, for pieces drawn along an edge. Zero elsewhere. */
  readonly angle: number;
}

export interface TargetShape {
  readonly locus: LocusId;
  readonly kind: LocusKind;
  readonly at: Point;
  readonly angle: number;
  readonly options: number;
}

export interface Scene {
  readonly viewBox: string;
  readonly size: number;
  readonly hexes: readonly HexShape[];
  readonly docks: readonly DockShape[];
  readonly pieces: readonly PieceShape[];
  readonly targets: readonly TargetShape[];
}

export function sceneLayout(): Layout {
  return makeLayout(HEX_SIZE, 'pointy');
}

export function boardScene(ctx: RuleContext, view: PlayerView, targets: readonly Target[]): Scene {
  const layout = sceneLayout();
  const bounds = boundsOf(layout, ctx.topology.hexes, HEX_SIZE * 0.55);
  const viewBox = [bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY]
    .map((n) => round(n))
    .join(' ');

  return {
    viewBox,
    size: HEX_SIZE,
    hexes: hexShapes(ctx, view, layout),
    docks: dockShapes(ctx, view, layout),
    pieces: pieceShapes(ctx, view, layout),
    targets: targetShapes(layout, targets),
  };
}

// ── Hexes ───────────────────────────────────────────────────────────────────────────────────

function hexShapes(ctx: RuleContext, view: PlayerView, layout: Layout): readonly HexShape[] {
  const sides = ctx.rules.dice.sides;
  return ctx.topology.hexes.map((hex) => {
    const state = view.board.hexes[hex];
    const terrain = state?.terrain ?? null;
    const tokens =
      state === undefined || state.numbersHidden
        ? []
        : state.numbers.map((value) => ({
            value,
            pips: pipsFor(value, sides),
            hot: pipsFor(value, sides) === sides - 1,
          }));
    return {
      hex,
      points: hexPolygon(layout, hex),
      center: hexCenter(layout, hex),
      class: state?.class ?? 'sea',
      terrain,
      yields: terrain === null ? null : (ctx.rules.terrainYield[terrain] ?? null),
      tokens,
      blocked: blockedAt(ctx, view, hex),
    };
  });
}

function blockedAt(ctx: RuleContext, view: PlayerView, hex: HexId): boolean {
  for (const id of view.board.occupancy[hex] ?? []) {
    const piece = view.board.pieces[id];
    if (piece === undefined) continue;
    if (ctx.rules.pieceKinds[piece.kind]?.blocksProduction === true) return true;
  }
  return false;
}

// ── Harbours ────────────────────────────────────────────────────────────────────────────────

/**
 * Group the harbour intersections back into docks.
 *
 * State stores a harbour per *vertex* — either endpoint of a coastal edge may use it — so a
 * single dock appears twice, and drawing it twice would badge the same 2:1 harbour on two
 * neighbouring corners. Two adjacent vertices offering the identical rate are therefore treated
 * as one dock. A scenario that deliberately docked two identical harbours side by side would
 * render as one; core spaces harbours around the coast, so that does not arise.
 */
function dockShapes(ctx: RuleContext, view: PlayerView, layout: Layout): readonly DockShape[] {
  const harbors = Object.entries(view.board.harbors) as [VertexId, HarborSpec][];
  harbors.sort(([a], [b]) => a.localeCompare(b));

  const claimed = new Set<VertexId>();
  const out: DockShape[] = [];
  for (const [vertex, spec] of harbors) {
    if (claimed.has(vertex)) continue;
    claimed.add(vertex);

    const group: VertexId[] = [vertex];
    for (const other of ctx.topology.vertexNeighbors.get(vertex) ?? []) {
      const theirs = view.board.harbors[other];
      if (claimed.has(other) || theirs === undefined) continue;
      if (theirs.ratio !== spec.ratio || theirs.kind !== spec.kind) continue;
      claimed.add(other);
      group.push(other);
      break;
    }

    const anchors = group.map((v) => vertexToPixel(layout, v));
    out.push({
      anchors,
      at: seaward(ctx, view, layout, group, midpoint(anchors)),
      label: `${spec.ratio}:1`,
      kind: spec.kind,
    });
  }
  return out;
}

/** Push a point away from the land the dock is attached to, so the badge sits in the water. */
function seaward(
  ctx: RuleContext,
  view: PlayerView,
  layout: Layout,
  vertices: readonly VertexId[],
  from: Point,
): Point {
  const land: Point[] = [];
  for (const vertex of vertices) {
    for (const hex of ctx.topology.vertexHexes.get(vertex) ?? []) {
      if (view.board.hexes[hex]?.class !== 'sea') land.push(hexCenter(layout, hex));
    }
  }
  if (land.length === 0) return from;
  const inland = midpoint(land);
  const dx = from.x - inland.x;
  const dy = from.y - inland.y;
  const length = Math.hypot(dx, dy) || 1;
  const reach = HEX_SIZE * 0.5;
  return { x: from.x + (dx / length) * reach, y: from.y + (dy / length) * reach };
}

// ── Pieces and targets ──────────────────────────────────────────────────────────────────────

function pieceShapes(ctx: RuleContext, view: PlayerView, layout: Layout): readonly PieceShape[] {
  const out: PieceShape[] = [];
  for (const piece of Object.values(view.board.pieces)) {
    if (piece.at === null) continue;
    // The piece's own metadata says where its kind lives; asking the topology is the fallback for
    // a ruleset that did not declare one.
    const locus = ctx.rules.pieceKinds[piece.kind]?.locus ?? locusKindOf(ctx, piece.at);
    if (locus === undefined) continue;
    out.push({
      id: piece.id,
      kind: piece.kind,
      owner: piece.owner,
      seat: piece.owner === null ? null : (view.players[piece.owner]?.seat ?? null),
      locus,
      at: pointOf(layout, piece.at, locus),
      angle: angleOf(layout, piece.at, locus),
    });
  }
  // Drawn in locus order so vertex buildings sit above the roads that run into them.
  const order: Record<string, number> = { hex: 0, edge: 1, vertex: 2 };
  return out.sort((a, b) => (order[a.locus] ?? 3) - (order[b.locus] ?? 3));
}

function targetShapes(layout: Layout, targets: readonly Target[]): readonly TargetShape[] {
  return targets.map((target) => ({
    locus: target.locus,
    kind: target.kind,
    at: pointOf(layout, target.locus, target.kind),
    angle: angleOf(layout, target.locus, target.kind),
    options: target.options.length,
  }));
}

/**
 * Where a locus sits.
 *
 * The casts are the one place the client narrows core's `LocusId` union by hand. `LocusKind` comes
 * from the piece's own metadata (or from asking the topology), so the pairing is sound — but the
 * type system cannot see that the string and the kind were derived from the same lookup.
 */
function pointOf(layout: Layout, locus: LocusId, kind: LocusKind): Point {
  switch (kind) {
    case 'vertex':
      return vertexToPixel(layout, locus as VertexId);
    case 'edge':
      return edgeToPixel(layout, locus as EdgeId);
    case 'hex':
      return hexCenter(layout, locus as HexId);
    default:
      // Track and off-board pieces have no place on the map; park them at the origin rather than
      // inventing a position. The base game never reaches this.
      return { x: 0, y: 0 };
  }
}

function angleOf(layout: Layout, locus: LocusId, kind: LocusKind): number {
  return kind === 'edge' ? edgeAngle(layout, locus as EdgeId) : 0;
}

function midpoint(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / (points.length || 1), y: y / (points.length || 1) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
