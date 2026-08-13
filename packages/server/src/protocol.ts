/**
 * The wire protocol.
 *
 * Two rules shape everything here, and they are the same two that shape `rules/action.ts` in the
 * engine:
 *
 * 1. **Incoming messages are untrusted.** They arrive from a browser that may be old, buggy or
 *    hostile, so they are parsed by hand into a narrow type and every failure comes back as a
 *    value. A parser that threw would let one malformed frame take down a room.
 * 2. **Outgoing messages carry a `PlayerView`, never a `GameState`.** That is enforced in the
 *    types below rather than by remembering to redact at each call site, because the one place a
 *    server leaks a game is the one place someone forgot.
 *
 * Note what the client is *not* trusted with: its own identity. There is no `seat` field on any
 * client message. A connection's seat is whatever its token says it is, and the token was minted
 * by the server.
 */

import type { Action, ActionSpec, GameEvent, PlayerId, PlayerView, Widen } from '@catan/core';
import { err, ok, type Result } from '@catan/core';

// ── Errors ──────────────────────────────────────────────────────────────────────────────────

/**
 * Why the server said no.
 *
 * Open, and deliberately overlapping with core's `ViolationCode`: a refused *move* is reported
 * with the engine's own code and message, so a client needs one error path rather than two.
 */
export type ErrorCode =
  | 'badMessage'
  | 'noSuchRoom'
  | 'roomFull'
  | 'unknownToken'
  | 'notSeated'
  | 'notJoined'
  | Widen;

export interface ServerError {
  readonly code: ErrorCode;
  readonly message: string;
}

export function fail<T = never>(code: ErrorCode, message: string): Result<T, ServerError> {
  return err({ code, message });
}

// ── Client → server ─────────────────────────────────────────────────────────────────────────

export type ClientMessage =
  /** Claim a seat, or resume one with the token from a previous `welcome`. */
  | { readonly t: 'join'; readonly token: string | null; readonly name: string | null }
  /** Play a move. The seat comes from the connection's token, never from the message. */
  | { readonly t: 'act'; readonly action: Action }
  /** Ask for a fresh view — after a reconnect, or when a client suspects it has drifted. */
  | { readonly t: 'sync' };

// ── Server → client ─────────────────────────────────────────────────────────────────────────

export interface SeatInfo {
  readonly seat: PlayerId;
  readonly name: string;
  readonly connected: boolean;
}

export type ServerMessage =
  | {
      readonly t: 'welcome';
      readonly room: string;
      /** `null` for a spectator: the room's seats were all taken. */
      readonly seat: PlayerId | null;
      /** Keep this. It is the only proof of who you are. */
      readonly token: string;
    }
  | {
      readonly t: 'update';
      readonly room: string;
      /**
       * How many actions the room has applied.
       *
       * A client that has seen fewer updates than this has missed some and should `sync`. It is
       * also the cheapest desync check there is: two clients on the same `at` should agree.
       */
      readonly at: number;
      readonly view: PlayerView;
      /** What this viewer may do now. Empty for everyone who is not being waited on. */
      readonly options: readonly ActionSpec[];
      /** What just happened, redacted for this viewer. Empty on a snapshot. */
      readonly events: readonly GameEvent[];
      readonly seats: readonly SeatInfo[];
    }
  | { readonly t: 'error'; readonly code: ErrorCode; readonly message: string };

export function errorMessage(error: ServerError): ServerMessage {
  return { t: 'error', code: error.code, message: error.message };
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────

/**
 * Parse one frame.
 *
 * Takes the raw text rather than a parsed object so that malformed JSON is handled in the same
 * place, and by the same mechanism, as a well-formed message with the wrong shape.
 */
export function parseClientMessage(raw: string): Result<ClientMessage, ServerError> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail('badMessage', 'that was not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('badMessage', 'a message must be an object');
  }

  const message = value as Record<string, unknown>;
  switch (message.t) {
    case 'join': {
      const token = optionalString(message.token);
      if (token === false) return fail('badMessage', 'join: token must be a string');
      const name = optionalString(message.name);
      if (name === false) return fail('badMessage', 'join: name must be a string');
      return ok({ t: 'join', token, name });
    }

    case 'act': {
      const action = message.action;
      if (typeof action !== 'object' || action === null || Array.isArray(action)) {
        return fail('badMessage', 'act: action must be an object');
      }
      const type = (action as Record<string, unknown>).type;
      if (typeof type !== 'string' || type.length === 0) {
        return fail('badMessage', 'act: action.type must be a non-empty string');
      }
      // The rest of the payload is deliberately not inspected. Which fields an action carries is
      // the *ruleset's* business, and the engine's field readers already treat them as untrusted.
      return ok({ t: 'act', action: action as Action });
    }

    case 'sync':
      return ok({ t: 'sync' });

    default:
      return fail('badMessage', `unknown message type ${JSON.stringify(message.t)}`);
  }
}

/** `string | null` for an absent field, or `false` when the field is present but wrong. */
function optionalString(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return false;
  return value;
}
