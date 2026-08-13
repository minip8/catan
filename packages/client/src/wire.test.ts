/**
 * A whole game, played over the wire.
 *
 * Three clients, one server, and no shortcuts: each table plays only what its own `options` offer,
 * every move crosses a socket, and the game runs until someone wins. It is the widest test in the
 * repository — engine, redaction, room, transport and client all have to be right at once — and it
 * is fast because the engine is.
 *
 * The assertions at the end are about what each client *knew*. A table's own view is complete; its
 * view of the others is not, and the difference is exactly the hidden information the game is
 * played with.
 */

import { MemoryStore, type RunningServer, startServer } from '@catan/server';
import { afterEach, describe, expect, it } from 'vitest';

import { createRoom, RemoteTable, type SeatStore } from './remote.js';

const servers: RunningServer[] = [];
const tables: RemoteTable[] = [];

afterEach(async () => {
  for (const table of tables.splice(0)) table.close();
  for (const server of servers.splice(0)) await server.close();
});

function memorySeats(): SeatStore {
  const held = new Map<string, string>();
  return {
    get: (room) => held.get(room) ?? null,
    set: (room, token) => void held.set(room, token),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a game over the wire', () => {
  it('plays to a winner with three clients', async () => {
    const server = await startServer({
      secret: 'wire',
      store: new MemoryStore(),
      log: () => {},
    });
    servers.push(server);

    const room = (await createRoom({ origin: server.url, players: 3, seed: 5 })).id;
    for (let i = 0; i < 3; i++) {
      tables.push(await RemoteTable.connect({ room, origin: server.url, seats: memorySeats() }));
    }
    expect(tables.map((table) => table.seat)).toEqual(['p0', 'p1', 'p2']);

    let moves = 0;
    for (; moves < 2000; moves++) {
      const table = tables.find((t) =>
        t.snapshot().options.some((spec) => spec.options.length > 0),
      );
      if (table === undefined) break;
      const seat = table.seat;
      if (seat === null) break;

      const action = table.snapshot().options.flatMap((spec) => spec.options)[0];
      if (action === undefined) break;
      const before = table.snapshot().at;
      table.act(seat, action);

      // Wait for the server to answer before looking again: this client's next legal move depends
      // on a game state only the server has.
      for (let wait = 0; wait < 200 && table.snapshot().at === before; wait++) await settle();
      if (table.snapshot().at === before) throw new Error(`no answer to ${action.type}`);
    }

    const [red, blue, white] = tables as [RemoteTable, RemoteTable, RemoteTable];
    expect(moves).toBeGreaterThan(60);

    // Everyone agrees about how far the game got, and about who won.
    expect(blue.snapshot().at).toBe(red.snapshot().at);
    expect(white.snapshot().at).toBe(red.snapshot().at);
    const outcome = red.snapshot().view.outcome;
    expect(outcome).not.toBeNull();
    expect(blue.snapshot().view.outcome).toEqual(outcome);

    // Each client saw its own cards and not the others'. A development card in an opponent's hand
    // is an id with no definition attached — which is all the table can see of it too.
    for (const table of tables) {
      const view = table.snapshot().view;
      const mine = Object.values(view.players[table.seat as never]?.hands ?? {}).flat();
      for (const card of mine) expect(view.cardInstances[card]?.def).not.toBeNull();

      const theirs = Object.values(view.players)
        .filter((player) => player.id !== table.seat)
        .flatMap((player) => Object.values(player.hands).flat())
        .filter((card) => !view.players[table.seat as never]?.revealed.includes(card));
      for (const card of theirs) expect(view.cardInstances[card]?.def).toBeNull();
    }

    // And the log each client kept is its own: the winner's is at least as long as a spectator's
    // would be, because only they were told what they drew.
    expect(red.snapshot().events.length).toBeGreaterThan(60);

    // No client was ever told the seed, which would have re-dealt the deck they were betting on.
    for (const table of tables) expect(table.snapshot().view.seed).toBeNull();

    // Now that the game is over there is nothing left to bet on, so the record — and the seed
    // inside it — becomes public. Hidden while it matters, quotable once it does not.
    const finished = await fetch(`${server.url}/rooms/${room}/record`);
    expect(finished.status).toBe(200);
    expect((await finished.json()) as { seed: number }).toMatchObject({ seed: 5 });

    const listed = (await (await fetch(`${server.url}/rooms`)).json()) as {
      rooms: { seed?: number }[];
    };
    expect(listed.rooms[0]?.seed).toBe(5);
  });
});
