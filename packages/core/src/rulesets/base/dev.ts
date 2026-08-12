/**
 * The 25 development cards.
 *
 * Each card's whole behaviour is its `play` function, registered in a table. There is no
 * `switch (def)` in the engine, which is what lets Cities & Knights' sixteen progress cards be
 * *added* rather than *woven in*.
 *
 * The three progress cards each show a different way a card can act:
 *
 * - **Road Building** pushes two optional placement steps. It does not place anything itself, so
 *   the player still chooses where — and can decline if there is nowhere legal, which is the
 *   rulebook's answer to "what if I have no roads left".
 * - **Year of Plenty** takes from the bank immediately, clamped to what the bank actually holds.
 * - **Monopoly** moves cards between players immediately.
 *
 * A knight is the odd one out in that it *keeps* something after resolving: it stays face up,
 * because Largest Army is counted from the revealed knights rather than from a counter that could
 * drift out of step with them.
 */

import type { CardDefId, CardKind, PlayerId } from '../../ids.js';
import { OK_VOID, type Result } from '../../result.js';
import { type Action, str, strList } from '../../rules/action.js';
import { event } from '../../rules/event.js';
import type { CardDefMeta, RuleContext } from '../../rules/ruleset.js';
import { kindsWhere } from '../../rules/ruleset.js';
import { type RuleViolation, violation } from '../../rules/violation.js';
import type { Cost, GameState } from '../../state/gameState.js';
import { BANK, type Tx } from '../../state/tx.js';
import { ACTION, STEP, step } from './common.js';
import { DEV_DECK } from './tables.js';

/** How many resources Year of Plenty grants, and how many free roads Road Building places. */
const YEAR_OF_PLENTY_CARDS = 2;
const ROAD_BUILDING_ROADS = 2;

/** The five victory-point cards. Distinct definitions so a UI can name the one that won. */
const VICTORY_POINT_CARDS: readonly CardDefId[] = [
  'chapel',
  'library',
  'market',
  'greatHall',
  'university',
];

function knightPlay(_ctx: RuleContext, tx: Tx, actor: PlayerId): Result<void, RuleViolation> {
  // Identical to the step a 7 pushes, minus the discard: "the knight moves the robber" is the
  // rule, and reusing the step is what guarantees the two paths cannot diverge.
  tx.push(step(STEP.robber, actor, { source: 'knight' }));
  return OK_VOID;
}

function roadBuildingPlay(ctx: RuleContext, tx: Tx, actor: PlayerId): Result<void, RuleViolation> {
  const supply = tx.state.players[actor]?.supply.road ?? 0;
  const roads = Math.min(ROAD_BUILDING_ROADS, supply);
  if (roads === 0) {
    return violation('supplyEmpty', 'you have no roads left to place', { kind: 'road' });
  }
  // Optional steps: the rulebook lets a player who cannot legally place forfeit the placement,
  // and an unskippable step would deadlock a boxed-in player.
  tx.pushSequence(
    Array.from({ length: roads }, () => step(STEP.freeBuild, actor, { kind: 'road' }, true)),
  );
  void ctx;
  return OK_VOID;
}

function yearOfPlentyPlay(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const kinds = strList<CardKind>(action, 'kinds');
  if (!kinds.ok) return kinds;
  if (kinds.value.length !== YEAR_OF_PLENTY_CARDS) {
    return violation('malformed', `year of plenty takes exactly ${YEAR_OF_PLENTY_CARDS} kinds`, {
      given: kinds.value.length,
    });
  }

  const want: Partial<Record<CardKind, number>> = {};
  for (const kind of kinds.value) {
    if (ctx.rules.cardKinds[kind]?.banked !== true) {
      return violation('illegalTarget', `${kind} is not a resource the bank stocks`, { kind });
    }
    want[kind] = (want[kind] ?? 0) + 1;
  }

  // Clamped to the bank rather than refused: per the almanac, if the bank is short you take what
  // is left. Refusing would also make the card unplayable — and so unusable — at the exact moment
  // a scarce resource matters most.
  const taken: Partial<Record<CardKind, number>> = {};
  for (const [kind, n] of Object.entries(want)) {
    const available = Math.min(n ?? 0, tx.state.bank[kind] ?? 0);
    if (available > 0) taken[kind] = available;
  }

  tx.transfer(BANK, actor, taken);
  tx.emit(event('yearOfPlenty', { player: actor, taken, wanted: want }));
  return OK_VOID;
}

function monopolyPlay(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const kind = str<CardKind>(action, 'kind');
  if (!kind.ok) return kind;
  if (ctx.rules.cardKinds[kind.value]?.monopolisable !== true) {
    return violation('illegalTarget', `${kind.value} cannot be monopolised`, { kind: kind.value });
  }

  const from: Record<PlayerId, number> = {};
  let total = 0;
  for (const victim of tx.state.seatOrder) {
    if (victim === actor) continue;
    const n = tx.held(victim, kind.value);
    if (n <= 0) continue;
    tx.transfer(victim, actor, { [kind.value]: n } as Cost);
    from[victim] = n;
    total += n;
  }

  tx.emit(event('monopoly', { player: actor, kind: kind.value, total, from }));
  return OK_VOID;
}

/** Every card definition in the base development deck. */
export const BASE_CARD_DEFS: Readonly<Record<CardDefId, CardDefMeta>> = {
  knight: {
    id: 'knight',
    deck: DEV_DECK,
    victoryPoints: 0,
    playable: true,
    army: 1,
    onPlay: 'reveal',
    play: (ctx, tx, actor) => knightPlay(ctx, tx, actor),
    payloads: () => [{}],
  },
  roadBuilding: {
    id: 'roadBuilding',
    deck: DEV_DECK,
    victoryPoints: 0,
    playable: true,
    army: 0,
    onPlay: 'discard',
    play: (ctx, tx, actor) => roadBuildingPlay(ctx, tx, actor),
    // Offered only while there is a road left to place. `play` refuses otherwise, and a spec that
    // offers what the reducer will refuse is a bug a bot finds before a player does.
    payloads: (_ctx, state, actor) => ((state.players[actor]?.supply.road ?? 0) > 0 ? [{}] : []),
  },
  yearOfPlenty: {
    id: 'yearOfPlenty',
    deck: DEV_DECK,
    victoryPoints: 0,
    playable: true,
    army: 0,
    onPlay: 'discard',
    play: yearOfPlentyPlay,
    payloads: (ctx, state) => pairsOfKinds(ctx, state),
  },
  monopoly: {
    id: 'monopoly',
    deck: DEV_DECK,
    victoryPoints: 0,
    playable: true,
    army: 0,
    onPlay: 'discard',
    play: monopolyPlay,
    payloads: (ctx) => kindsWhere(ctx.rules, (m) => m.monopolisable).map((kind) => ({ kind })),
  },
  ...Object.fromEntries(
    VICTORY_POINT_CARDS.map((id) => [
      id,
      {
        id,
        deck: DEV_DECK,
        victoryPoints: 1,
        // Never played: a victory-point card is revealed by winning, not by an action. Holding it
        // secret is the whole of its tactical value.
        playable: false,
        army: 0,
        onPlay: 'reveal',
      } satisfies CardDefMeta,
    ]),
  ),
};

/** Every unordered pair of bank-stocked kinds, including doubles — Year of Plenty's option list. */
function pairsOfKinds(
  ctx: RuleContext,
  _state: GameState,
): readonly Readonly<Record<string, unknown>>[] {
  const kinds = kindsWhere(ctx.rules, (m) => m.banked);
  const out: { kinds: readonly CardKind[] }[] = [];
  for (const [i, a] of kinds.entries()) {
    for (const b of kinds.slice(i)) out.push({ kinds: [a, b] });
  }
  return out;
}

/** The action a UI sends to play a specific card, with a payload variant spliced in. */
export function playDevAction(card: string, payload: Readonly<Record<string, unknown>>): Action {
  return { type: ACTION.playDev, card, ...payload };
}
