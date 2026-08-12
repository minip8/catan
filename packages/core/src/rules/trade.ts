/**
 * Trade mechanics: maritime rates and the shape of an exchange.
 *
 * The harbour rule that implementations usually get wrong is the *specific* harbour. A 2:1 ore
 * harbour improves ore alone — it does **not** also give 3:1 on everything else, and it does not
 * stack with a generic. So the rate for a kind is the minimum over: the default rate, any generic
 * harbour the player controls, and any specific harbour *for that kind*.
 *
 * A player controls a harbour by having a building on either endpoint of the edge it docks
 * against; `Board.harbors` is already keyed by vertex, so that is a direct lookup.
 */

import type { HarborSpec } from '../board/scenario.js';
import type { CardKind, PlayerId, VertexId } from '../ids.js';
import type { Cost, GameState } from '../state/gameState.js';
import { exclusivePieces } from './placement.js';
import type { RuleContext } from './ruleset.js';

/** The rate with no harbour: four of a kind for one of anything. */
export const DEFAULT_MARITIME_RATE = 4;

/** Harbours whose vertex carries one of `player`'s buildings. */
export function harborsOf(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
): readonly HarborSpec[] {
  const out: HarborSpec[] = [];
  for (const [vertex, harbor] of Object.entries(state.board.harbors)) {
    if (exclusivePieces(ctx, state, vertex as VertexId).some((p) => p.owner === player)) {
      out.push(harbor);
    }
  }
  return out;
}

/** How many of `kind` this player must give the bank for one card of their choice. */
export function maritimeRate(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  kind: CardKind,
): number {
  let best = DEFAULT_MARITIME_RATE;
  for (const harbor of harborsOf(ctx, state, player)) {
    if (harbor.kind !== null && harbor.kind !== kind) continue;
    if (harbor.ratio < best) best = harbor.ratio;
  }
  return best;
}

/**
 * Whether `give` is a valid payment for `want` cards at this player's rates.
 *
 * Each kind offered must be a whole multiple of its own rate, and the multiples must total the
 * number of cards asked for. Written this way so a single action can make two exchanges at once
 * (four ore and four wool for two cards), which the rules allow and which saves a UI two round
 * trips.
 */
export function maritimeExchangeIsValid(
  ctx: RuleContext,
  state: GameState,
  player: PlayerId,
  give: Cost,
  want: Cost,
): boolean {
  let bought = 0;
  for (const [kind, n] of Object.entries(give)) {
    if (n === undefined || n === 0) continue;
    if (ctx.rules.cardKinds[kind]?.maritime !== true) return false;
    const rate = maritimeRate(ctx, state, player, kind);
    if (n % rate !== 0) return false;
    bought += n / rate;
  }
  if (bought === 0) return false;

  let received = 0;
  for (const [kind, n] of Object.entries(want)) {
    if (n === undefined || n === 0) continue;
    if (ctx.rules.cardKinds[kind]?.maritime !== true) return false;
    received += n;
  }
  return received === bought;
}

/** Whether the bank can pay out a bundle. */
export function bankCanPay(state: GameState, want: Cost): boolean {
  return Object.entries(want).every(([kind, n]) => (state.bank[kind] ?? 0) >= (n ?? 0));
}

/** Whether a holder can pay a bundle from hand. */
export function canPay(cards: Readonly<Record<CardKind, number>>, cost: Cost): boolean {
  return Object.entries(cost).every(([kind, n]) => (cards[kind] ?? 0) >= (n ?? 0));
}
