/**
 * Player-to-player trading.
 *
 * The published rules are a negotiation — "you may trade with the other players in any way you
 * like" — which a networked game has to give some shape without narrowing what players can
 * actually agree to. The shape here is one step holding the offer:
 *
 * - The offerer proposes a bundle for a bundle. They must hold what they offer; the rules forbid
 *   giving resources away, so a bluff offer is not merely rude, it is illegal.
 * - Everyone else accepts or declines, in any order, and may change their mind while the offer
 *   stands.
 * - The offerer picks one acceptor and closes, or withdraws. They are on the step's actor list
 *   too, so they never have to wait for the last undecided player.
 *
 * Both sides are re-checked at the moment the trade closes, not at the moment of acceptance: a
 * player who accepted and then lost the cards to a robber cannot complete.
 */

import type { PlayerId } from '../../../ids.js';
import { OK_VOID, type Result } from '../../../result.js';
import { bool, playerField, spec } from '../../../rules/action.js';
import { event } from '../../../rules/event.js';
import type { StepHandler } from '../../../rules/ruleset.js';
import { canPay } from '../../../rules/trade.js';
import { type RuleViolation, violation } from '../../../rules/violation.js';
import type { Cost, Step } from '../../../state/gameState.js';
import { ACTION, stepRecord, stepStr } from '../common.js';

function offerees(step: Step, from: PlayerId): readonly PlayerId[] {
  const actors = Array.isArray(step.actor) ? step.actor : [];
  return actors.filter((p) => p !== from);
}

export const tradeHandler: StepHandler = {
  actions(_ctx, _state, step, actor) {
    const from = stepStr<PlayerId>(step, 'from');
    if (from === undefined) return [];
    const responses = stepRecord(step, 'responses');

    if (actor !== from) {
      return [
        spec(
          ACTION.respondTrade,
          [
            { type: ACTION.respondTrade, accept: true },
            { type: ACTION.respondTrade, accept: false },
          ],
          { note: 'accept or decline the offer' },
        ),
      ];
    }

    const accepted = offerees(step, from).filter((p) => responses[p] === true);
    return [
      spec(
        ACTION.completeTrade,
        accepted.map((p) => ({ type: ACTION.completeTrade, with: p })),
        { note: 'trade with a player who accepted' },
      ),
      spec(ACTION.cancelTrade, [{ type: ACTION.cancelTrade }], { note: 'withdraw the offer' }),
    ];
  },

  apply(_ctx, tx, step, actor, action): Result<void, RuleViolation> {
    const from = stepStr<PlayerId>(step, 'from');
    if (from === undefined) throw new Error('trade: the step does not name an offerer');
    const give = stepRecord(step, 'give') as Cost;
    const want = stepRecord(step, 'want') as Cost;

    if (actor === from) {
      if (action.type === ACTION.cancelTrade) {
        tx.pop();
        tx.emit(event('tradeClosed', { player: from, outcome: 'cancelled' }));
        return OK_VOID;
      }
      if (action.type !== ACTION.completeTrade) {
        return violation('wrongStep', 'you can only complete or withdraw your offer', {
          expected: ACTION.completeTrade,
        });
      }

      const partner = playerField(action, 'with');
      if (!partner.ok) return partner;
      if (stepRecord(step, 'responses')[partner.value] !== true) {
        return violation('illegalTarget', 'that player has not accepted your offer', {
          with: partner.value,
        });
      }

      const seller = tx.state.players[partner.value];
      const buyer = tx.state.players[from];
      if (seller === undefined || buyer === undefined) {
        return violation('illegalTarget', 'that player is not in this game');
      }
      if (!canPay(buyer.cards, give)) {
        return violation('cannotAfford', 'you no longer hold what you offered', { give });
      }
      if (!canPay(seller.cards, want)) {
        return violation('cannotAfford', 'they no longer hold what you asked for', { want });
      }

      tx.transfer(from, partner.value, give);
      tx.transfer(partner.value, from, want);
      tx.pop();
      tx.emit(event('trade', { player: from, with: partner.value, give, want }));
      return OK_VOID;
    }

    // An offeree.
    if (action.type !== ACTION.respondTrade) {
      return violation('wrongStep', 'you can only accept or decline the offer', {
        expected: ACTION.respondTrade,
      });
    }
    const accept = bool(action, 'accept');
    if (!accept.ok) return accept;

    const responder = tx.state.players[actor];
    if (responder === undefined) return violation('illegalTarget', `unknown player ${actor}`);
    if (accept.value && !canPay(responder.cards, want)) {
      return violation('cannotAfford', 'you do not hold what was asked for', { want });
    }

    const responses = { ...stepRecord(step, 'responses') } as Record<string, boolean>;
    responses[actor] = accept.value;
    tx.emit(event('tradeResponse', { player: actor, accept: accept.value }));

    // Nobody left who might say yes: close the offer rather than making the offerer click again.
    if (offerees(step, from).every((p) => responses[p] === false)) {
      tx.pop();
      tx.emit(event('tradeClosed', { player: from, outcome: 'declined' }));
      return OK_VOID;
    }
    tx.amendTop({ responses });
    return OK_VOID;
  },
};
