/**
 * The base game, assembled.
 *
 * Everything below is either a table from `tables.ts` or a handler from `steps/`. The only real
 * logic in this file is the three functions the engine asks the ruleset for and that no table can
 * express: how a game opens, what a route is worth, and what a player's score is.
 */

import type { AwardId, PlayerId } from '../../ids.js';
import { isBlockedFor, routeEdgesOf } from '../../rules/placement.js';
import { baseRouteRules, longestRoute, type RouteRules } from '../../rules/route.js';
import type { AwardSpec, RuleSet, VpSource } from '../../rules/ruleset.js';
import type { GameState } from '../../state/gameState.js';
import { beginTurnStep, STEP, step } from './common.js';
import { BASE_CARD_DEFS } from './dev.js';
import { discardHandler, robberHandler } from './steps/robber.js';
import { setupHandler } from './steps/setup.js';
import { tradeHandler } from './steps/trade.js';
import { beginTurnHandler, freeBuildHandler, mainHandler, rollHandler } from './steps/turn.js';
import {
  AWARD_VALUE,
  BASE_CARD_KINDS,
  BASE_DECKS,
  BASE_PIECE_KINDS,
  BASE_RULESET_ID,
  BASE_TERRAIN_YIELD,
  DICE,
  DISCARD_FRACTION,
  HAND_LIMIT,
  LARGEST_ARMY_THRESHOLD,
  LONGEST_ROAD_THRESHOLD,
  ROBBER_ROLL,
} from './tables.js';

export { ACTION, STEP } from './common.js';
export { BASE_CARD_DEFS } from './dev.js';
export * from './tables.js';

/** How a player's route is measured: their segments, blocked by opponents' buildings. */
function routeRulesFor(
  ctx: Parameters<AwardSpec['metric']>[0],
  state: GameState,
  player: PlayerId,
): RouteRules {
  const edges = routeEdgesOf(ctx, state, player);
  return baseRouteRules(
    (edge) => edges.has(edge),
    (vertex) => !isBlockedFor(ctx, state, player, vertex),
  );
}

const BASE_AWARDS: Readonly<Record<AwardId, AwardSpec>> = {
  longestRoad: {
    id: 'longestRoad',
    value: AWARD_VALUE,
    threshold: LONGEST_ROAD_THRESHOLD,
    metric: (ctx, state, player) =>
      longestRoute(ctx.topology, routeRulesFor(ctx, state, player)).length,
  },
  largestArmy: {
    id: 'largestArmy',
    value: AWARD_VALUE,
    threshold: LARGEST_ARMY_THRESHOLD,
    // Counted from the knights face up in front of the player rather than from a tally, so it
    // cannot drift out of step with what everyone can see on the table.
    metric: (ctx, state, player) =>
      (state.players[player]?.revealed ?? []).reduce((n, card) => {
        const def = state.cardInstances[card]?.def;
        return n + (def === undefined ? 0 : (ctx.rules.cardDefs[def]?.army ?? 0));
      }, 0),
  },
};

/**
 * Victory points: buildings, awards, and victory-point cards.
 *
 * Reads `VpSource` rather than `GameState` so the same function scores a *redacted* view. On a
 * view, an opponent's hidden card has `def: null` and contributes nothing — which is precisely
 * what that opponent's score looks like from the outside, and why a client can compute the
 * scoreboard without the server leaking who is one card from winning.
 */
function baseVictoryPoints(
  ctx: Parameters<RuleSet['victoryPoints']>[0],
  state: VpSource,
  player: PlayerId,
): number {
  let total = 0;

  for (const piece of Object.values(state.board.pieces)) {
    if (piece.owner !== player || piece.at === null) continue;
    total += ctx.rules.pieceKinds[piece.kind]?.victoryPoints ?? 0;
  }

  for (const award of Object.values(state.awards)) {
    if (award.holder === player) total += award.value;
  }

  const p = state.players[player];
  if (p !== undefined) {
    const cards = [...Object.values(p.hands).flat(), ...p.revealed];
    for (const card of cards) {
      const def = state.cardInstances[card]?.def;
      if (def === null || def === undefined) continue;
      total += ctx.rules.cardDefs[def]?.victoryPoints ?? 0;
    }
  }

  return total;
}

/**
 * The base ruleset.
 *
 * A function rather than a constant so that a caller who mutates a table — a variant, a test —
 * cannot corrupt every other game in the process.
 */
export function baseRules(): RuleSet {
  return {
    id: BASE_RULESET_ID,
    cardKinds: BASE_CARD_KINDS,
    pieceKinds: BASE_PIECE_KINDS,
    cardDefs: BASE_CARD_DEFS,
    decks: BASE_DECKS,
    awards: BASE_AWARDS,
    terrainYield: BASE_TERRAIN_YIELD,

    dice: DICE,
    robberRoll: ROBBER_ROLL,
    handLimit: HAND_LIMIT,
    discardFraction: DISCARD_FRACTION,

    steps: {
      [STEP.setup]: setupHandler,
      [STEP.beginTurn]: beginTurnHandler,
      [STEP.roll]: rollHandler,
      [STEP.discard]: discardHandler,
      [STEP.robber]: robberHandler,
      [STEP.main]: mainHandler,
      [STEP.freeBuild]: freeBuildHandler,
      [STEP.trade]: tradeHandler,
    },

    /**
     * The opening: one step per player per setup round, then the first turn.
     *
     * The rounds come from the scenario, including their direction, so "the last player places
     * twice in a row" is a property of the data rather than of this code.
     */
    begin(ctx, tx) {
      const steps = [];
      for (const [index, round] of ctx.scenario.setup.entries()) {
        const order =
          round.order === 'reverse' ? [...tx.state.seatOrder].reverse() : tx.state.seatOrder;
        for (const player of order) {
          steps.push(
            step(STEP.setup, player, {
              round: index,
              place: round.place,
              placed: [],
              grant: round.grantProduction,
            }),
          );
        }
      }
      const first = tx.state.seatOrder[0];
      if (first === undefined) throw new Error('begin: the game has no players');
      steps.push(beginTurnStep(first));
      tx.pushSequence(steps);
    },

    victoryPoints: baseVictoryPoints,
  };
}
