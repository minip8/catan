/**
 * A room: one game, its seats, and who is holding them.
 *
 * The room owns no sockets and performs no I/O. It takes a token and a request and returns the
 * messages that should go out, which is the same division that makes the engine testable — the
 * interesting half is a function, and the transport is a shell around it. Every test in
 * `room.test.ts` plays a whole game without opening a port.
 *
 * **Authority is the token.** A connection asks to join, the room mints a token and hands back the
 * seat that token now owns, and every later message is attributed by looking the token up. No
 * client message names a seat, so no client can claim one. The obvious alternative — trusting a
 * `seat` field and validating it against a session list — is one forgotten check away from letting
 * anyone play anyone's turn.
 *
 * Seats are dealt by the engine when the game is created, not when players arrive. That is what
 * lets a room be *restored* from its action log with the same seating it had before the crash.
 */

import type { Action, GameEvent, GameRecord, PlayerId, PlayerView, Session } from '@catan/core';
import { ok, type Result } from '@catan/core';

import { fail, type SeatInfo, type ServerError, type ServerMessage } from './protocol.js';
import type { Tokens } from './tokens.js';

/** One party to the room, seated or not. Identified by a token the server minted. */
export interface Member {
  readonly token: string;
  /** `null` for a spectator. Fixed for the life of the token. */
  readonly seat: PlayerId | null;
  name: string;
  /** Open connections holding this token. More than one is a second tab, not a second player. */
  connections: number;
}

/** A message and the viewer it was built for. The transport routes it; the room does not. */
export interface Broadcast {
  readonly viewer: PlayerId | null;
  readonly message: ServerMessage;
}

export interface Joined {
  readonly token: string;
  readonly seat: PlayerId | null;
  /** Sent to the joining connection alone — it carries the token. */
  readonly welcome: ServerMessage;
  /** Sent to everyone, so the table sees the new arrival. */
  readonly broadcasts: readonly Broadcast[];
}

export class Room {
  readonly id: string;
  readonly session: Session;

  private readonly tokens: Tokens;
  private readonly members = new Map<string, Member>();
  /** Seat → token. The inverse of `members`, kept so seat lookup is not a scan. */
  private readonly claimed = new Map<PlayerId, string>();

  /**
   * @param tokens The credential scheme. Injected rather than imported so the room stays free of
   *   `node:crypto`, and so tests can use readable tokens.
   */
  constructor(id: string, session: Session, tokens: Tokens) {
    this.id = id;
    this.session = session;
    this.tokens = tokens;
  }

  /** How many actions this room has applied. The client's cheapest desync check. */
  get at(): number {
    return this.session.record.actions.length;
  }

  get record(): GameRecord {
    return this.session.record;
  }

  get over(): boolean {
    return this.session.over;
  }

  get seats(): readonly PlayerId[] {
    return this.session.state.seatOrder;
  }

  /** Seats with nobody holding them. A room is playable when this is empty. */
  get open(): readonly PlayerId[] {
    return this.seats.filter((seat) => !this.claimed.has(seat));
  }

  member(token: string): Member | undefined {
    return this.members.get(token);
  }

  // ── Membership ────────────────────────────────────────────────────────────────────────────

  /**
   * Take a seat, or resume one.
   *
   * A join with no token takes the first free seat; when the seats are gone the joiner becomes a
   * spectator rather than being turned away, because a full game is a thing people want to watch.
   *
   * A join with a token resumes exactly what that token owns, which makes four situations the same
   * operation: a reconnect after a dropped network, a second tab, a refresh — and a rejoin after
   * the *server* restarted, because a seat token is derived rather than remembered, so a room
   * rebuilt from its action log still recognises the players who were sitting in it.
   */
  join(request: { token: string | null; name: string | null }): Result<Joined, ServerError> {
    let member = request.token === null ? undefined : this.members.get(request.token);

    if (member === undefined && request.token !== null) {
      // Not a member of this *instance* of the room — but the token may still be a valid seat
      // credential from before a restart.
      const seat = this.tokens.seatOf(this.id, request.token, this.seats);
      if (seat === undefined) {
        return fail('unknownToken', 'that token does not belong to this room');
      }
      member = this.seatMember(seat, request.token, request.name);
    }

    member ??= this.admit(request.name);
    member.connections += 1;
    if (request.name !== null) member.name = request.name;

    return ok({
      token: member.token,
      seat: member.seat,
      welcome: { t: 'welcome', room: this.id, seat: member.seat, token: member.token },
      broadcasts: this.broadcast(),
    });
  }

  /** A connection closed. The member stays — their seat is theirs until the game ends. */
  leave(token: string): readonly Broadcast[] {
    const member = this.members.get(token);
    if (member === undefined) return [];
    member.connections = Math.max(0, member.connections - 1);
    return this.broadcast();
  }

  /** Admit a newcomer: the first free seat, or a spectator's place if there are none left. */
  private admit(name: string | null): Member {
    const seat = this.open[0];
    if (seat !== undefined) return this.seatMember(seat, this.tokens.forSeat(this.id, seat), name);

    const member: Member = {
      token: this.tokens.forSpectator(),
      seat: null,
      name: name ?? 'Spectator',
      connections: 0,
    };
    this.members.set(member.token, member);
    return member;
  }

  private seatMember(seat: PlayerId, token: string, name: string | null): Member {
    const member: Member = {
      token,
      seat,
      name: name ?? defaultName(this.seats.indexOf(seat)),
      connections: 0,
    };
    this.members.set(token, member);
    this.claimed.set(seat, token);
    return member;
  }

  // ── Playing ───────────────────────────────────────────────────────────────────────────────

  /**
   * Play a move on behalf of whoever holds `token`.
   *
   * The engine is the authority: this method's whole job is to decide *whose* move it is, and then
   * to get out of the way. A refusal comes back as the engine's own violation, and nothing in the
   * room has changed — the session guarantees that, not this code.
   */
  act(token: string, action: Action): Result<readonly Broadcast[], ServerError> {
    const member = this.members.get(token);
    if (member === undefined) return fail('unknownToken', 'join before acting');
    if (member.seat === null) {
      return fail('notSeated', 'spectators may watch, but not play');
    }

    const result = this.session.act(member.seat, action);
    if (!result.ok) return fail(result.error.code, result.error.message);

    return ok(
      result.value.map((delivery) => ({
        viewer: delivery.viewer,
        message: this.update(delivery.viewer, delivery.events, delivery.view),
      })),
    );
  }

  /** One viewer's current picture, with nothing having just happened. */
  snapshot(viewer: PlayerId | null): ServerMessage {
    return this.update(viewer, []);
  }

  /**
   * A message for every seat plus spectators — what the transport fans out after any change.
   *
   * Built for every seat rather than only for connected ones, because the room does not know which
   * sockets exist. Unrouted messages cost a redaction each and nothing else.
   */
  broadcast(): readonly Broadcast[] {
    const viewers: (PlayerId | null)[] = [...this.seats, null];
    return viewers.map((viewer) => ({ viewer, message: this.snapshot(viewer) }));
  }

  seatInfo(): readonly SeatInfo[] {
    return this.seats.map((seat) => {
      const token = this.claimed.get(seat);
      const member = token === undefined ? undefined : this.members.get(token);
      return {
        seat,
        name: member?.name ?? defaultName(this.seats.indexOf(seat)),
        connected: (member?.connections ?? 0) > 0,
      };
    });
  }

  private update(
    viewer: PlayerId | null,
    events: readonly GameEvent[],
    view: PlayerView = this.session.view(viewer),
  ): ServerMessage {
    return {
      t: 'update',
      room: this.id,
      at: this.at,
      view,
      // A spectator is offered nothing, which is the same answer the engine gives a player who is
      // not being waited on.
      options: viewer === null ? [] : this.session.options(viewer),
      events,
      seats: this.seatInfo(),
    };
  }
}

function defaultName(index: number): string {
  return `Seat ${index + 1}`;
}
