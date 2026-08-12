/**
 * Actions: what a player asks the engine to do.
 *
 * An action is **untrusted input**. It arrives over a network from a client that may be out of
 * date, buggy or hostile, so core models it as `{ type }` plus an opaque payload and every handler
 * pulls typed fields out of it through the readers below. A handler that indexes into
 * `action` directly, or casts it to its own union, is one malformed message away from throwing
 * inside the reducer — which would turn a bad packet into a crashed game.
 *
 * The readers return `Result` rather than throwing, so a malformed payload comes back as an
 * ordinary `malformed` violation on the same channel as "that settlement is too close".
 *
 * `ActionSpec` is the other direction: what the engine tells a UI or a bot it *may* do. It is
 * strictly a descriptor — `isLegal` is the only authority, and the reducer never trusts a spec.
 */

import type { CardKind, PlayerId } from '../ids.js';
import { ok, type Result } from '../result.js';
import type { Cost } from '../state/gameState.js';
import { type RuleViolation, violation } from './violation.js';

/**
 * A request from a player.
 *
 * Deliberately not a discriminated union in core: the set of action types is ruleset-defined, and
 * core dispatches on `type` through `RuleSet.steps` without interpreting it.
 */
export interface Action {
  readonly type: string;
  readonly [field: string]: unknown;
}

export function action(type: string, fields: Readonly<Record<string, unknown>> = {}): Action {
  return { ...fields, type };
}

// ── Descriptors ─────────────────────────────────────────────────────────────────────────────

/**
 * What an actor may do right now, as offered to UIs and bots.
 *
 * `options` holds fully-formed, immediately-playable actions wherever the legal space is small
 * enough to enumerate — which is nearly always, since it is bounded by the board. Where it is not
 * (a trade offer is any bundle for any bundle), the spec sets `enumerated: false` and the client
 * composes the action itself, then finds out via `isLegal`.
 */
export interface ActionSpec {
  readonly type: string;
  readonly options: readonly Action[];
  /** False when `options` is illustrative rather than the complete legal space. */
  readonly enumerated: boolean;
  /** Why the step is offered, for UIs that label buttons — e.g. "place a free road". */
  readonly note?: string;
}

export function spec(
  type: string,
  options: readonly Action[],
  extra: { enumerated?: boolean; note?: string } = {},
): ActionSpec {
  const { enumerated = true, note } = extra;
  return note === undefined ? { type, options, enumerated } : { type, options, enumerated, note };
}

// ── Field readers ───────────────────────────────────────────────────────────────────────────

function missing(action: Action, field: string, want: string): Result<never, RuleViolation> {
  return violation('malformed', `${action.type}: field ${JSON.stringify(field)} must be ${want}`, {
    action: action.type,
    field,
  });
}

/** Read a string field. Branded id types pass through their brand via `T`. */
export function str<T extends string = string>(
  action: Action,
  field: string,
): Result<T, RuleViolation> {
  const value = action[field];
  if (typeof value !== 'string' || value.length === 0) return missing(action, field, 'a string');
  return ok(value as T);
}

/** Read an integer field, optionally bounded. Rejects `NaN`, floats and infinities. */
export function int(
  action: Action,
  field: string,
  bounds: { min?: number; max?: number } = {},
): Result<number, RuleViolation> {
  const value = action[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return missing(action, field, 'an integer');
  }
  const { min, max } = bounds;
  if (min !== undefined && value < min) return missing(action, field, `>= ${min}`);
  if (max !== undefined && value > max) return missing(action, field, `<= ${max}`);
  return ok(value);
}

export function bool(action: Action, field: string): Result<boolean, RuleViolation> {
  const value = action[field];
  if (typeof value !== 'boolean') return missing(action, field, 'a boolean');
  return ok(value);
}

/** Read a string field that may be absent or `null`, e.g. an optional steal victim. */
export function optionalStr<T extends string = string>(
  action: Action,
  field: string,
): Result<T | null, RuleViolation> {
  const value = action[field];
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string' || value.length === 0) return missing(action, field, 'a string');
  return ok(value as T);
}

/** Read an array of strings — a list of card kinds, a list of players. */
export function strList<T extends string = string>(
  action: Action,
  field: string,
): Result<readonly T[], RuleViolation> {
  const value = action[field];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
    return missing(action, field, 'an array of strings');
  }
  return ok(value as readonly T[]);
}

/**
 * Read a card bundle: `{ brick: 1, wool: 2 }`.
 *
 * Rejects negative and fractional counts, which would otherwise let a client mint cards by
 * "paying" a negative amount — the single most dangerous malformed payload in the game.
 * Zero entries are dropped so that `{}` and `{ brick: 0 }` are the same bundle.
 */
export function bundle(action: Action, field: string): Result<Cost, RuleViolation> {
  const value = action[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return missing(action, field, 'an object of card counts');
  }
  const out: Partial<Record<CardKind, number>> = {};
  for (const [kind, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      return missing(action, `${field}.${kind}`, 'a non-negative integer');
    }
    if (n > 0) out[kind] = n;
  }
  return ok(out);
}

/** Total cards in a bundle. */
export function bundleSize(bundle: Cost): number {
  let total = 0;
  for (const n of Object.values(bundle)) total += n ?? 0;
  return total;
}

/** Read a player id field. Existence is checked by the handler, not here. */
export function playerField(action: Action, field: string): Result<PlayerId, RuleViolation> {
  return str<PlayerId>(action, field);
}
