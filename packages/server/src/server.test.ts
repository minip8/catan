/**
 * The server, over a real socket.
 *
 * Everything here talks to `startServer` the way a browser would: an HTTP call to make a room, a
 * websocket to play it, and JSON frames in both directions. The unit tests already cover what the
 * room decides; what is under test here is the wiring — that a message reaches the socket it was
 * built for, that a refused upgrade is refused before the handshake, and that the record served
 * over HTTP really does rebuild the game the server is holding.
 */

import { replay } from '@catan/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { ServerMessage } from './protocol.js';
import { type RunningServer, startServer } from './server.js';

const running: RunningServer[] = [];
const open: Client[] = [];

afterEach(async () => {
  for (const client of open.splice(0)) client.close();
  for (const server of running.splice(0)) await server.close();
});

async function serve(): Promise<RunningServer> {
  const server = await startServer({ secret: 'test-secret', log: () => {} });
  running.push(server);
  return server;
}

async function post(
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A websocket client that queues what it receives, so tests can await a condition, not a count. */
class Client {
  private readonly socket: WebSocket;
  private readonly received: ServerMessage[] = [];
  private waiters: (() => void)[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      this.received.push(JSON.parse(String(event.data)) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static connect(server: RunningServer, room: string): Promise<Client> {
    const url = `${server.url.replace('http', 'ws')}/ws?room=${encodeURIComponent(room)}`;
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => {
        const client = new Client(socket);
        open.push(client);
        resolve(client);
      });
      socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)));
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** A frame the client had no business sending. */
  raw(text: string): void {
    this.socket.send(text);
  }

  /** The first message matching `match`, waiting for it to arrive if it has not yet. */
  async expect<T extends ServerMessage['t']>(
    type: T,
    match: (message: Extract<ServerMessage, { t: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    for (;;) {
      const found = this.received.find(
        (message): message is Extract<ServerMessage, { t: T }> =>
          message.t === type && match(message as Extract<ServerMessage, { t: T }>),
      );
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  get messages(): readonly ServerMessage[] {
    return this.received;
  }

  close(): void {
    this.socket.close();
  }
}

/** Join and return the welcome. */
async function join(
  client: Client,
  token: string | null = null,
): Promise<{ seat: string | null; token: string }> {
  client.send({ t: 'join', token });
  const welcome = await client.expect('welcome');
  return { seat: welcome.seat, token: welcome.token };
}

describe('HTTP', () => {
  it('answers a health check', async () => {
    const server = await serve();
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('creates a room and lists it', async () => {
    const server = await serve();
    const created = await post(`${server.url}/rooms`, { players: 4, seed: 11 });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ players: 4, seed: 11, scenarioId: 'catan/base/3-4' });

    const listed = (await (await fetch(`${server.url}/rooms`)).json()) as {
      rooms: { id: string }[];
      saved: string[];
    };
    expect(listed.rooms.map((room) => room.id)).toEqual([created.body.id]);
    expect(listed.saved).toEqual([created.body.id]);
  });

  it('refuses a player count no scenario covers', async () => {
    const server = await serve();
    expect((await post(`${server.url}/rooms`, { players: 2 })).status).toBe(400);
    expect((await post(`${server.url}/rooms`, { players: 99 })).status).toBe(400);
    expect((await post(`${server.url}/rooms`, { players: 4, seed: 'x' })).status).toBe(400);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  });
});

describe('playing over a socket', () => {
  it('refuses the upgrade for a room that does not exist', async () => {
    const server = await serve();
    await expect(Client.connect(server, 'nosuchroom')).rejects.toThrow(/could not connect/);
  });

  it('seats the first two connections and plays the opening between them', async () => {
    const server = await serve();
    const { body } = await post(`${server.url}/rooms`, { players: 3, seed: 11 });
    const room = body.id as string;

    const red = await Client.connect(server, room);
    const blue = await Client.connect(server, room);
    const first = await join(red);
    const second = await join(blue);

    expect(first.seat).toBe('p0');
    expect(second.seat).toBe('p1');

    // Red is up: the update they were sent carries their options, and Blue's does not.
    const mine = await red.expect('update', (message) => message.options.length > 0);
    const theirs = await blue.expect('update');
    expect(theirs.options).toEqual([]);
    expect(theirs.view.viewer).toBe('p1');
    expect(theirs.view.rng).toBeNull();

    const action = mine.options.flatMap((spec) => spec.options)[0];
    if (action === undefined) throw new Error('nothing offered');
    red.send({ t: 'act', action });

    // Both sides see the move, and agree about how far the game has got.
    const after = await blue.expect('update', (message) => message.at === 1);
    expect(after.events.some((event) => event.type === 'build')).toBe(true);
    expect((await red.expect('update', (message) => message.at === 1)).at).toBe(after.at);
  });

  it('gives a seat back to the token that owns it', async () => {
    const server = await serve();
    const { body } = await post(`${server.url}/rooms`, { players: 3, seed: 11 });
    const room = body.id as string;

    const first = await Client.connect(server, room);
    const claimed = await join(first);
    first.close();

    const again = await Client.connect(server, room);
    expect((await join(again, claimed.token)).seat).toBe(claimed.seat);

    // And a token from nowhere gets nothing.
    const stranger = await Client.connect(server, room);
    stranger.send({ t: 'join', token: 'not-a-token' });
    expect((await stranger.expect('error')).code).toBe('unknownToken');
  });

  it('tells a client what it did wrong without dropping it', async () => {
    const server = await serve();
    const { body } = await post(`${server.url}/rooms`, { players: 3, seed: 11 });
    const room = body.id as string;
    const client = await Client.connect(server, room);

    // Acting before joining, then a frame that is not a message, then an illegal move.
    client.send({ t: 'act', action: { type: 'roll' } });
    expect((await client.expect('error')).code).toBe('notJoined');

    client.raw('}{');
    expect((await client.expect('error', (m) => m.code === 'badMessage')).code).toBe('badMessage');

    await join(client);
    client.send({ t: 'act', action: { type: 'endTurn' } });
    expect((await client.expect('error', (m) => m.code === 'wrongStep')).message).toContain(
      'opening',
    );

    // Still connected, and the game has not moved.
    client.send({ t: 'sync' });
    expect((await client.expect('update')).at).toBe(0);
    expect(server.rooms.get(room)?.at).toBe(0);
  });

  it('serves a record that rebuilds the game it is holding', async () => {
    const server = await serve();
    const { body } = await post(`${server.url}/rooms`, { players: 3, seed: 11 });
    const room = body.id as string;

    const client = await Client.connect(server, room);
    await join(client);
    for (let i = 0; i < 4; i++) {
      const update = await client.expect('update', (message) => message.at === i);
      const action = update.options.flatMap((spec) => spec.options)[0];
      if (action === undefined) break;
      client.send({ t: 'act', action });
    }
    await client.expect('update', (message) => message.at >= 2);

    const record = await (await fetch(`${server.url}/rooms/${room}/record`)).json();
    const rebuilt = replay(record as never);
    expect(rebuilt.state).toEqual(server.rooms.get(room)?.session.state);
    expect((await fetch(`${server.url}/rooms/nosuch/record`)).status).toBe(404);
  });
});
