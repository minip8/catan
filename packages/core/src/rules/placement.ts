/**
 * Placement legality: where a piece may be built.
 *
 * Everything here is a *mechanism* driven by `PieceKindMeta`, not a base-game rule. "A settlement
 * needs two clear intersections either side" is expressed as "an `exclusive` vertex piece may not
 * sit next to another `exclusive` vertex piece"; "a road must connect" is
 * `connection: 'network'`. So Seafarers' ships — which connect like roads but may also be built
 * from a ship at sea — arrive as a table entry plus, at most, one new `ConnectionRule` member,
 * rather than as an `if (kind === 'ship')` in the middle of the distance rule.
 *
 * The division of labour with `rulesets/`: this file knows *how* legality is computed, the ruleset
 * knows *what* each piece is.
 */

import { hasEdge, hasHex, hasVertex } from '../board/topology.js';
import type { EdgeId, HexId, LocusId, PieceKind, PlayerId, VertexId } from '../ids.js';
import { OK_VOID, type Result } from '../result.js';
import type { GameState, Piece } from '../state/gameState.js';
import { piecesOn } from '../state/gameState.js';
import type { LocusKind, PieceKindMeta, RuleContext } from './ruleset.js';
import { pieceKind } from './ruleset.js';
import { type RuleViolation, violation } from './violation.js';

/**
 * What a piece must touch to be built.
 *
 * - `none` — anywhere legal by occupancy alone: the opening placements, and upgrades.
 * - `route` — a vertex piece must stand where its owner already has a route segment. This is the
 *   "settlements must connect to your roads" rule.
 * - `network` — an edge piece must share an endpoint with one of its owner's route segments or
 *   buildings, and that endpoint must not be blocked by an opponent's building. The second half is
 *   the rulebook's "you may not build a road through an opponent's settlement".
 */
export type ConnectionRule = 'none' | 'route' | 'network';

/** Which member of `LocusId` a locus string is, according to the topology it belongs to. */
export function locusKindOf(ctx: RuleContext, locus: LocusId): LocusKind | undefined {
  if (hasVertex(ctx.topology, locus as VertexId)) return 'vertex';
  if (hasEdge(ctx.topology, locus as EdgeId)) return 'edge';
  if (hasHex(ctx.topology, locus as HexId)) return 'hex';
  return undefined;
}

/** Pieces at a locus that claim it exclusively — a settlement, a city, but not a harbour marker. */
export function exclusivePieces(
  ctx: RuleContext,
  state: GameState,
  locus: LocusId,
): readonly Piece[] {
  return piecesOn(state.board, locus).filter(
    (p) => pieceKind(ctx.rules, p.kind)?.exclusive === true,
  );
}

/** Every piece a player owns that counts as a segment of their route. */
export function routeSegmentsOf(
  ctx: RuleContext,
  state: GameState,
  owner: PlayerId,
): readonly Piece[] {
  return Object.values(state.board.pieces).filter(
    (p) =>
      p.owner === owner && p.at !== null && pieceKind(ctx.rules, p.kind)?.routeSegment === true,
  );
}

/** The edges a player's route occupies. The input to the Longest Road metric. */
export function routeEdgesOf(
  ctx: RuleContext,
  state: GameState,
  owner: PlayerId,
): ReadonlySet<EdgeId> {
  return new Set(routeSegmentsOf(ctx, state, owner).map((p) => p.at as EdgeId));
}

/** Whether an opponent of `player` has a route-blocking piece at `vertex`. */
export function isBlockedFor(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  vertex: VertexId,
): boolean {
  return piecesOn(state.board, vertex).some(
    (p) =>
      p.owner !== null && p.owner !== player && pieceKind(ctx.rules, p.kind)?.blocksRoute === true,
  );
}

/** Whether `player` has a building at `vertex` — anything of theirs that claims it exclusively. */
export function hasBuildingAt(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  vertex: VertexId,
): boolean {
  return exclusivePieces(ctx, state, vertex).some((p) => p.owner === player);
}

/** Whether one of `player`'s route segments ends at `vertex`. */
export function routeTouches(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  vertex: VertexId,
): boolean {
  const edges = routeEdgesOf(ctx, state, player);
  return (ctx.topology.vertexEdges.get(vertex) ?? []).some((e) => edges.has(e));
}

/**
 * The distance rule.
 *
 * Stated over *vertex adjacency in the graph*, which is what makes it correct across water: two
 * intersections facing each other across a sea border are neighbours, and a settlement on a new
 * island still may not be built opposite one on the old.
 */
export function violatesDistanceRule(
  ctx: RuleContext,
  state: GameState,
  vertex: VertexId,
): boolean {
  return (ctx.topology.vertexNeighbors.get(vertex) ?? []).some(
    (v) => exclusivePieces(ctx, state, v).length > 0,
  );
}

/**
 * Whether a piece of `kind` may be built at `locus` by `player`.
 *
 * `connection` is passed in rather than read from the metadata because the *same* piece kind is
 * placed under different connection rules at different times: the opening settlements are placed
 * with no road to connect to. Everything else — the locus kind, occupancy, the distance rule — is
 * identical in setup and in play, which is exactly why they share this function.
 */
export function canPlace(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  kind: PieceKind,
  locus: LocusId,
  connection: ConnectionRule,
): Result<void, RuleViolation> {
  const meta = pieceKind(ctx.rules, kind);
  if (meta === undefined) {
    return violation('illegalTarget', `${kind} is not a piece in this ruleset`, { kind });
  }

  const actual = locusKindOf(ctx, locus);
  if (actual !== meta.locus) {
    return violation('illegalTarget', `${locus} is not a ${meta.locus} on this board`, {
      locus,
      expected: meta.locus,
    });
  }

  if (meta.exclusive && exclusivePieces(ctx, state, locus).length > 0) {
    return violation('occupied', `something is already built at ${locus}`, { locus });
  }

  if (
    meta.locus === 'vertex' &&
    meta.exclusive &&
    violatesDistanceRule(ctx, state, locus as VertexId)
  ) {
    return violation('tooClose', `${locus} is adjacent to an existing building`, { locus });
  }

  if (meta.needsAdjacent !== null && !touchesHexClass(ctx, state, locus, meta.needsAdjacent)) {
    return violation('illegalTarget', `${locus} does not touch ${meta.needsAdjacent}`, {
      locus,
      needs: meta.needsAdjacent,
    });
  }

  return checkConnection(ctx, state, player, meta, locus, connection);
}

/**
 * The two vertices at the ends of an edge, widened from `LocusId`.
 *
 * The brands make `LocusId` deliberately un-indexable — that is their job — so the one place that
 * legitimately asks "if this locus is an edge, what are its ends?" does the widening, rather than
 * every caller casting.
 */
export function edgeEndsOf(ctx: RuleContext, locus: LocusId): readonly VertexId[] {
  return ctx.topology.edgeVertices.get(locus as EdgeId) ?? [];
}

/** The hexes a locus touches: three for a vertex, two for an edge, itself for a hex. */
export function hexesTouching(ctx: RuleContext, locus: LocusId): readonly HexId[] {
  switch (locusKindOf(ctx, locus)) {
    case 'vertex':
      return ctx.topology.vertexHexes.get(locus as VertexId) ?? [];
    case 'edge':
      return ctx.topology.edgeHexes.get(locus as EdgeId) ?? [];
    case 'hex':
      return [locus as HexId];
    default:
      return [];
  }
}

function touchesHexClass(
  ctx: RuleContext,
  state: GameState,
  locus: LocusId,
  want: 'land' | 'water',
): boolean {
  const wanted = want === 'land' ? 'land' : 'sea';
  return hexesTouching(ctx, locus).some((h) => state.board.hexes[h]?.class === wanted);
}

function checkConnection(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  meta: PieceKindMeta,
  locus: LocusId,
  connection: ConnectionRule,
): Result<void, RuleViolation> {
  if (connection === 'none') return OK_VOID;

  if (connection === 'route') {
    if (routeTouches(ctx, state, player, locus as VertexId)) return OK_VOID;
    return violation('notConnected', `${locus} does not touch one of your roads`, { locus });
  }

  // `network`: an edge piece. Legal from either endpoint, and each endpoint qualifies on its own
  // — which is what lets a road be built past an opponent's settlement, just not *through* it.
  const ends = ctx.topology.edgeVertices.get(locus as EdgeId) ?? [];
  for (const v of ends) {
    if (isBlockedFor(ctx, state, player, v)) continue;
    if (hasBuildingAt(ctx, state, player, v) || routeTouches(ctx, state, player, v)) return OK_VOID;
  }
  return violation(
    'notConnected',
    `${locus} does not extend your network, or is blocked by an opponent's building`,
    { locus, kind: meta.id },
  );
}

/** Every locus of the right kind where `player` could legally build `kind`. For `legalActions`. */
export function placementOptions(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  kind: PieceKind,
  connection: ConnectionRule,
): readonly LocusId[] {
  const meta = pieceKind(ctx.rules, kind);
  if (meta === undefined) return [];
  const candidates: readonly LocusId[] =
    meta.locus === 'vertex'
      ? ctx.topology.vertices
      : meta.locus === 'edge'
        ? ctx.topology.edges
        : meta.locus === 'hex'
          ? ctx.topology.hexes
          : [];
  return candidates.filter((l) => canPlace(ctx, state, player, kind, l, connection).ok);
}
