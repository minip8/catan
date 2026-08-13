/**
 * Seat credentials.
 *
 * A seat token is an HMAC of `room:seat` under a server secret, which buys one specific thing:
 * **a token survives a server restart without being stored anywhere.** A room is recovered by
 * replaying its action log, and the players' credentials are recovered by recomputing them — so
 * nothing about who is who has to be written to disk beside the game, and the record on disk stays
 * pure game data with no secrets in it.
 *
 * Spectator tokens are random instead of derived. A spectator has no authority to prove, so there
 * is nothing to re-derive; the cost is that a spectator who was connected when the server restarted
 * rejoins as a new spectator, which is exactly what they were.
 *
 * Comparison is constant-time. The window is small — an attacker would need to be measuring a
 * remote HMAC comparison — but the fix is one function call, and getting into the habit is worth
 * more than the microseconds.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { PlayerId } from '@catan/core';

export interface Tokens {
  /** The token that owns `seat`. Stable for the life of the room, across restarts. */
  forSeat(room: string, seat: PlayerId): string;
  /** A token that owns nothing. */
  forSpectator(): string;
  /** Which of `seats` this token owns, if any. */
  seatOf(room: string, token: string, seats: readonly PlayerId[]): PlayerId | undefined;
}

/** A secret for a server that was not given one. Fine for a laptop; log a warning in production. */
export function ephemeralSecret(): string {
  return randomBytes(32).toString('hex');
}

export function hmacTokens(secret: string): Tokens {
  const sign = (room: string, seat: PlayerId): string =>
    createHmac('sha256', secret).update(`${room}:${seat}`).digest('base64url');

  return {
    forSeat: sign,
    forSpectator: () => randomUUID(),
    seatOf(room, token, seats) {
      for (const seat of seats) {
        if (equals(token, sign(room, seat))) return seat;
      }
      return undefined;
    },
  };
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // `timingSafeEqual` throws on a length mismatch, and the lengths are not secret.
  return left.length === right.length && timingSafeEqual(left, right);
}
