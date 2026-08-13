/**
 * The client, against the real server.
 *
 * `remote.ts` writes down its own idea of the wire, deliberately — a browser bundle has no business
 * importing a package that imports `node:http`. This file is what keeps that copy honest: it starts
 * an actual `@catan/server`, drives a `RemoteTable` over an actual websocket, and asserts on what
 * comes back. If the two ever drift apart, they drift apart here rather than in someone's tab.
 *
 * The last test is the one worth reading. It restarts the server underneath a connected client:
 * the socket drops, the room is rebuilt from its action log, the seat token is recomputed from the
 * secret rather than looked up, and the client reconnects into the seat it was already sitting in.
 * Three separate pieces of the design have to be right for that to work.
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

const SECRET = 'test-secret';

async function serve(store = new MemoryStore(), port = 0): Promise<RunningServer> {
  const server = await startServer({ secret: SECRET, port, store, log: () => {} });
  servers.push(server);
  return server;
}

/** A seat store with no browser under it. Shared between "tabs" by passing the same one. */
function memorySeats(): SeatStore {
  const held = new Map<string, string>();
  return {
    get: (room) => held.get(room) ?? null,
    set: (room, token) => void held.set(room, token),
  };
}

async function table(server: RunningServer, room: string, seats = memorySeats()) {
  const remote = await RemoteTable.connect({ room, origin: server.url, seats });
  tables.push(remote);
  return remote;
}

async function room(server: RunningServer, players = 3, seed = 11): Promise<string> {
  return (await createRoom({ origin: server.url, players, seed })).id;
}

/** Wait for something the server will tell us about, rather than for a duration. */
async function waitFor(what: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('RemoteTable', () => {
  it('joins a room and can draw the board from what it was sent', async () => {
    const server = await serve();
    const id = await room(server);
    const remote = await table(server, id);

    expect(remote.seat).toBe('p0');
    // The rule context was rebuilt from the view's scenario id: the server sent no board graph.
    expect(remote.ctx.topology.hexes).toHaveLength(37);
    expect(remote.ctx.scenario.id).toBe('catan/base/3-4');

    const snap = remote.snapshot();
    expect(snap.viewer).toBe('p0');
    expect(snap.view.rng).toBeNull();
    expect(snap.at).toBe(0);
    expect(snap.options.flatMap((spec) => spec.options).length).toBeGreaterThan(20);
  });

  it('offers exactly one viewpoint — its own', async () => {
    const server = await serve();
    const id = await room(server);
    const red = await table(server, id);
    const blue = await table(server, id);

    expect(red.viewpoints).toEqual(['p0']);
    expect(blue.viewpoints).toEqual(['p1']);
    // Blue is not being waited on, so Blue is offered nothing at all.
    expect(blue.snapshot().options).toEqual([]);
    expect(blue.snapshot().view.viewer).toBe('p1');
  });

  it('plays a move, and everyone at the table sees it', async () => {
    const server = await serve();
    const id = await room(server);
    const red = await table(server, id);
    const blue = await table(server, id);

    const action = red.snapshot().options.flatMap((spec) => spec.options)[0];
    if (action === undefined) throw new Error('nothing offered');
    red.act('p0' as never, action);

    await waitFor(() => red.snapshot().at === 1 && blue.snapshot().at === 1);
    expect(blue.snapshot().events.some((event) => event.type === 'build')).toBe(true);
    expect(red.label).toBe(`Room ${id} · live`);
  });

  it('shows the refusal rather than guessing at it', async () => {
    const server = await serve();
    const id = await room(server);
    const red = await table(server, id);

    // Legal-looking, and wrong: the opening is not over.
    red.act('p0' as never, { type: 'endTurn' });
    await waitFor(() => red.notice !== null);

    expect(red.notice).toContain('opening');
    expect(red.snapshot().at).toBe(0);
    red.dismiss();
    expect(red.notice).toBeNull();
  });

  it('keeps a seat across a reconnect, when the server was the thing that went away', async () => {
    const store = new MemoryStore();
    const first = await serve(store);
    const id = await room(first);
    const seats = memorySeats();
    const red = await table(first, id, seats);

    const action = red.snapshot().options.flatMap((spec) => spec.options)[0];
    if (action === undefined) throw new Error('nothing offered');
    red.act('p0' as never, action);
    await waitFor(() => red.snapshot().at === 1);

    // The server goes away and comes back on the same port, with the same store and secret and
    // nothing else: no rooms in memory, no record of who was sitting where.
    const port = first.port;
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    expect(red.ready).toBe(false);
    expect(red.notice).toBe('Reconnecting…');

    await serve(store, port);
    await waitFor(() => red.ready);

    // The room came back from its log, and the seat came back from the secret.
    expect(red.seat).toBe('p0');
    expect(red.snapshot().at).toBe(1);
    expect(red.snapshot().view.viewer).toBe('p0');

    const next = red.snapshot().options.flatMap((spec) => spec.options)[0];
    if (next === undefined) throw new Error('nothing offered after the reconnect');
    red.act('p0' as never, next);
    await waitFor(() => red.snapshot().at === 2);
  });

  it('reports what the server refuses to create', async () => {
    const server = await serve();
    await expect(createRoom({ origin: server.url, players: 2 })).rejects.toThrow(/3 to 10/);
    await expect(RemoteTable.connect({ room: 'nosuch', origin: server.url })).rejects.toThrow(
      /could not connect/,
    );
  });
});
