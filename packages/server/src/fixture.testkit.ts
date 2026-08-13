/**
 * Rooms to test against, driven the way a client drives them.
 *
 * The helpers here never reach into the session for a legal move: they read the `options` off the
 * update message the room just sent, exactly as a browser would. A test that asked the engine
 * directly would be testing the engine, which is already tested — what is under test here is that
 * the room *tells* people what they may do.
 */

import type { Action, PlayerId } from '@catan/core';
import { baseRules, newGame, Session, scenarioForPlayers } from '@catan/core';

import type { ServerMessage } from './protocol.js';
import { Room } from './room.js';
import type { Tokens } from './tokens.js';

/** Readable tokens. Derived like the real ones, so restart-recovery behaves the same. */
export function testTokens(): Tokens {
  let spectators = 0;
  const seatToken = (room: string, seat: PlayerId): string => `seat-${room}-${seat}`;
  return {
    forSeat: seatToken,
    forSpectator: () => `spectator-${++spectators}`,
    seatOf: (room, token, seats) => seats.find((seat) => seatToken(room, seat) === token),
  };
}

export function makeRoom(id = 'r1', players = 4, seed = 11): Room {
  const game = newGame({
    scenario: scenarioForPlayers(players),
    rules: baseRules(),
    seed,
    players,
  });
  return new Room(id, new Session(game, { checkInvariants: true }), testTokens());
}

export interface Table {
  readonly room: Room;
  /** Seat → token, in the order the seats were claimed. */
  readonly tokens: ReadonlyMap<PlayerId, string>;
  readonly spectator: string;
}

/** A room with every seat claimed and one spectator watching. */
export function seatEveryone(id = 'r1', players = 4, seed = 11): Table {
  const room = makeRoom(id, players, seed);
  const tokens = new Map<PlayerId, string>();
  for (const _seat of room.seats) {
    const joined = room.join({ token: null, name: null });
    if (!joined.ok) throw new Error(joined.error.message);
    if (joined.value.seat === null) throw new Error('seatEveryone: ran out of seats');
    tokens.set(joined.value.seat, joined.value.token);
  }
  const watcher = room.join({ token: null, name: null });
  if (!watcher.ok) throw new Error(watcher.error.message);
  return { room, tokens, spectator: watcher.value.token };
}

export function update(message: ServerMessage): Extract<ServerMessage, { t: 'update' }> {
  if (message.t !== 'update') throw new Error(`expected an update, got ${message.t}`);
  return message;
}

/** Who the room is waiting on, from the public view — the same read a client makes. */
export function actorsOf(room: Room): readonly PlayerId[] {
  const step = update(room.snapshot(null)).view.stack.at(-1);
  if (step === undefined || step.actor === 'system') return [];
  return Array.isArray(step.actor) ? (step.actor as readonly PlayerId[]) : [step.actor as PlayerId];
}

/** The first action offered to `seat`, taken off the message the room would send them. */
export function offeredTo(room: Room, seat: PlayerId): Action | undefined {
  return update(room.snapshot(seat))
    .options.flatMap((spec) => spec.options)
    .at(0);
}

/** Play `moves` actions, always taking the first thing offered to whoever is up. */
export function playOn(table: Table, moves: number): number {
  let played = 0;
  for (let i = 0; i < moves; i++) {
    const seat = actorsOf(table.room)[0];
    if (seat === undefined) break;
    const action = offeredTo(table.room, seat);
    const token = table.tokens.get(seat);
    if (action === undefined || token === undefined) break;
    const result = table.room.act(token, action);
    if (!result.ok) throw new Error(`playOn: ${result.error.code} — ${result.error.message}`);
    played += 1;
  }
  return played;
}
