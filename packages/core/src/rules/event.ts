/**
 * Events: what the engine says happened.
 *
 * Events exist because the state diff is not enough. "Player 2's wool went from 3 to 2" does not
 * tell a client whether it was stolen, discarded, traded or spent, and the animation, the log line
 * and the "you were robbed" notification all differ. So every reduce returns an ordered list of
 * events alongside the new state.
 *
 * **Secrecy is modelled here, not at the client.** Some of what happens is visible to everyone
 * (a settlement appeared), some to nobody but one player (the development card you drew), and some
 * to exactly two (the resource the robber took — the thief and the victim both see it, and no one
 * else does). An event therefore carries a public `data` payload and an optional `secret` payload
 * with an `audience`; `redactEvents` strips the latter for everyone outside the audience.
 *
 * Getting this wrong leaks the game, so the rule is mechanical: **anything a player learns that
 * another player does not goes in `secret`**, never in `data`.
 */

import type { PlayerId } from '../ids.js';

export interface GameEvent {
  /** Ruleset-defined. Core never interprets it. */
  readonly type: string;
  /** Visible to everyone, including spectators. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Visible only to `audience`. Absent on fully public events. */
  readonly secret?: Readonly<Record<string, unknown>>;
  /**
   * Who may see `secret`. Required whenever `secret` is present; an empty list means "the server
   * only", which is what the shuffled deck order is.
   */
  readonly audience?: readonly PlayerId[];
}

export function event(type: string, data: Readonly<Record<string, unknown>> = {}): GameEvent {
  return { type, data };
}

/** An event with a payload only `audience` may see. */
export function secretEvent(
  type: string,
  data: Readonly<Record<string, unknown>>,
  secret: Readonly<Record<string, unknown>>,
  audience: readonly PlayerId[],
): GameEvent {
  return { type, data, secret, audience };
}

/**
 * Strip what `viewer` may not see.
 *
 * `viewer` is `null` for a spectator or a public log, which sees only fully public payloads.
 * The event itself is never dropped — its *existence* is public, and hiding it would desynchronise
 * clients that count events. What is dropped is the `secret` body, replaced by a `hidden: true`
 * marker so a UI can still say "player 2 drew a card" without knowing which.
 */
export function redactEvent(event: GameEvent, viewer: PlayerId | null): GameEvent {
  if (event.secret === undefined) return event;
  const permitted = viewer !== null && (event.audience ?? []).includes(viewer);
  if (permitted) return event;
  return { type: event.type, data: { ...event.data, hidden: true } };
}

export function redactEvents(
  events: readonly GameEvent[],
  viewer: PlayerId | null,
): readonly GameEvent[] {
  return events.map((e) => redactEvent(e, viewer));
}
