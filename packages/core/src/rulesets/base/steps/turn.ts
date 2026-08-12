/**
 * The turn: begin, roll, act, end.
 *
 * The shape of a turn is a stack discipline rather than a phase enum:
 *
 * ```
 * beginTurn (system)  →  roll  →  main  →  beginTurn (next player)
 *                          ↑        ↑
 *                    a 7 pushes discard + robber above the step it interrupts,
 *                    a knight pushes robber, Road Building pushes two freeBuilds
 * ```
 *
 * Because the interrupting steps sit *above* whatever they interrupted, nothing has to remember
 * where to return to. A knight played before the roll leaves `roll` underneath, so the player
 * still rolls afterwards; a knight played in the main phase returns to `main`. That is one rule
 * with two behaviours, rather than two rules.
 */

import type { CardId, DeckId, LocusId, PieceKind, PlayerId } from '../../../ids.js';
import { OK_VOID, type Result } from '../../../result.js';
import { rollDie } from '../../../rng.js';
import {
  type Action,
  type ActionSpec,
  bundle,
  optionalStr,
  spec,
  str,
} from '../../../rules/action.js';
import { event, secretEvent } from '../../../rules/event.js';
import { placementOptions } from '../../../rules/placement.js';
import { planProduction } from '../../../rules/production.js';
import {
  cardDef,
  kindsWhere,
  pieceKind,
  type RuleContext,
  type StepHandler,
} from '../../../rules/ruleset.js';
import { bankCanPay, canPay, maritimeExchangeIsValid, maritimeRate } from '../../../rules/trade.js';
import { type RuleViolation, violation } from '../../../rules/violation.js';
import type { GameState } from '../../../state/gameState.js';
import { canAfford, nextPlayer, piecesOf } from '../../../state/gameState.js';
import { BANK, type Tx } from '../../../state/tx.js';
import {
  ACTION,
  beginTurnStep,
  buildPiece,
  discardsOwed,
  FLAG_DEV_PLAYED,
  step as makeStep,
  STEP,
  stepStr,
} from '../common.js';
import { DEV_DECK } from '../tables.js';

/** The base game allows one development card per turn. */
const DEV_CARDS_PER_TURN = 1;

// ── beginTurn ───────────────────────────────────────────────────────────────────────────────

export const beginTurnHandler: StepHandler = {
  run(ctx, tx, step) {
    const next = stepStr<PlayerId>(step, 'player') ?? tx.state.turn.active;
    tx.pop();
    // Flags are cleared here, which is what makes "one development card per turn" a fact about
    // the turn rather than a per-player counter someone has to remember to reset.
    tx.state.turn = { n: tx.state.turn.n + 1, active: next, flags: {} };
    tx.emit(event('turn', { player: next, n: tx.state.turn.n }));
    tx.push(makeStep(STEP.roll, next));
    void ctx;
  },
};

// ── Production ──────────────────────────────────────────────────────────────────────────────

/** Pay out a roll, honouring the bank-shortage rule (`planProduction` decides who gets what). */
export function applyProduction(ctx: RuleContext, tx: Tx, roll: number): void {
  const plan = planProduction(ctx, tx.state, roll);
  for (const [player, grant] of Object.entries(plan.grants)) {
    tx.transfer(BANK, player as PlayerId, grant);
  }
  tx.emit(
    event('production', {
      roll,
      grants: plan.grants,
      claims: plan.claims,
      shorted: plan.shorted,
    }),
  );
}

// ── roll ────────────────────────────────────────────────────────────────────────────────────

function doRoll(ctx: RuleContext, tx: Tx, actor: PlayerId): Result<void, RuleViolation> {
  const dice: number[] = [];
  for (let i = 0; i < ctx.rules.dice.count; i++) {
    dice.push(tx.random((rng) => rollDie(rng, ctx.rules.dice.sides)));
  }
  const total = dice.reduce((a, b) => a + b, 0);
  tx.emit(event('dice', { player: actor, dice, total }));

  // The main phase goes on the stack first, so it is what the robber sequence returns to.
  tx.pop();
  tx.push(makeStep(STEP.main, actor));

  if (total === ctx.rules.robberRoll) {
    tx.push(makeStep(STEP.robber, actor, { source: 'roll' }));
    const owed = discardsOwed(ctx, tx.state);
    const owing = Object.keys(owed) as PlayerId[];
    // Discards resolve before the robber moves: the victim of a steal must have discarded first.
    if (owing.length > 0) tx.push(makeStep(STEP.discard, owing, { owed }));
  } else {
    applyProduction(ctx, tx, total);
  }
  return OK_VOID;
}

export const rollHandler: StepHandler = {
  actions(ctx, state, _step, actor) {
    return [
      spec(ACTION.roll, [{ type: ACTION.roll }], { note: 'roll the dice' }),
      ...devCardSpecs(ctx, state, actor, 'you may play a development card before rolling'),
    ];
  },

  apply(ctx, tx, _step, actor, action): Result<void, RuleViolation> {
    if (action.type === ACTION.roll) return doRoll(ctx, tx, actor);
    if (action.type === ACTION.playDev) return playDevCard(ctx, tx, actor, action);
    return violation('wrongStep', 'you must roll the dice', { expected: ACTION.roll });
  },
};

// ── Development cards ───────────────────────────────────────────────────────────────────────

/**
 * Play a development card: ownership, timing, then the card's own behaviour.
 *
 * The timing checks are the two rules players argue about, and both are enforced from state
 * rather than from a flag that could drift: "not the turn you bought it" compares the card's own
 * `acquiredTurn` (so buying three cards in a turn and playing an older one is fine), and "one per
 * turn" is a turn flag cleared by `beginTurn`.
 */
export function playDevCard(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const card = str<CardId>(action, 'card');
  if (!card.ok) return card;

  const instance = tx.state.cardInstances[card.value];
  if (instance === undefined) {
    return violation('illegalTarget', `no such card ${card.value}`, { card: card.value });
  }
  const hand = tx.state.players[actor]?.hands[instance.deck] ?? [];
  if (!hand.includes(card.value)) {
    return violation('illegalTarget', 'you do not hold that card', { card: card.value });
  }

  const def = cardDef(ctx.rules, instance.def);
  if (def === undefined || !def.playable || def.play === undefined) {
    return violation('illegalTarget', `${instance.def} cannot be played`, { def: instance.def });
  }
  if (instance.acquiredTurn === tx.state.turn.n) {
    return violation('notNow', 'you cannot play a development card the turn you buy it', {
      card: card.value,
    });
  }
  if (tx.flag(FLAG_DEV_PLAYED) >= DEV_CARDS_PER_TURN) {
    return violation('notNow', 'you may play only one development card per turn');
  }

  const played = def.play(ctx, tx, actor, action);
  if (!played.ok) return played;

  if (def.onPlay === 'reveal') tx.revealCard(actor, card.value);
  else tx.discardCard(actor, card.value);
  tx.bumpFlag(FLAG_DEV_PLAYED);
  tx.emit(event('playDev', { player: actor, card: card.value, def: instance.def }));
  return OK_VOID;
}

/** One spec per playable card in hand, with the card's own payload variants spliced in. */
function devCardSpecs(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  note: string,
): readonly ActionSpec[] {
  if ((state.turn.flags[FLAG_DEV_PLAYED] ?? 0) >= DEV_CARDS_PER_TURN) return [];
  const player = state.players[actor];
  if (player === undefined) return [];

  const options: Action[] = [];
  for (const hand of Object.values(player.hands)) {
    for (const card of hand) {
      const instance = state.cardInstances[card];
      if (instance === undefined || instance.acquiredTurn === state.turn.n) continue;
      const def = cardDef(ctx.rules, instance.def);
      if (def === undefined || !def.playable) continue;
      for (const payload of def.payloads?.(ctx, state, actor) ?? [{}]) {
        options.push({ type: ACTION.playDev, card, ...payload });
      }
    }
  }
  return options.length === 0 ? [] : [spec(ACTION.playDev, options, { note })];
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

function doBuild(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const kind = str<PieceKind>(action, 'kind');
  if (!kind.ok) return kind;
  const at = str<LocusId>(action, 'at');
  if (!at.ok) return at;

  const meta = pieceKind(ctx.rules, kind.value);
  if (meta === undefined) {
    return violation('illegalTarget', `${kind.value} is not a piece in this ruleset`);
  }
  return buildPiece(ctx, tx, actor, kind.value, at.value, { connection: meta.connection });
}

function doBuyDev(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const named = optionalStr<DeckId>(action, 'deck');
  if (!named.ok) return named;
  const deckId = named.value ?? DEV_DECK;

  const deckSpec = ctx.rules.decks[deckId];
  if (deckSpec === undefined) {
    return violation('illegalTarget', `there is no ${deckId} deck`, { deck: deckId });
  }
  if ((tx.state.decks[deckId]?.draw.length ?? 0) === 0) {
    return violation('supplyEmpty', 'the development deck is empty', { deck: deckId });
  }
  const player = tx.state.players[actor];
  if (player === undefined) return violation('illegalTarget', `unknown player ${actor}`);
  if (!canAfford(player, deckSpec.cost)) {
    return violation('cannotAfford', 'you cannot pay for a development card', {
      cost: deckSpec.cost,
    });
  }

  tx.transfer(actor, BANK, deckSpec.cost);
  const card = tx.drawCard(deckId, actor);
  if (card === undefined) throw new Error('buyDev: the deck emptied between check and draw');

  // Which card was drawn is the buyer's business alone — everyone else learns only that the deck
  // shrank by one.
  tx.emit(
    secretEvent(
      'buyDev',
      { player: actor, deck: deckId, remaining: tx.state.decks[deckId]?.draw.length ?? 0 },
      { card, def: tx.state.cardInstances[card]?.def },
      [actor],
    ),
  );
  return OK_VOID;
}

function doTradeBank(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const give = bundle(action, 'give');
  if (!give.ok) return give;
  const want = bundle(action, 'want');
  if (!want.ok) return want;

  const player = tx.state.players[actor];
  if (player === undefined) return violation('illegalTarget', `unknown player ${actor}`);
  if (!maritimeExchangeIsValid(ctx, tx.state, actor, give.value, want.value)) {
    return violation('illegalTarget', 'that is not a valid exchange at your trade rates', {
      give: give.value,
      want: want.value,
    });
  }
  if (!canPay(player.cards, give.value)) {
    return violation('cannotAfford', 'you do not hold what you offered', { give: give.value });
  }
  if (!bankCanPay(tx.state, want.value)) {
    return violation('bankShort', 'the bank cannot pay that out', { want: want.value });
  }

  tx.transfer(actor, BANK, give.value);
  tx.transfer(BANK, actor, want.value);
  tx.emit(event('trade', { player: actor, with: BANK, give: give.value, want: want.value }));
  return OK_VOID;
}

function doOfferTrade(
  ctx: RuleContext,
  tx: Tx,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const give = bundle(action, 'give');
  if (!give.ok) return give;
  const want = bundle(action, 'want');
  if (!want.ok) return want;

  const tradeable = (b: Record<string, number | undefined>): boolean =>
    Object.entries(b).every(
      ([kind, n]) => n === 0 || ctx.rules.cardKinds[kind]?.tradeable === true,
    );
  if (!tradeable(give.value) || !tradeable(want.value)) {
    return violation('illegalTarget', 'those cards cannot be traded between players');
  }
  // Both sides must be non-empty: the rules forbid giving resources away, which is what stops
  // a losing player from handing their hand to a friend.
  if (Object.keys(give.value).length === 0 || Object.keys(want.value).length === 0) {
    return violation('illegalTarget', 'a trade must offer and ask for cards');
  }

  const player = tx.state.players[actor];
  if (player === undefined) return violation('illegalTarget', `unknown player ${actor}`);
  if (!canPay(player.cards, give.value)) {
    return violation('cannotAfford', 'you cannot offer what you do not hold', { give: give.value });
  }

  const others = tx.state.seatOrder.filter((p) => p !== actor);
  if (others.length === 0) return violation('illegalTarget', 'there is nobody to trade with');

  // The offerer is on the actor list too, so they can close the deal — or withdraw it — without
  // waiting for the last undecided player.
  tx.push(
    makeStep(STEP.trade, [...others, actor], {
      from: actor,
      give: give.value,
      want: want.value,
      responses: {},
    }),
  );
  tx.emit(event('tradeOffered', { player: actor, give: give.value, want: want.value }));
  return OK_VOID;
}

function doEndTurn(ctx: RuleContext, tx: Tx, actor: PlayerId): Result<void, RuleViolation> {
  tx.pop();
  tx.push(beginTurnStep(nextPlayer(tx.state, actor)));
  tx.emit(event('endTurn', { player: actor }));
  void ctx;
  return OK_VOID;
}

export const mainHandler: StepHandler = {
  actions(ctx, state, _step, actor) {
    return [
      ...buildSpecs(ctx, state, actor),
      ...buySpecs(ctx, state, actor),
      ...devCardSpecs(ctx, state, actor, 'play a development card'),
      ...tradeSpecs(ctx, state, actor),
      spec(ACTION.endTurn, [{ type: ACTION.endTurn }], { note: 'end your turn' }),
    ];
  },

  apply(ctx, tx, _step, actor, action): Result<void, RuleViolation> {
    switch (action.type) {
      case ACTION.build:
        return doBuild(ctx, tx, actor, action);
      case ACTION.buyDev:
        return doBuyDev(ctx, tx, actor, action);
      case ACTION.playDev:
        return playDevCard(ctx, tx, actor, action);
      case ACTION.tradeBank:
        return doTradeBank(ctx, tx, actor, action);
      case ACTION.offerTrade:
        return doOfferTrade(ctx, tx, actor, action);
      case ACTION.endTurn:
        return doEndTurn(ctx, tx, actor);
      default:
        return violation('unknownAction', `${action.type} is not something you can do now`, {
          action: action.type,
        });
    }
  },
};

/** Build options for every buildable piece kind the player can currently afford and place. */
function buildSpecs(ctx: RuleContext, state: GameState, actor: PlayerId): readonly ActionSpec[] {
  const player = state.players[actor];
  if (player === undefined) return [];

  const out: ActionSpec[] = [];
  for (const meta of Object.values(ctx.rules.pieceKinds)) {
    if (!meta.owned || meta.cost === undefined) continue;
    if (!canAfford(player, meta.cost)) continue;
    if (meta.limit !== null && (player.supply[meta.id] ?? 0) <= 0) continue;

    // An upgrade's targets are the owner's own pieces of the source kind, which `placementOptions`
    // would reject as occupied — correctly, for everything that is not an upgrade.
    const loci =
      meta.upgradesFrom === undefined
        ? placementOptions(ctx, state, actor, meta.id, meta.connection)
        : piecesOf(state.board, actor, meta.upgradesFrom).map((p) => p.at as LocusId);
    if (loci.length === 0) continue;
    out.push(
      spec(
        ACTION.build,
        loci.map((at) => ({ type: ACTION.build, kind: meta.id, at })),
        { note: `build a ${meta.id}` },
      ),
    );
  }
  return out;
}

function buySpecs(ctx: RuleContext, state: GameState, actor: PlayerId): readonly ActionSpec[] {
  const player = state.players[actor];
  if (player === undefined) return [];
  const out: ActionSpec[] = [];
  for (const deck of Object.values(ctx.rules.decks)) {
    if ((state.decks[deck.id]?.draw.length ?? 0) === 0) continue;
    if (!canAfford(player, deck.cost)) continue;
    out.push(
      spec(ACTION.buyDev, [{ type: ACTION.buyDev, deck: deck.id }], {
        note: `buy a card from the ${deck.id} deck`,
      }),
    );
  }
  return out;
}

/**
 * Maritime exchanges the player can currently make, plus a marker for player trades.
 *
 * Bank trades are enumerated because the space is small: one option per (kind you can spare at
 * your rate) × (kind you want). Player trades are not — any bundle for any bundle is
 * combinatorial — so the spec says so and the client composes the offer.
 */
function tradeSpecs(ctx: RuleContext, state: GameState, actor: PlayerId): readonly ActionSpec[] {
  const player = state.players[actor];
  if (player === undefined) return [];

  const kinds = kindsWhere(ctx.rules, (m) => m.maritime);
  const options: Action[] = [];
  for (const give of kinds) {
    const rate = maritimeRate(ctx, state, actor, give);
    if ((player.cards[give] ?? 0) < rate) continue;
    for (const want of kinds) {
      if (want === give || (state.bank[want] ?? 0) < 1) continue;
      options.push({ type: ACTION.tradeBank, give: { [give]: rate }, want: { [want]: 1 } });
    }
  }

  const out: ActionSpec[] = [];
  if (options.length > 0)
    out.push(spec(ACTION.tradeBank, options, { note: 'trade with the bank' }));
  if (state.seatOrder.length > 1) {
    out.push(
      spec(ACTION.offerTrade, [], {
        enumerated: false,
        note: 'offer any bundle of cards to the other players',
      }),
    );
  }
  return out;
}

// ── freeBuild ───────────────────────────────────────────────────────────────────────────────

/**
 * A placement someone else paid for — Road Building's two roads.
 *
 * Optional, because the rulebook lets a player who has nowhere legal to place simply forfeit it.
 * An unskippable step would deadlock a boxed-in player, which is the sort of bug that only shows
 * up in a real game.
 */
export const freeBuildHandler: StepHandler = {
  actions(ctx, state, step, actor) {
    const kind = stepStr<PieceKind>(step, 'kind');
    if (kind === undefined) return [];
    const meta = pieceKind(ctx.rules, kind);
    const loci = placementOptions(ctx, state, actor, kind, meta?.connection ?? 'none');
    const out: ActionSpec[] = [
      spec(
        ACTION.place,
        loci.map((at) => ({ type: ACTION.place, at })),
        { note: `place a free ${kind}` },
      ),
    ];
    if (step.optional === true) {
      out.push(spec(ACTION.skip, [{ type: ACTION.skip }], { note: 'forfeit this placement' }));
    }
    return out;
  },

  apply(ctx, tx, step, actor, action): Result<void, RuleViolation> {
    if (action.type === ACTION.skip) {
      if (step.optional !== true) {
        return violation('wrongStep', 'this placement cannot be skipped');
      }
      tx.pop();
      tx.emit(event('skip', { player: actor, step: step.kind }));
      return OK_VOID;
    }
    if (action.type !== ACTION.place) {
      return violation('wrongStep', 'you must place the piece you were given', {
        expected: ACTION.place,
      });
    }

    const kind = stepStr<PieceKind>(step, 'kind');
    if (kind === undefined) throw new Error('freeBuild: step does not name a piece kind');
    const at = str<LocusId>(action, 'at');
    if (!at.ok) return at;

    const meta = pieceKind(ctx.rules, kind);
    const built = buildPiece(ctx, tx, actor, kind, at.value, {
      free: true,
      connection: meta?.connection ?? 'none',
    });
    if (!built.ok) return built;
    tx.pop();
    return OK_VOID;
  },
};
