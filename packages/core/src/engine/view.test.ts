/**
 * What a client is allowed to see.
 *
 * These are security tests as much as they are behaviour tests: every assertion here is something
 * that, if it went the other way, would let one player read another's hand or predict the deck.
 */

import { describe, expect, it } from 'vitest';
import {
  act,
  advanceToMain,
  grant,
  laterTurn,
  newBaseGame,
  offered,
  P,
  playSetup,
  rollUntilRobber,
  stackDeck,
} from '../game.testkit.js';
import type { CardId } from '../ids.js';
import { redactEvents } from '../rules/event.js';
import { DEV_CARD_COST } from '../rulesets/base/tables.js';
import { reduce } from './reduce.js';
import { redactFor } from './view.js';

const [p0, p1] = P as [(typeof P)[0], (typeof P)[1]];

const game = newBaseGame(11);
const opened = playSetup(game);

/** A state where p0 holds a known development card. */
function withCard(def: string) {
  const state = stackDeck(grant(advanceToMain(game, opened, p0), p0, DEV_CARD_COST), 'dev', [def]);
  return act(game.ctx, state, p0, { type: 'buyDev' });
}

describe('redactFor', () => {
  const state = withCard('knight');
  const card = state.players[p0]?.hands.dev?.[0] as CardId;

  it('never ships the generator', () => {
    for (const viewer of [p0, p1, null]) {
      expect(redactFor(state, viewer).rng).toBeNull();
    }
    // And not by accident of a missing field: the whole state must serialise without it.
    expect(JSON.stringify(redactFor(state, p0))).not.toContain('"rng":[');
  });

  it('never ships the seed, which would re-deal the deck', () => {
    for (const viewer of [p0, p1, null]) {
      expect(redactFor(state, viewer).seed).toBeNull();
    }
    // The concrete attack: `newGame` is deterministic in `(seed, scenarioId, ruleSetId, players)`
    // and the last three are public, so a leaked seed is the draw pile spelled differently.
    expect(JSON.stringify(redactFor(state, p0))).not.toContain(`"seed":${game.state.seed}`);
  });

  it('replaces the draw pile with a count', () => {
    const view = redactFor(state, p0);
    expect(view.decks.dev?.remaining).toBe(24);
    expect(JSON.stringify(view.decks)).not.toContain(state.decks.dev?.draw[0] ?? 'nothing');
  });

  it('shows a card only to the player holding it', () => {
    expect(redactFor(state, p0).cardInstances[card]?.def).toBe('knight');
    expect(redactFor(state, p1).cardInstances[card]?.def).toBeNull();
    expect(redactFor(state, null).cardInstances[card]?.def).toBeNull();
  });

  it('still shows that the card exists, so a UI can count hands', () => {
    // The id stays visible; only the identity is hidden. That is what lets a client draw "p0 has
    // one development card" and animate the right one when it is played.
    expect(redactFor(state, p1).players[p0]?.hands.dev).toEqual([card]);
  });

  it('shows a played knight to everyone', () => {
    const played = act(game.ctx, laterTurn(game, state, p0), p0, { type: 'playDev', card });
    expect(redactFor(played, p1).cardInstances[card]?.def).toBe('knight');
  });

  it('scores a view exactly as the opponents would score it', () => {
    // p0's hidden victory-point card counts for p0 and for nobody else's arithmetic.
    const hidden = withCard('library');
    const own = hidden.players[p0]?.hands.dev?.[0] as CardId;
    expect(game.ctx.rules.victoryPoints(game.ctx, hidden, p0)).toBe(3);
    expect(game.ctx.rules.victoryPoints(game.ctx, redactFor(hidden, p0), p0)).toBe(3);
    expect(game.ctx.rules.victoryPoints(game.ctx, redactFor(hidden, p1), p0)).toBe(2);
    expect(redactFor(hidden, p1).cardInstances[own]?.def).toBeNull();
  });
});

describe('redactEvents', () => {
  it('shows a steal to the thief and the victim, and to nobody else', () => {
    // Roll until a 7 comes up, settling any discards it forces along the way.
    let state = rollUntilRobber(game, advanceToMain(game, opened, p0));
    while (state.stack.at(-1)?.kind === 'discard') {
      const actor = ([state.stack.at(-1)?.actor].flat()[0] ?? '') as typeof p0;
      state = act(game.ctx, state, actor, offered(game.ctx, state, actor, 'discard')[0] as never);
    }

    const roller = (state.stack.at(-1)?.actor ?? '') as typeof p0;
    const option = offered(game.ctx, state, roller, 'moveRobber').find((o) => o.victim !== null);
    expect(option).toBeDefined();

    const result = reduce(game.ctx, state, roller, option as never);
    if (!result.ok) throw new Error(result.error.message);
    const victim = option?.victim as typeof p0;

    const asVictim = redactEvents(result.value.events, victim).find((e) => e.type === 'steal');
    const asOther = redactEvents(
      result.value.events,
      state.seatOrder.find((p) => p !== victim && p !== roller) as typeof p0,
    ).find((e) => e.type === 'steal');

    expect(asVictim?.secret).toBeDefined();
    expect(asOther?.secret).toBeUndefined();
    // The event itself is still delivered — everyone saw *a* card move — so clients stay in step.
    expect(asOther?.data.hidden).toBe(true);
  });
});
