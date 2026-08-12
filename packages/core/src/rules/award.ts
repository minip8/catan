/**
 * Award resolution — Longest Road, Largest Army, and whatever an expansion adds.
 *
 * Recomputed from scratch after every action rather than maintained incrementally, because the
 * metric can change for a player who did nothing: **building a settlement on an opponent's road
 * cuts that road in two.** An incremental implementation that only re-scores the acting player
 * silently leaves the card with someone who no longer has the longest road.
 *
 * The tie rules are the fiddly part, and they are not symmetric:
 *
 * - A challenger must **beat** the holder, not match them. Ties never move a card.
 * - If the holder's metric falls and two or more *other* players are now tied for the lead, the
 *   card is **set aside** — it belongs to nobody until one player leads alone. This is a real
 *   base-game rule from the almanac, not an expansion nicety, and it is why `AwardState.holder`
 *   is nullable.
 * - If the holder's metric falls but they are still tied for the lead, they keep it. They are
 *   still the incumbent, and a tie does not dislodge an incumbent.
 */

import type { AwardId, PlayerId } from '../ids.js';
import type { Tx } from '../state/tx.js';
import { event } from './event.js';
import type { RuleContext } from './ruleset.js';

export interface AwardOutcome {
  readonly award: AwardId;
  readonly from: PlayerId | null;
  readonly to: PlayerId | null;
  readonly best: number;
}

/** Re-resolve every award. Called after any action that could move a piece or play a knight. */
export function resolveAwards(ctx: RuleContext, tx: Tx): readonly AwardOutcome[] {
  const out: AwardOutcome[] = [];
  for (const id of Object.keys(ctx.rules.awards)) {
    const outcome = resolveAward(ctx, tx, id);
    if (outcome !== undefined) out.push(outcome);
  }
  return out;
}

/** Re-resolve one award, emitting an event only if the holder actually changed. */
export function resolveAward(ctx: RuleContext, tx: Tx, id: AwardId): AwardOutcome | undefined {
  const spec = ctx.rules.awards[id];
  const state = tx.state;
  const current = state.awards[id];
  if (spec === undefined || current === undefined) return undefined;

  const scores = new Map<PlayerId, number>(
    state.seatOrder.map((p) => [p, spec.metric(ctx, state, p)]),
  );
  const qualified = [...scores.entries()].filter(([, v]) => v >= spec.threshold);

  const holder = current.holder;
  const next = decideHolder(holder, qualified);
  const best = qualified.length === 0 ? 0 : Math.max(...qualified.map(([, v]) => v));

  const changed = next !== holder;
  current.holder = next;
  current.best = best;

  if (!changed) return undefined;
  const outcome: AwardOutcome = { award: id, from: holder, to: next, best };
  tx.emit(event('award', { ...outcome }));
  return outcome;
}

/**
 * Who holds the award, given the incumbent and everyone at or above the threshold.
 *
 * Split out and kept total so the three tie cases are visible in one place and testable without a
 * game around them.
 */
function decideHolder(
  holder: PlayerId | null,
  qualified: readonly (readonly [PlayerId, number])[],
): PlayerId | null {
  if (qualified.length === 0) return null;

  const best = Math.max(...qualified.map(([, v]) => v));
  const leaders = qualified.filter(([, v]) => v === best).map(([p]) => p);

  // The incumbent keeps it while they are still (equal) best: a tie never takes a card away.
  if (holder !== null && leaders.includes(holder)) return holder;
  // A single new leader takes it, whether or not there was an incumbent.
  if (leaders.length === 1) return leaders[0] as PlayerId;
  // Several tie and none of them is the incumbent: the card goes out of play.
  return null;
}
