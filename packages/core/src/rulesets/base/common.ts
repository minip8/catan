/**
 * Shared vocabulary and helpers for the base ruleset's step handlers.
 *
 * The step and action names are constants rather than inline strings because they are a wire
 * protocol: clients send these strings, replays store them, and an expansion that wants to extend
 * a step has to name it. A typo in an inline string would show up as a mystifying `wrongStep`.
 */

import type { CardKind, HexId, LocusId, PieceKind, PlayerId } from '../../ids.js';
import { OK_VOID, type Result } from '../../result.js';
import { event } from '../../rules/event.js';
import { type ConnectionRule, canPlace } from '../../rules/placement.js';
import { pieceKind, type RuleContext } from '../../rules/ruleset.js';
import { type RuleViolation, violation } from '../../rules/violation.js';
import type { Cost, GameState, PlayerState, Step } from '../../state/gameState.js';
import { canAfford, piecesOn, player as playerOf } from '../../state/gameState.js';
import { BANK, type Tx } from '../../state/tx.js';

// ── Step kinds ──────────────────────────────────────────────────────────────────────────────

export const STEP = {
  /** One player's whole placement for one opening round: a settlement, then a road. */
  setup: 'setup',
  /** System: start the next player's turn. */
  beginTurn: 'beginTurn',
  /** Roll the dice — or play a development card first. */
  roll: 'roll',
  /** Everyone over the hand limit discards. Actor is a *list*. */
  discard: 'discard',
  /** Move the robber and steal. Pushed by a 7 and by a knight. */
  robber: 'robber',
  /** The build/trade phase. */
  main: 'main',
  /** Place a piece for free — Road Building. */
  freeBuild: 'freeBuild',
  /** A trade offer awaiting responses. */
  trade: 'trade',
} as const;

// ── Action types ────────────────────────────────────────────────────────────────────────────

export const ACTION = {
  place: 'place',
  roll: 'roll',
  discard: 'discard',
  moveRobber: 'moveRobber',
  build: 'build',
  buyDev: 'buyDev',
  playDev: 'playDev',
  tradeBank: 'tradeBank',
  offerTrade: 'offerTrade',
  respondTrade: 'respondTrade',
  completeTrade: 'completeTrade',
  cancelTrade: 'cancelTrade',
  endTurn: 'endTurn',
  /** Decline an optional step — a Road Building placement with nowhere legal to go. */
  skip: 'skip',
} as const;

/** Turn flag: development cards played this turn. The base game allows one. */
export const FLAG_DEV_PLAYED = 'devPlayed';

// ── Hands ───────────────────────────────────────────────────────────────────────────────────

/** Cards counting against the hand limit. Metadata-driven, never a hardcoded resource list. */
export function handSize(ctx: RuleContext, player: PlayerState): number {
  let total = 0;
  for (const [kind, n] of Object.entries(player.cards)) {
    if (ctx.rules.cardKinds[kind]?.countsTowardHandLimit === true) total += n;
  }
  return total;
}

/** How many cards a player must discard on a robber roll. Zero when at or under the limit. */
export function discardDue(ctx: RuleContext, player: PlayerState): number {
  const size = handSize(ctx, player);
  if (size <= ctx.rules.handLimit) return 0;
  return Math.floor(size * ctx.rules.discardFraction);
}

/** Everyone who owes a discard, in seat order, with the amount. */
export function discardsOwed(ctx: RuleContext, state: GameState): Record<PlayerId, number> {
  const out: Record<PlayerId, number> = {};
  for (const id of state.seatOrder) {
    const due = discardDue(ctx, playerOf(state, id));
    if (due > 0) out[id] = due;
  }
  return out;
}

/**
 * A reasonable discard of `due` cards: take from the largest piles first.
 *
 * Offered as a single suggested option on a step whose real legal space is combinatorial (a hand
 * of eight has seventy four-card discards). It gives a UI a default and a bot something to play,
 * while the spec still reports `enumerated: false` so nobody mistakes it for the whole space.
 */
export function suggestDiscard(ctx: RuleContext, player: PlayerState, due: number): Cost {
  const piles = Object.entries(player.cards)
    .filter(([kind, n]) => n > 0 && ctx.rules.cardKinds[kind]?.countsTowardHandLimit === true)
    .map(([kind, n]) => ({ kind, n }));

  const out: Partial<Record<CardKind, number>> = {};
  for (let taken = 0; taken < due; taken++) {
    piles.sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind));
    const largest = piles[0];
    if (largest === undefined || largest.n === 0) break;
    largest.n -= 1;
    out[largest.kind] = (out[largest.kind] ?? 0) + 1;
  }
  return out;
}

/** The kinds a player holds that the robber may take. */
export function stealableKinds(ctx: RuleContext, player: PlayerState): readonly CardKind[] {
  return Object.entries(player.cards)
    .filter(([kind, n]) => n > 0 && ctx.rules.cardKinds[kind]?.stealable === true)
    .map(([kind]) => kind);
}

/**
 * Who the robber can rob at a hex: players with a piece on one of its corners and a card to take.
 *
 * "A piece on one of its corners" rather than "a settlement or city" so that a Cities & Knights
 * knight standing at an intersection is robbable without this function changing.
 */
export function stealCandidates(
  ctx: RuleContext,
  state: GameState,
  hex: HexId,
  thief: PlayerId,
): readonly PlayerId[] {
  const out = new Set<PlayerId>();
  for (const vertex of ctx.topology.hexVertices.get(hex) ?? []) {
    for (const piece of piecesOn(state.board, vertex)) {
      if (piece.owner === null || piece.owner === thief) continue;
      if (stealableKinds(ctx, playerOf(state, piece.owner)).length > 0) out.add(piece.owner);
    }
  }
  return [...out];
}

// ── Building ────────────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** Skip the cost — an opening placement, or a Road Building road. */
  readonly free?: boolean;
  readonly connection: ConnectionRule;
}

/**
 * Pay for and place a piece, including the settlement-to-city upgrade.
 *
 * The upgrade takes the branch it does because a city is built *onto* an existing settlement:
 * `canPlace` would refuse it as `occupied`, which is correct for every other piece. The
 * settlement returns to its owner's supply, which is what makes 5 settlements and 4 cities per
 * player add up over a long game.
 */
export function buildPiece(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  kind: PieceKind,
  at: LocusId,
  options: BuildOptions,
): Result<void, RuleViolation> {
  const meta = pieceKind(ctx.rules, kind);
  if (meta === undefined || meta.owned === false) {
    return violation('illegalTarget', `${kind} is not a piece a player can build`, { kind });
  }

  const state = tx.state;
  const player = state.players[actor];
  if (player === undefined) return violation('illegalTarget', `unknown player ${actor}`);

  if (meta.limit !== null && (player.supply[kind] ?? 0) <= 0) {
    return violation('supplyEmpty', `you have no ${kind} left`, { kind });
  }

  const replaced =
    meta.upgradesFrom === undefined
      ? undefined
      : piecesOn(state.board, at).find((p) => p.kind === meta.upgradesFrom && p.owner === actor);

  if (meta.upgradesFrom !== undefined && replaced === undefined) {
    return violation('illegalTarget', `you have no ${meta.upgradesFrom} at ${at} to upgrade`, {
      at,
      kind,
    });
  }
  if (meta.upgradesFrom === undefined) {
    const placeable = canPlace(ctx, state, actor, kind, at, options.connection);
    if (!placeable.ok) return placeable;
  }

  const cost = options.free === true ? {} : (meta.cost ?? {});
  if (!canAfford(player, cost)) {
    return violation('cannotAfford', `you cannot pay for a ${kind}`, { kind, cost });
  }

  tx.transfer(actor, BANK, cost);
  if (replaced !== undefined) tx.destroyPiece(replaced.id);
  const piece = tx.createPiece(kind, actor, at);
  tx.emit(
    event('build', {
      player: actor,
      kind,
      at,
      piece: piece.id,
      ...(options.free === true ? { free: true } : {}),
    }),
  );
  return OK_VOID;
}

// ── Steps ───────────────────────────────────────────────────────────────────────────────────

export function step(
  kind: string,
  actor: Step['actor'],
  data: Readonly<Record<string, unknown>> = {},
  optional = false,
): Step {
  return optional ? { kind, actor, data, optional } : { kind, actor, data };
}

/** The step that starts `player`'s turn. */
export function beginTurnStep(player: PlayerId): Step {
  return step(STEP.beginTurn, 'system', { player });
}

/**
 * Read a step's data field, defaulting rather than throwing.
 *
 * Step data is `Record<string, unknown>` because core does not interpret it; these accessors keep
 * a handler from having to cast at every read.
 */
export function stepStr<T extends string>(step: Step, field: string): T | undefined {
  const value = step.data?.[field];
  return typeof value === 'string' ? (value as T) : undefined;
}

export function stepNum(step: Step, field: string, fallback: number): number {
  const value = step.data?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function stepBool(step: Step, field: string): boolean {
  return step.data?.[field] === true;
}

export function stepList<T>(step: Step, field: string): readonly T[] {
  const value = step.data?.[field];
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

export function stepRecord(step: Step, field: string): Readonly<Record<string, unknown>> {
  const value = step.data?.[field];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
