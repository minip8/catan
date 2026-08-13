/**
 * What the log says, and — more importantly — what it does not say.
 *
 * The redaction tests here are the ones that matter. `redactEvent` is core's, and it is already
 * tested there; what is tested here is that the *narration* degrades properly when the secret is
 * gone, because a client that renders "undefined" or throws on a redacted event would either leak
 * the shape of the secret or break the log for everyone at the table but two.
 */

import { event, playerId, redactEvent, secretEvent } from '@catan/core';
import { describe, expect, it } from 'vitest';

import { fixture, P } from './fixture.testkit.js';
import { bundleText, describeAction, narrate } from './narrate.js';

const [p0, p1, p2] = P as [(typeof P)[0], (typeof P)[1], (typeof P)[2]];

describe('narrate', () => {
  it('names players by their seat colour', () => {
    const { view } = fixture();
    expect(narrate(view, event('turn', { player: p0, n: 1 })).text).toBe("Red's turn (turn 1)");
    expect(narrate(view, event('endTurn', { player: p1 })).text).toBe('Blue ends their turn');
  });

  it('reports a roll with its dice', () => {
    const { view } = fixture();
    const line = narrate(view, event('dice', { player: p0, dice: [3, 4], total: 7 }));
    expect(line.text).toBe('Red rolled 7 (3 + 4)');
    expect(line.seat).toBe(0);
  });

  it('tells the two players in a steal what was taken, and nobody else', () => {
    const { view } = fixture();
    const steal = secretEvent('steal', { from: p0, to: p1 }, { kind: 'ore' }, [p0, p1]);

    expect(narrate(view, redactEvent(steal, p1)).text).toBe('Blue steals Ore from Red');
    expect(narrate(view, redactEvent(steal, p2)).text).toBe('Blue steals a card from Red');
    expect(narrate(view, redactEvent(steal, null)).text).toBe('Blue steals a card from Red');
  });

  it('says a card was bought without saying which, unless it is yours', () => {
    const { view } = fixture();
    const buy = secretEvent(
      'buyDev',
      { player: p0, deck: 'dev', remaining: 24 },
      { card: 'c1', def: 'monopoly' },
      [p0],
    );
    expect(narrate(view, redactEvent(buy, p0)).text).toBe('Red buys a development card — Monopoly');
    expect(narrate(view, redactEvent(buy, p1)).text).toBe('Red buys a development card');
  });

  it('reads both shapes of a production event', () => {
    const { view } = fixture();
    const opening = narrate(view, event('production', { player: p0, cards: { wool: 1, ore: 1 } }));
    expect(opening.text).toBe('Red collects 1 Wool, 1 Ore');

    const roll = narrate(
      view,
      event('production', {
        roll: 8,
        grants: { [p0]: { brick: 2 }, [p1]: { grain: 1 } },
        claims: {},
        shorted: [],
      }),
    );
    expect(roll.text).toBe('Production on 8: Red 2 Brick, Blue 1 Grain');
    expect(roll.seat).toBeNull();
  });

  it('mentions a bank that ran short', () => {
    const { view } = fixture();
    const line = narrate(
      view,
      event('production', { roll: 5, grants: {}, claims: {}, shorted: ['ore'] }),
    );
    expect(line.text).toContain('the bank ran short of ore');
  });

  it('says when an award is set aside rather than won', () => {
    const { view } = fixture();
    const taken = narrate(view, event('award', { award: 'longestRoad', to: p1, best: 6 }));
    expect(taken.text).toBe('Blue takes Longest Road with 6');

    const aside = narrate(view, event('award', { award: 'longestRoad', to: null, best: 5 }));
    expect(aside.text).toBe('Longest Road is set aside — nobody leads');
  });

  it('falls back to the event name for anything an expansion adds', () => {
    const { view } = fixture();
    expect(narrate(view, event('barbarianAttack', {})).text).toBe('Barbarian Attack');
  });
});

describe('describeAction', () => {
  it('labels the actions the engine offers', () => {
    const { view } = fixture();
    expect(describeAction(view, { type: 'roll' })).toBe('Roll the dice');
    expect(describeAction(view, { type: 'build', kind: 'city', at: 'x' })).toBe('City');
    expect(describeAction(view, { type: 'moveRobber', hex: 'h', victim: null })).toBe(
      'Move the robber here',
    );
    expect(describeAction(view, { type: 'moveRobber', hex: 'h', victim: p2 })).toBe('Rob White');
    expect(describeAction(view, { type: 'completeTrade', with: p1 })).toBe('Trade with Blue');
  });

  it('spells out a maritime rate', () => {
    const { view } = fixture();
    const label = describeAction(view, {
      type: 'tradeBank',
      give: { ore: 3 },
      want: { brick: 1 },
    });
    expect(label).toBe('3 Ore → 1 Brick');
  });

  it('names a development card payload even when the card itself is hidden', () => {
    const { view, state } = fixture();
    const card = Object.keys(state.cardInstances)[0] as string;
    // A card still in the deck has no visible definition, which is the whole point of the deck.
    expect(view.cardInstances[card as never]?.def).toBeNull();
    expect(describeAction(view, { type: 'playDev', card, kind: 'ore' })).toBe('Hidden: Ore');
    expect(describeAction(view, { type: 'playDev', card, kinds: ['ore', 'wool'] })).toBe(
      'Hidden: Ore + Wool',
    );
  });
});

describe('bundleText', () => {
  it('reads out a bundle, and says so when there is nothing in it', () => {
    expect(bundleText({ brick: 2, ore: 1 })).toBe('2 Brick, 1 Ore');
    expect(bundleText({})).toBe('nothing');
    expect(bundleText(undefined)).toBe('nothing');
  });
});

describe('seats', () => {
  it('gives the six published colours in seat order', () => {
    const { view } = fixture(11, 6);
    const names = view.seatOrder.map((id) => narrate(view, event('endTurn', { player: id })).text);
    expect(names).toEqual([
      'Red ends their turn',
      'Blue ends their turn',
      'White ends their turn',
      'Orange ends their turn',
      'Green ends their turn',
      'Brown ends their turn',
    ]);
  });

  it('keeps going past six, where there is no official colour left', () => {
    const { view } = fixture(11, 8);
    expect(narrate(view, event('endTurn', { player: playerId(7) })).text).toBe(
      'Seat 8 ends their turn',
    );
  });
});
