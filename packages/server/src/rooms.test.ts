/**
 * Creating rooms, and getting them back.
 *
 * The recovery test is the one that earns its keep. A server that persists action logs but never
 * replays one has a backup nobody has restored — so the test below plays a game, throws away every
 * object involved, rebuilds from the store alone, and carries on playing with the same seat token.
 */

import { describe, expect, it } from 'vitest';

import { actorsOf, offeredTo, testTokens } from './fixture.testkit.js';
import type { Room } from './room.js';
import { Rooms } from './rooms.js';
import { MemoryStore } from './store.js';

function registry(store = new MemoryStore()): { rooms: Rooms; store: MemoryStore } {
  let n = 0;
  return {
    store,
    rooms: new Rooms({
      store,
      tokens: testTokens(),
      mintRoomId: () => `r${++n}`,
      randomSeed: () => 11,
    }),
  };
}

/** Play `moves` actions using the derived seat tokens, the way a reconnecting client would. */
function play(room: Room, moves: number): number {
  let played = 0;
  for (let i = 0; i < moves; i++) {
    const seat = actorsOf(room)[0];
    if (seat === undefined) break;
    const joined = room.join({ token: `seat-${room.id}-${seat}`, name: null });
    if (!joined.ok) throw new Error(joined.error.message);
    const action = offeredTo(room, seat);
    if (action === undefined) break;
    const result = room.act(joined.value.token, action);
    if (!result.ok) throw new Error(`${result.error.code} — ${result.error.message}`);
    played += 1;
  }
  return played;
}

describe('Rooms', () => {
  it('deals a game and saves it before anyone plays', async () => {
    const { rooms, store } = registry();
    const room = await rooms.create({ players: 4 });

    expect(room.id).toBe('r1');
    expect(room.seats).toHaveLength(4);
    expect(room.at).toBe(0);
    // Saved on creation, so a room that is made and then abandoned can still be rejoined.
    expect(await store.load('r1')).toEqual(room.record);
    expect(rooms.get('r1')).toBe(room);
  });

  it('reproduces a board exactly from a seed', async () => {
    const { rooms } = registry();
    const first = await rooms.create({ players: 4, seed: 4242 });
    const second = await rooms.create({ players: 4, seed: 4242 });

    expect(second.session.state.board).toEqual(first.session.state.board);
  });

  it('refuses to reuse an id', async () => {
    const { rooms } = registry();
    await rooms.create({ players: 4, id: 'table' });
    await expect(rooms.create({ players: 4, id: 'table' })).rejects.toThrow(/already exists/);
    await expect(rooms.create({ players: 4, id: '../etc' })).rejects.toThrow(/unsafe room id/);
  });

  it('rebuilds a room from its log alone, and keeps playing', async () => {
    const { rooms, store } = registry();
    const original = await rooms.create({ players: 4 });
    const moves = play(original, 20);
    await rooms.persist(original);
    expect(moves).toBeGreaterThan(16);

    // Everything the process was holding is gone: new registry, same disk.
    const restarted = new Rooms({ store, tokens: testTokens() });
    const room = await restarted.open('r1');
    if (room === undefined) throw new Error('the room did not come back');

    expect(room).not.toBe(original);
    expect(room.session.state).toEqual(original.session.state);
    expect(room.at).toBe(moves);
    // A seat token was derived, not stored, so the player who was sitting there still is.
    const rejoined = room.join({ token: 'seat-r1-p2', name: null });
    if (!rejoined.ok) throw new Error(rejoined.error.message);
    expect(rejoined.value.seat).toBe('p2');

    expect(play(room, 4)).toBe(4);
    expect(room.record.actions).toHaveLength(moves + 4);
    // The log still describes the whole game, not just the part played since the restart.
    expect(room.record.actions.slice(0, moves)).toEqual(original.record.actions);
  });

  it('knows nothing of a room that was never created', async () => {
    const { rooms } = registry();
    expect(await rooms.open('nope')).toBeUndefined();
    expect(await rooms.open('../etc/passwd')).toBeUndefined();
  });

  it('summarises what is in memory', async () => {
    const { rooms } = registry();
    const room = await rooms.create({ players: 3, seed: 7 });
    room.join({ token: null, name: null });

    expect(rooms.summaries()).toEqual([
      {
        id: room.id,
        scenarioId: 'catan/base/3-4',
        seed: 7,
        players: 3,
        at: 0,
        over: false,
        open: 2,
      },
    ]);
    expect(await rooms.saved()).toEqual([room.id]);
  });
});
