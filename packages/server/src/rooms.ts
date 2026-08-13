/**
 * The registry: which rooms exist, and how one comes back after a restart.
 *
 * Rooms are held in memory and backed by their action logs. `open` looks in memory first and falls
 * back to the store, so a server that was restarted — or one that has simply evicted an idle game —
 * reconstructs the room by replaying the decisions its players made. That path is exercised by the
 * tests, not merely available: recovery that is never run is recovery that does not work.
 *
 * Creating a game needs a seed, and a seed is the one piece of genuine entropy the whole system
 * consumes. It is drawn here, at the edge, and then written into the record — after which the game
 * is deterministic forever.
 */

import {
  baseRules,
  type GameRecord,
  newGame,
  restoreSession,
  Session,
  scenarioForPlayers,
} from '@catan/core';

import { Room } from './room.js';
import type { RecordStore } from './store.js';
import { assertSafeId } from './store.js';
import type { Tokens } from './tokens.js';

export interface RoomsOptions {
  readonly store: RecordStore;
  readonly tokens: Tokens;
  /** Check the engine's structural invariants after every action. On by default: see below. */
  readonly checkInvariants?: boolean;
  /** Injected so tests get `r1`, `r2`, and so a deployment can choose its own id shape. */
  readonly mintRoomId?: () => string;
  readonly randomSeed?: () => number;
}

export interface CreateOptions {
  readonly players: number;
  /** Omit for a random island. Supply one to reproduce a game exactly. */
  readonly seed?: number;
  readonly id?: string;
}

export interface RoomSummary {
  readonly id: string;
  readonly scenarioId: string;
  readonly seed: number;
  readonly players: number;
  readonly at: number;
  readonly over: boolean;
  readonly open: number;
}

export class Rooms {
  private readonly live = new Map<string, Room>();
  private readonly store: RecordStore;
  private readonly tokens: Tokens;
  private readonly checkInvariants: boolean;
  private readonly mintRoomId: () => string;
  private readonly randomSeed: () => number;

  constructor(options: RoomsOptions) {
    this.store = options.store;
    this.tokens = options.tokens;
    // On by default. The check is linear in the board and hands, it runs once per action rather
    // than once per request, and it turns a corrupted game into a loud failure at the move that
    // caused it instead of a mystery three turns later. A server is exactly where that trade is
    // worth making.
    this.checkInvariants = options.checkInvariants ?? true;
    this.mintRoomId = options.mintRoomId ?? defaultRoomId;
    this.randomSeed = options.randomSeed ?? (() => Math.floor(Math.random() * 2 ** 31));
  }

  async create(options: CreateOptions): Promise<Room> {
    const id = options.id ?? this.mintRoomId();
    assertSafeId(id);
    if (this.live.has(id) || (await this.store.load(id)) !== undefined) {
      throw new Error(`room ${id} already exists`);
    }

    const seed = options.seed ?? this.randomSeed();
    const game = newGame({
      scenario: scenarioForPlayers(options.players),
      rules: baseRules(),
      seed,
      players: options.players,
    });
    const session = new Session(game, { checkInvariants: this.checkInvariants });
    const room = new Room(id, session, this.tokens);

    this.live.set(id, room);
    // Saved before anyone plays, so a room that is created and then abandoned still exists to be
    // rejoined — and so `create` fails loudly here rather than at the first move.
    await this.store.save(id, room.record);
    return room;
  }

  /** A room that is already in memory. */
  get(id: string): Room | undefined {
    return this.live.get(id);
  }

  /** A room, from memory or rebuilt from its log. `undefined` if no such game was ever saved. */
  async open(id: string): Promise<Room | undefined> {
    const live = this.live.get(id);
    if (live !== undefined) return live;
    if (!isSafe(id)) return undefined;

    const saved = await this.store.load(id);
    if (saved === undefined) return undefined;
    const room = this.restore(id, saved);
    this.live.set(id, room);
    return room;
  }

  /**
   * Rebuild a room from a record.
   *
   * Public because it is the interesting operation, and because a maintenance script that wants to
   * inspect a game should reach for exactly this. The session it produces continues the same
   * record, so the next move appends to the history rather than starting a second one.
   */
  restore(id: string, saved: GameRecord): Room {
    const session = restoreSession(saved, this.checkInvariants ? { checkInvariants: true } : {});
    return new Room(id, session, this.tokens);
  }

  async persist(room: Room): Promise<void> {
    await this.store.save(room.id, room.record);
  }

  summaries(): readonly RoomSummary[] {
    return [...this.live.values()].map((room) => ({
      id: room.id,
      scenarioId: room.session.state.scenarioId,
      seed: room.session.state.seed,
      players: room.seats.length,
      at: room.at,
      over: room.over,
      open: room.open.length,
    }));
  }

  /** Every room the store knows about, live or not. */
  async saved(): Promise<readonly string[]> {
    return this.store.list();
  }
}

function isSafe(id: string): boolean {
  try {
    assertSafeId(id);
    return true;
  } catch {
    return false;
  }
}

/** Short, readable, and unguessable enough — the secret protects seats, not the room id. */
function defaultRoomId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
