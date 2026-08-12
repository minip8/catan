/**
 * Rule violations — the engine's error channel.
 *
 * A violation is an ordinary value, never an exception: a client asked for something the rules
 * forbid, which is expected traffic on a network game and must not take the process down. See
 * `result.ts` for the other half of that contract.
 *
 * Codes are an *open* union for the same reason the taxonomies in `ids.ts` are: expansions add
 * their own, and core must not be able to `switch` exhaustively over them. Clients that want to
 * localise a message match on `code` and fall back to `message`, which is always populated.
 */

import type { Widen } from '../ids.js';
import { type Err, err } from '../result.js';

/**
 * Why an action was refused.
 *
 * The listed codes are the base game's; the union stays open.
 *
 * - `gameOver` — the game already has an outcome.
 * - `notYourStep` — the actor does not own the top of the continuation stack. Note that this is
 *   about *step ownership*, not about `turn.active`: discard-on-7 belongs to whoever is over the
 *   hand limit, and rejecting it as "not your turn" would be wrong.
 * - `wrongStep` — the actor owns the step, but this action is not one that step accepts.
 * - `malformed` — the action's payload is missing a field or has the wrong shape. Distinct from
 *   `wrongStep` because it means a buggy or hostile client rather than a mistimed click.
 * - `unknownAction` — no handler claims this action type.
 * - `cannotAfford` — the actor does not hold the cost.
 * - `supplyEmpty` — the actor has no piece of that kind left (15 roads / 5 settlements / 4 cities).
 * - `bankShort` — the bank cannot cover the request.
 * - `occupied` — something is already on that locus.
 * - `tooClose` — the distance rule: a building sits on an adjacent intersection.
 * - `notConnected` — the placement does not touch the actor's own network.
 * - `illegalTarget` — the locus or player named is not a legal target for this action.
 * - `notNow` — the action is legal in principle but not at this moment (a development card bought
 *   this turn, a second card in one turn).
 */
export type ViolationCode =
  | 'gameOver'
  | 'notYourStep'
  | 'wrongStep'
  | 'malformed'
  | 'unknownAction'
  | 'cannotAfford'
  | 'supplyEmpty'
  | 'bankShort'
  | 'occupied'
  | 'tooClose'
  | 'notConnected'
  | 'illegalTarget'
  | 'notNow'
  | Widen;

export interface RuleViolation {
  readonly code: ViolationCode;
  /** Plain English, for logs and for clients with no translation for `code`. */
  readonly message: string;
  /** Structured context — the locus, the missing resource — for clients that highlight it. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Build an `Err<RuleViolation>`, which is what every rule check returns when it refuses. */
export function violation(
  code: ViolationCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): Err<RuleViolation> {
  return err(detail === undefined ? { code, message } : { code, message, detail });
}
