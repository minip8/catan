/**
 * The 7: discards, then the robber.
 *
 * Two steps, in that order, because the steal must happen after the discards — a victim who is
 * about to lose half their hand should lose it before the thief picks a card, or the thief's odds
 * of taking any particular resource are wrong.
 *
 * The discard step is the clearest case for the whole continuation-stack design. Its actor is a
 * **list**: every player over the limit owes cards, they act in any order, and none of them is the
 * active player. A phase enum plus `turn.active` cannot express that at all, which is why so many
 * implementations resolve discards by fiat instead of asking.
 */

import { hasHex } from '../../../board/topology.js';
import type { CardKind, HexId, PlayerId } from '../../../ids.js';
import { OK_VOID, type Result } from '../../../result.js';
import { pick } from '../../../rng.js';
import { type Action, bundle, bundleSize, optionalStr, spec, str } from '../../../rules/action.js';
import { event, secretEvent } from '../../../rules/event.js';
import { pieceKind, type RuleContext, type StepHandler } from '../../../rules/ruleset.js';
import { canPay } from '../../../rules/trade.js';
import { type RuleViolation, violation } from '../../../rules/violation.js';
import type { GameState, Piece } from '../../../state/gameState.js';
import { player as playerOf } from '../../../state/gameState.js';
import { BANK, type Tx } from '../../../state/tx.js';
import { ACTION, stealableKinds, stealCandidates, stepRecord, suggestDiscard } from '../common.js';

// ── discard ─────────────────────────────────────────────────────────────────────────────────

export const discardHandler: StepHandler = {
  actions(ctx, state, step, actor) {
    const due = stepRecord(step, 'owed')[actor];
    const player = state.players[actor];
    if (typeof due !== 'number' || due <= 0 || player === undefined) return [];
    // The real space is combinatorial (a hand of eight has seventy four-card discards), so the
    // spec carries one sensible suggestion and says it is not the whole space.
    return [
      spec(ACTION.discard, [{ type: ACTION.discard, cards: suggestDiscard(ctx, player, due) }], {
        enumerated: false,
        note: `discard ${due} cards`,
      }),
    ];
  },

  apply(ctx, tx, step, actor, action): Result<void, RuleViolation> {
    if (action.type !== ACTION.discard) {
      return violation('wrongStep', 'you must discard before play continues', {
        expected: ACTION.discard,
      });
    }

    const owed = { ...stepRecord(step, 'owed') } as Record<string, number>;
    const due = owed[actor] ?? 0;
    if (due <= 0) return violation('notNow', 'you owe no cards');

    const cards = bundle(action, 'cards');
    if (!cards.ok) return cards;
    if (bundleSize(cards.value) !== due) {
      return violation('malformed', `you must discard exactly ${due} cards`, { due });
    }
    for (const kind of Object.keys(cards.value)) {
      if (ctx.rules.cardKinds[kind]?.countsTowardHandLimit !== true) {
        return violation('illegalTarget', `${kind} is not counted against the hand limit`, {
          kind,
        });
      }
    }
    const player = tx.state.players[actor];
    if (player === undefined) return violation('illegalTarget', `unknown player ${actor}`);
    if (!canPay(player.cards, cards.value)) {
      return violation('cannotAfford', 'you do not hold those cards', { cards: cards.value });
    }

    tx.transfer(actor, BANK, cards.value);
    tx.emit(event('discard', { player: actor, cards: cards.value }));

    delete owed[actor];
    const remaining = (Array.isArray(step.actor) ? step.actor : [step.actor]).filter(
      (p) => p !== actor,
    );
    if (remaining.length === 0) tx.pop();
    else tx.replaceTop({ kind: step.kind, actor: remaining, data: { ...step.data, owed } });
    return OK_VOID;
  },
};

// ── robber ──────────────────────────────────────────────────────────────────────────────────

/** The board's robber — any unowned piece that blocks production. */
function findBlocker(ctx: RuleContext, state: GameState): Piece | undefined {
  return Object.values(state.board.pieces).find(
    (p) => p.owner === null && pieceKind(ctx.rules, p.kind)?.blocksProduction === true,
  );
}

/**
 * Take one card at random from a victim.
 *
 * Uniform over **cards, not kinds**: a victim holding four ore and one wool loses ore four times
 * out of five. Picking a kind uniformly would quietly make hoarding one resource safe.
 */
function steal(ctx: RuleContext, tx: Tx, thief: PlayerId, victim: PlayerId): void {
  const hand = playerOf(tx.state, victim);
  const pool: CardKind[] = [];
  for (const kind of stealableKinds(ctx, hand)) {
    for (let i = 0; i < (hand.cards[kind] ?? 0); i++) pool.push(kind);
  }
  const taken = tx.random((rng) => pick(rng, pool));
  if (taken === undefined) return;

  tx.transfer(victim, thief, { [taken]: 1 });
  // Both parties see what moved; everyone else sees only that something did.
  tx.emit(secretEvent('steal', { from: victim, to: thief }, { kind: taken }, [victim, thief]));
}

export const robberHandler: StepHandler = {
  actions(ctx, state, _step, actor) {
    const blocker = findBlocker(ctx, state);
    const options: Action[] = [];
    for (const hex of ctx.topology.hexes) {
      if (state.board.hexes[hex]?.class !== 'land' || hex === blocker?.at) continue;
      const victims = stealCandidates(ctx, state, hex, actor);
      if (victims.length === 0) options.push({ type: ACTION.moveRobber, hex, victim: null });
      for (const victim of victims) options.push({ type: ACTION.moveRobber, hex, victim });
    }
    return [spec(ACTION.moveRobber, options, { note: 'move the robber and steal a card' })];
  },

  apply(ctx, tx, _step, actor, action): Result<void, RuleViolation> {
    if (action.type !== ACTION.moveRobber) {
      return violation('wrongStep', 'you must move the robber', { expected: ACTION.moveRobber });
    }

    const hex = str<HexId>(action, 'hex');
    if (!hex.ok) return hex;
    const victim = optionalStr<PlayerId>(action, 'victim');
    if (!victim.ok) return victim;

    const blocker = findBlocker(ctx, tx.state);
    if (blocker === undefined) throw new Error('robber: this board has no robber piece');

    if (!hasHex(ctx.topology, hex.value)) {
      return violation('illegalTarget', `${hex.value} is not a hex on this board`, {
        hex: hex.value,
      });
    }
    if (tx.state.board.hexes[hex.value]?.class !== 'land') {
      return violation('illegalTarget', 'the robber can only stand on land', { hex: hex.value });
    }
    if (blocker.at === hex.value) {
      return violation('illegalTarget', 'the robber must move to a different hex', {
        hex: hex.value,
      });
    }

    // Validated before anything moves, so a rejected action never half-applies. (The draft would
    // be discarded anyway — this keeps the failure legible in a debugger.)
    const candidates = stealCandidates(ctx, tx.state, hex.value, actor);
    if (candidates.length === 0) {
      if (victim.value !== null) {
        return violation('illegalTarget', 'there is nobody to steal from there', {
          hex: hex.value,
        });
      }
    } else if (victim.value === null || !candidates.includes(victim.value)) {
      return violation(
        'illegalTarget',
        'you must steal from a player with a building on that hex',
        { hex: hex.value, candidates },
      );
    }

    tx.movePiece(blocker.id, hex.value);
    tx.emit(event('robber', { player: actor, hex: hex.value, piece: blocker.id }));
    if (victim.value !== null) steal(ctx, tx, actor, victim.value);

    tx.pop();
    return OK_VOID;
  },
};
