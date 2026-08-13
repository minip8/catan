/**
 * The transport: HTTP for room management, websockets for play.
 *
 * This is the only file in the package that knows a socket exists. It parses frames, looks up the
 * room, hands the request to it, and posts the messages the room hands back to whichever sockets
 * they belong to. Every decision worth arguing about was made in `room.ts`, which is why that file
 * has the tests and this one has the plumbing.
 *
 * Two things are worth pointing at:
 *
 * - **Routing is by viewer, not by socket.** A room returns one message per seat plus one for
 *   spectators, already redacted. The transport matches each socket's viewer to one of them. There
 *   is no path through this file that can send a socket a message built for someone else, because
 *   it never builds one.
 * - **The upgrade is refused before the handshake** when the room does not exist, so a client gets
 *   a 404 rather than an open socket that immediately errors.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';

import type { PlayerId } from '@catan/core';
import { WebSocket, WebSocketServer } from 'ws';

import { errorMessage, parseClientMessage, type ServerMessage } from './protocol.js';
import type { Broadcast, Room } from './room.js';
import { Rooms } from './rooms.js';
import { serveStatic } from './static.js';
import { MemoryStore, type RecordStore } from './store.js';
import { ephemeralSecret, hmacTokens } from './tokens.js';

export interface ServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** Defaults to an in-memory store: a server for a laptop, forgotten on exit. */
  readonly store?: RecordStore;
  /** Signs seat tokens. Supply one in production, or every restart invalidates every seat. */
  readonly secret?: string;
  readonly checkInvariants?: boolean;
  readonly log?: (message: string) => void;
  /**
   * Serve a built client from this directory.
   *
   * With it, the deployment is one process and the client talks to its own origin. Without it, the
   * server is an API and something else hosts the files.
   */
  readonly staticDir?: string;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly rooms: Rooms;
  close(): Promise<void>;
}

/** Largest request body accepted. Room creation is three numbers; anything larger is a mistake. */
const MAX_BODY = 4096;

interface Client {
  readonly socket: WebSocket;
  readonly room: Room;
  token: string | null;
  viewer: PlayerId | null;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((message: string) => console.log(message));
  const store = options.store ?? new MemoryStore();
  const rooms = new Rooms({
    store,
    tokens: hmacTokens(options.secret ?? ephemeralSecret()),
    ...(options.checkInvariants === undefined ? {} : { checkInvariants: options.checkInvariants }),
  });

  const clients = new Set<Client>();
  const sockets = new WebSocketServer({ noServer: true });
  const http = createHttpServer((request, response) => {
    void handleHttp(request, response, rooms, options.staticDir).catch((cause: unknown) => {
      log(`http: ${String(cause)}`);
      send(response, 500, { error: 'internal error' });
    });
  });

  http.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('room');
    const room = url.pathname === '/ws' && id !== null ? await rooms.open(id) : undefined;
    if (room === undefined) {
      // Refused before the handshake: a client learns it asked for a room that is not there,
      // instead of holding an open socket that answers every message with an error.
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => attach(ws, room));
  }

  function attach(socket: WebSocket, room: Room): void {
    const client: Client = { socket, room, token: null, viewer: null };
    clients.add(client);

    socket.on('message', (raw) => {
      void receive(client, String(raw)).catch((cause: unknown) => {
        log(`ws: ${String(cause)}`);
        post(client, errorMessage({ code: 'internal', message: 'the server broke' }));
      });
    });

    socket.on('close', () => {
      clients.delete(client);
      if (client.token !== null) fan(room, room.leave(client.token));
    });

    socket.on('error', (cause) => log(`ws: ${String(cause)}`));
  }

  async function receive(client: Client, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      post(client, errorMessage(parsed.error));
      return;
    }
    const message = parsed.value;
    const room = client.room;

    switch (message.t) {
      case 'join': {
        const joined = room.join({ token: message.token, name: message.name });
        if (!joined.ok) {
          post(client, errorMessage(joined.error));
          return;
        }
        client.token = joined.value.token;
        client.viewer = joined.value.seat;
        post(client, joined.value.welcome);
        fan(room, joined.value.broadcasts);
        return;
      }

      case 'act': {
        if (client.token === null) {
          post(client, errorMessage({ code: 'notJoined', message: 'join before acting' }));
          return;
        }
        const played = room.act(client.token, message.action);
        if (!played.ok) {
          post(client, errorMessage(played.error));
          return;
        }
        fan(room, played.value);
        try {
          await rooms.persist(room);
        } catch (cause) {
          // The move stands: the engine applied it and everyone has been told. Only the *record*
          // is behind, and the next successful save carries it, because every save writes the log
          // in full. Say so rather than pretending, and rather than rolling back a legal move.
          log(`store: could not save room ${room.id}: ${String(cause)}`);
          post(
            client,
            errorMessage({ code: 'notSaved', message: 'the move stands but was not persisted' }),
          );
        }
        return;
      }

      case 'sync':
        post(client, room.snapshot(client.viewer));
        return;
    }
  }

  /** Send each socket the message built for the viewer it is watching as. */
  function fan(room: Room, broadcasts: readonly Broadcast[]): void {
    for (const client of clients) {
      // A socket that has not joined is told nothing, not even the public view. It has not said
      // who it is, and an open socket is not yet a member of the table.
      if (client.room !== room || client.token === null) continue;
      const mine = broadcasts.find((b) => b.viewer === client.viewer);
      if (mine !== undefined) post(client, mine.message);
    }
  }

  function post(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(message));
  }

  const port = await listen(http, options.port ?? 0, options.host ?? '127.0.0.1');
  const url = `http://${options.host ?? '127.0.0.1'}:${port}`;
  log(`catan-server listening on ${url}`);

  return {
    url,
    port,
    rooms,
    async close(): Promise<void> {
      for (const client of clients) client.socket.close();
      clients.clear();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  rooms: Rooms,
  staticDir: string | undefined,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // The API carries no cookies — a seat is proved by a token inside the websocket session — so
  // there is no ambient authority for another origin to borrow, and no CSRF surface to protect.
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  if (request.method === 'GET' && path === '/health') {
    send(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && path === '/rooms') {
    send(response, 200, { rooms: rooms.summaries(), saved: await rooms.saved() });
    return;
  }

  if (request.method === 'POST' && path === '/rooms') {
    const body = await readBody(request);
    if (!body.ok) {
      send(response, 400, { error: body.error });
      return;
    }
    const players = Number((body.value as Record<string, unknown>).players ?? 4);
    const seedField = (body.value as Record<string, unknown>).seed;
    if (!Number.isInteger(players) || players < 3 || players > 10) {
      send(response, 400, { error: 'players must be an integer from 3 to 10' });
      return;
    }
    if (seedField !== undefined && !Number.isSafeInteger(seedField)) {
      send(response, 400, { error: 'seed must be an integer' });
      return;
    }
    const room = await rooms.create({
      players,
      ...(typeof seedField === 'number' ? { seed: seedField } : {}),
    });
    send(response, 201, {
      id: room.id,
      players: room.seats.length,
      seed: room.session.state.seed,
      scenarioId: room.session.state.scenarioId,
    });
    return;
  }

  const record = /^\/rooms\/([^/]+)\/record$/.exec(path);
  if (request.method === 'GET' && record !== null) {
    const room = await rooms.open(decodeURIComponent(record[1] as string));
    if (room === undefined) {
      send(response, 404, { error: 'no such room' });
      return;
    }
    // The whole game, as decisions. Small enough to paste into a bug report, and enough to rebuild
    // the room exactly — which is what makes a desync report actionable.
    send(response, 200, room.record);
    return;
  }

  // The API is matched first, so a client bundle can never shadow a route the game needs.
  if (request.method === 'GET' && staticDir !== undefined) {
    if (await serveStatic(staticDir, path, response)) return;
  }

  send(response, 404, { error: 'no such route' });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(
  request: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) return { ok: false, error: 'body too large' };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'body must be a JSON object' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'body must be JSON' };
  }
}

function listen(
  http: ReturnType<typeof createHttpServer>,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      const address = http.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server: could not determine the listening port'));
        return;
      }
      resolve(address.port);
    });
  });
}
