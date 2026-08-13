/**
 * The room, played without a socket.
 *
 * Two properties carry most of the weight, and both are things a transport cannot fix if the room
 * gets them wrong: **a seat is whatever the token says it is**, and **every message is redacted for
 * the viewer it was addressed to**. The rest is bookkeeping.
 */

import { describe, expect, it } from 'vitest';

import { actorsOf, makeRoom, offeredTo, playOn, seatEveryone, update } from './fixture.testkit.js';

describe('joining', () => {
  it('hands out seats in order, then admits spectators', () => {
    const room = makeRoom('r1', 3);
    const seats = room.seats;

    for (const expected of seats) {
      const joined = room.join({ token: null, name: null });
      if (!joined.ok) throw new Error(joined.error.message);
      expect(joined.value.seat).toBe(expected);
    }

    const watcher = room.join({ token: null, name: null });
    if (!watcher.ok) throw new Error(watcher.error.message);
    // A full game is a thing people want to watch, so the fourth arrival is not turned away.
    expect(watcher.value.seat).toBeNull();
    expect(room.open).toEqual([]);
  });

  it('resumes the same seat for the same token, without consuming another', () => {
    const room = makeRoom('r1', 3);
    const first = room.join({ token: null, name: null });
    if (!first.ok) throw new Error(first.error.message);

    const again = room.join({ token: first.value.token, name: 'Ada' });
    if (!again.ok) throw new Error(again.error.message);

    expect(again.value.seat).toBe(first.value.seat);
    expect(room.open).toHaveLength(2);
    expect(room.seatInfo()[0]?.name).toBe('Ada');
    // Two connections on one token is a second tab, not a second player.
    expect(room.member(first.value.token)?.connections).toBe(2);
  });

  it('refuses a token it does not recognise', () => {
    const room = makeRoom();
    const joined = room.join({ token: 'seat-otherRoom-p0', name: null });
    expect(joined.ok).toBe(false);
    if (joined.ok) return;
    expect(joined.error.code).toBe('unknownToken');
  });

  it('recognises a seat token minted before the room was rebuilt', () => {
    // A restarted server replays the log into a *new* `Room` with no members. The seat token is
    // derived rather than remembered, so the player who was sitting there still is.
    const fresh = makeRoom('r1', 3);
    const rejoined = fresh.join({ token: 'seat-r1-p1', name: null });
    if (!rejoined.ok) throw new Error(rejoined.error.message);

    expect(rejoined.value.seat).toBe('p1');
    expect(fresh.open).toEqual(['p0', 'p2']);
  });

  it('reports who is connected', () => {
    const room = makeRoom('r1', 3);
    const joined = room.join({ token: null, name: 'Ada' });
    if (!joined.ok) throw new Error(joined.error.message);

    expect(room.seatInfo()).toEqual([
      { seat: 'p0', name: 'Ada', connected: true },
      { seat: 'p1', name: 'Seat 2', connected: false },
      { seat: 'p2', name: 'Seat 3', connected: false },
    ]);

    room.leave(joined.value.token);
    expect(room.seatInfo()[0]).toEqual({ seat: 'p0', name: 'Ada', connected: false });
    // The seat is still theirs: dropping a connection is not leaving the game.
    expect(room.open).toEqual(['p1', 'p2']);
  });
});

describe('acting', () => {
  it('attributes a move to the token that sent it', () => {
    const table = seatEveryone();
    const first = actorsOf(table.room)[0];
    if (first === undefined) throw new Error('nobody is up');
    const action = offeredTo(table.room, first);
    if (action === undefined) throw new Error('nothing offered');

    // The same action, from the seat that was not asked.
    const wrongSeat = table.room.act(table.tokens.get('p1' as never) as string, action);
    expect(wrongSeat.ok).toBe(false);
    if (!wrongSeat.ok) expect(wrongSeat.error.code).toBe('notYourStep');
    expect(table.room.at).toBe(0);

    const played = table.room.act(table.tokens.get(first) as string, action);
    expect(played.ok).toBe(true);
    expect(table.room.at).toBe(1);
  });

  it('lets a spectator watch and nothing else', () => {
    const table = seatEveryone();
    const seat = actorsOf(table.room)[0];
    if (seat === undefined) throw new Error('nobody is up');
    const action = offeredTo(table.room, seat);
    if (action === undefined) throw new Error('nothing offered');

    const refused = table.room.act(table.spectator, action);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('notSeated');

    // A spectator is offered nothing, which is also what a seated player who is not up is offered.
    expect(update(table.room.snapshot(null)).options).toEqual([]);
  });

  it('passes the refusal from the rules through unchanged', () => {
    const table = seatEveryone();
    const seat = table.room.seats[0] as never;
    const refused = table.room.act(table.tokens.get(seat) as string, { type: 'endTurn' });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The room does not paraphrase: this is the violation the rules produced.
    expect(refused.error.code).toBe('wrongStep');
    expect(refused.error.message).toContain('opening');
    expect(table.room.at).toBe(0);
  });

  it('sends one message per seat plus spectators, each redacted for its viewer', () => {
    const table = seatEveryone();
    const seat = actorsOf(table.room)[0];
    if (seat === undefined) throw new Error('nobody is up');
    const action = offeredTo(table.room, seat);
    if (action === undefined) throw new Error('nothing offered');

    const played = table.room.act(table.tokens.get(seat) as string, action);
    if (!played.ok) throw new Error(played.error.message);

    expect(played.value.map((b) => b.viewer)).toEqual([...table.room.seats, null]);
    for (const broadcast of played.value) {
      const message = update(broadcast.message);
      expect(message.view.viewer).toBe(broadcast.viewer);
      // The single most important assertion in this package: the generator never travels.
      expect(message.view.rng).toBeNull();
      expect(message.at).toBe(1);
      expect(message.options.length > 0).toBe(broadcast.viewer === seat);
    }
  });

  it('shows a bought development card to its buyer and to nobody else', () => {
    const table = seatEveryone('r1', 4, 8);
    playOn(table, 16); // the opening
    const buyer = actorsOf(table.room)[0];
    if (buyer === undefined) throw new Error('nobody is up');

    // Roll, then buy.
    const roll = update(table.room.snapshot(buyer))
      .options.flatMap((spec) => spec.options)
      .find((action) => action.type === 'roll');
    if (roll === undefined) throw new Error('no roll offered');
    const rolled = table.room.act(table.tokens.get(buyer) as string, roll);
    if (!rolled.ok) throw new Error(rolled.error.message);

    const buy = update(table.room.snapshot(buyer))
      .options.flatMap((spec) => spec.options)
      .find((action) => action.type === 'buyDev');
    if (buy === undefined) throw new Error('seed 8 was meant to fund a card here');
    const bought = table.room.act(table.tokens.get(buyer) as string, buy);
    if (!bought.ok) throw new Error(bought.error.message);

    const mine = bought.value.find((b) => b.viewer === buyer);
    const theirs = bought.value.find((b) => b.viewer === null);
    const secretOf = (broadcast: typeof mine): unknown =>
      update(broadcast?.message as never).events.find((e) => e.type === 'buyDev')?.secret;

    expect(secretOf(mine)).toBeDefined();
    expect(secretOf(theirs)).toBeUndefined();
  });
});

describe('the record', () => {
  it('grows with the game and replays to it', async () => {
    const { replay } = await import('@catan/core');
    const table = seatEveryone('r1', 4, 5);
    const moves = playOn(table, 30);

    expect(moves).toBeGreaterThan(16);
    expect(table.room.at).toBe(moves);
    expect(table.room.record.actions).toHaveLength(moves);
    expect(replay(table.room.record).state).toEqual(table.room.session.state);
  });
});
