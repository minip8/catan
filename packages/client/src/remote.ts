/**
 * The same screen, driven by a server.
 *
 * A remote table holds exactly one view — the one the server sent it — and cannot construct
 * another. That is not a limitation to work around; it is the property the whole redaction design
 * exists to produce. The board is drawn from a `PlayerView`, the buttons from the `options` that
 * came with it, and a move is a frame on a socket whose refusal arrives as a message rather than
 * being predicted locally.
 *
 * The wire types below are declared here rather than imported from `@catan/server`, deliberately.
 * A browser bundle has no business depending on a package that imports `node:http`, and a client's
 * idea of a protocol is a legitimate thing to write down. What keeps the two honest is
 * `remote.test.ts`, which runs this file against the real server.
 *
 * Reconnection is the one piece of genuine complexity. A socket that drops takes nothing with it:
 * the seat token is in `localStorage`, the room rebuilds from its log, and rejoining is the same
 * message as joining. What is lost is the *log* of what happened while the tab was away — the
 * server sends a snapshot, not a history — which is worth knowing and not worth fixing here.
 */

import type { Action, ActionSpec, GameEvent, PlayerId, PlayerView, RuleContext } from '@catan/core';

import { contextFor, Observable, type Snapshot, type Table } from './table.js';

// ── The wire, as this client understands it ─────────────────────────────────────────────────

interface Welcome {
  readonly t: 'welcome';
  readonly room: string;
  readonly seat: PlayerId | null;
  readonly token: string;
}

interface Update {
  readonly t: 'update';
  readonly room: string;
  readonly at: number;
  readonly view: PlayerView;
  readonly options: readonly ActionSpec[];
  readonly events: readonly GameEvent[];
  readonly seats: readonly { seat: PlayerId; name: string; connected: boolean }[];
}

interface Refusal {
  readonly t: 'error';
  readonly code: string;
  readonly message: string;
}

type Incoming = Welcome | Update | Refusal;

// ── Seat tokens ─────────────────────────────────────────────────────────────────────────────

/** Where the seat token is kept between visits. The only credential this client holds. */
export interface SeatStore {
  get(room: string): string | null;
  set(room: string, token: string): void;
}

/** `localStorage` where there is one, memory where there is not — a test, or a locked-down tab. */
export function browserSeats(): SeatStore {
  const fallback = new Map<string, string>();
  const key = (room: string): string => `catan.seat.${room}`;
  return {
    get(room) {
      try {
        return globalThis.localStorage?.getItem(key(room)) ?? fallback.get(room) ?? null;
      } catch {
        return fallback.get(room) ?? null;
      }
    },
    set(room, token) {
      fallback.set(room, token);
      try {
        globalThis.localStorage?.setItem(key(room), token);
      } catch {
        // A tab with storage disabled keeps its seat for as long as it stays open, and no longer.
      }
    },
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────

export interface RoomSummary {
  readonly id: string;
  readonly players: number;
  readonly seed: number;
  readonly scenarioId: string;
}

export async function createRoom(options: {
  readonly origin?: string;
  readonly players: number;
  readonly seed?: number;
}): Promise<RoomSummary> {
  const origin = options.origin ?? defaultOrigin();
  const response = await fetch(`${origin}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      players: options.players,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `the server refused to make a room (${response.status})`);
  }
  return (await response.json()) as RoomSummary;
}

function defaultOrigin(): string {
  return globalThis.location?.origin ?? 'http://localhost:3000';
}

// ── The table ───────────────────────────────────────────────────────────────────────────────

export interface RemoteOptions {
  readonly room: string;
  /** Where the server is. Defaults to this page's origin, which is what the dev proxy arranges. */
  readonly origin?: string;
  readonly name?: string;
  readonly seats?: SeatStore;
  /** How long to wait for the first update before giving up. */
  readonly timeoutMs?: number;
}

/** Backoff between reconnection attempts, in milliseconds. Stops growing at five seconds. */
const RETRY_MS = [250, 500, 1000, 2000, 5000];

export class RemoteTable extends Observable implements Table {
  readonly ctx: RuleContext;
  readonly room: string;
  readonly seat: PlayerId | null;

  private readonly url: string;
  private readonly seats: SeatStore;
  private readonly name: string | null;

  private socket: WebSocket;
  private latest: Update;
  private readonly events: GameEvent[] = [];
  private message: string | null = null;
  private state: 'live' | 'connecting' | 'closed' = 'live';
  private attempts = 0;

  private constructor(init: {
    room: string;
    url: string;
    seat: PlayerId | null;
    socket: WebSocket;
    first: Update;
    seats: SeatStore;
    name: string | null;
  }) {
    super();
    this.room = init.room;
    this.url = init.url;
    this.seat = init.seat;
    this.socket = init.socket;
    this.latest = init.first;
    this.seats = init.seats;
    this.name = init.name;
    this.ctx = contextFor(init.first.view);
    this.events.push(...init.first.events);
    this.listen();
  }

  /** Connect, join, and wait for the first picture of the game. */
  static async connect(options: RemoteOptions): Promise<RemoteTable> {
    const origin = options.origin ?? defaultOrigin();
    const url = `${origin.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(options.room)}`;
    const seats = options.seats ?? browserSeats();
    const name = options.name ?? null;

    const socket = await open(url, options.timeoutMs ?? 10_000);
    const { welcome, first } = await handshake(socket, seats.get(options.room), name);
    seats.set(options.room, welcome.token);

    return new RemoteTable({
      room: options.room,
      url,
      seat: welcome.seat,
      socket,
      first,
      seats,
      name,
    });
  }

  get viewpoints(): readonly (PlayerId | null)[] {
    // One. A remote client cannot look through anyone else's eyes, which is the point.
    return [this.seat];
  }

  get label(): string {
    const where = this.state === 'live' ? 'live' : this.state === 'closed' ? 'closed' : 'offline';
    return `Room ${this.room} · ${where}`;
  }

  get ready(): boolean {
    return this.state === 'live';
  }

  get notice(): string | null {
    if (this.state === 'connecting') return 'Reconnecting…';
    return this.message;
  }

  snapshot(): Snapshot {
    return {
      viewer: this.seat,
      view: this.latest.view,
      options: this.latest.options,
      events: this.events,
      at: this.latest.at,
    };
  }

  act(_viewer: PlayerId, action: Action): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.message = 'Not connected — the move was not sent.';
      this.changed();
      return;
    }
    this.socket.send(JSON.stringify({ t: 'act', action }));
  }

  /** Ask for a fresh picture. Cheap, and the fix for a client that suspects it has drifted. */
  sync(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ t: 'sync' }));
  }

  dismiss(): void {
    this.message = null;
  }

  close(): void {
    this.state = 'closed';
    this.socket.close();
  }

  // ── The socket ────────────────────────────────────────────────────────────────────────────

  private listen(): void {
    this.socket.addEventListener('message', (event) => this.receive(String(event.data)));
    this.socket.addEventListener('close', () => {
      if (this.state === 'closed') return;
      this.state = 'connecting';
      this.changed();
      this.retry();
    });
  }

  private receive(raw: string): void {
    let message: Incoming;
    try {
      message = JSON.parse(raw) as Incoming;
    } catch {
      return;
    }

    switch (message.t) {
      case 'update':
        this.latest = message;
        this.events.push(...message.events);
        this.message = null;
        this.changed();
        return;
      case 'error':
        // Including the refusals the rules produce. The client offered only what the server said
        // was legal, so anything here is either a stale offer or a bug — both worth showing.
        this.message = message.message;
        this.changed();
        return;
      default:
        return;
    }
  }

  private retry(): void {
    const wait = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)] as number;
    this.attempts += 1;
    setTimeout(() => {
      if (this.state === 'closed') return;
      void this.reconnect();
    }, wait);
  }

  private async reconnect(): Promise<void> {
    try {
      const socket = await open(this.url, 10_000);
      const { welcome, first } = await handshake(socket, this.seats.get(this.room), this.name);
      if (this.state === 'closed') {
        socket.close();
        return;
      }
      // The seat comes back with the token, so the game carries on where it left off. What does
      // not come back is the log of what happened while we were away: `first` is a snapshot.
      this.seats.set(this.room, welcome.token);
      this.socket = socket;
      this.latest = first;
      this.state = 'live';
      this.attempts = 0;
      this.message = null;
      this.listen();
      this.changed();
    } catch {
      this.retry();
    }
  }
}

// ── Connecting ──────────────────────────────────────────────────────────────────────────────

function open(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out connecting to ${url}`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`could not connect to ${url}`));
    });
  });
}

/** Send `join` and wait for the welcome and the first update. */
function handshake(
  socket: WebSocket,
  token: string | null,
  name: string | null,
): Promise<{ welcome: Welcome; first: Update }> {
  return new Promise((resolve, reject) => {
    let welcome: Welcome | undefined;

    const onMessage = (event: MessageEvent): void => {
      let message: Incoming;
      try {
        message = JSON.parse(String(event.data)) as Incoming;
      } catch {
        return;
      }
      if (message.t === 'error') {
        socket.removeEventListener('message', onMessage);
        reject(new Error(`${message.code}: ${message.message}`));
        return;
      }
      if (message.t === 'welcome') {
        welcome = message;
        return;
      }
      if (message.t === 'update' && welcome !== undefined) {
        socket.removeEventListener('message', onMessage);
        resolve({ welcome, first: message });
      }
    };

    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ t: 'join', token, name }));
  });
}
