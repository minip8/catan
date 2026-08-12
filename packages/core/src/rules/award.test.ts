/**
 * The award tie rules, which are asymmetric and easy to get wrong.
 *
 * The metric is stubbed rather than computed from a board: `resolveAward` reads only `seatOrder`
 * and `awards`, and every interesting case here is about *the shape of the scores*, not about how
 * long anyone's road is. Driving it from real boards would need a page of setup per case and would
 * test `longestRoute` all over again (see `route.test.ts` for that).
 */

import { describe, expect, it } from 'vitest';

import { type PlayerId, playerId } from '../ids.js';
import type { AwardState, GameState } from '../state/gameState.js';
import { Tx } from '../state/tx.js';
import { resolveAward } from './award.js';
import type { AwardSpec, RuleContext, RuleSet } from './ruleset.js';

const SEATS = [0, 1, 2, 3].map(playerId);
const THRESHOLD = 5;

/** A context whose only real content is one award backed by a lookup table of scores. */
function fixture(scores: Readonly<Record<string, number>>, holder: PlayerId | null, best = 0) {
  const spec: AwardSpec = {
    id: 'longestRoad',
    value: 2,
    threshold: THRESHOLD,
    metric: (_ctx, _state, player) => scores[player] ?? 0,
  };
  const ctx = { rules: { awards: { longestRoad: spec } } as unknown as RuleSet } as RuleContext;
  const award: AwardState = { holder, value: 2, best };
  const state = { seatOrder: SEATS, awards: { longestRoad: award } } as unknown as GameState;
  return { ctx, state, award, tx: new Tx(ctx, state) };
}

function resolve(scores: Readonly<Record<string, number>>, holder: PlayerId | null) {
  const f = fixture(scores, holder);
  const outcome = resolveAward(f.ctx, f.tx, 'longestRoad');
  return { holder: f.award.holder, best: f.award.best, outcome, events: f.tx.events };
}

const [p0, p1, p2] = SEATS as [PlayerId, PlayerId, PlayerId];

describe('resolveAward', () => {
  it('leaves the award unclaimed until someone reaches the threshold', () => {
    const { holder, best, events } = resolve({ [p0]: 4, [p1]: 3 }, null);
    expect(holder).toBeNull();
    expect(best).toBe(0);
    expect(events).toEqual([]);
  });

  it('awards it to the first player to reach the threshold', () => {
    const { holder, best, outcome } = resolve({ [p0]: 5, [p1]: 3 }, null);
    expect(holder).toBe(p0);
    expect(best).toBe(5);
    expect(outcome).toMatchObject({ from: null, to: p0 });
  });

  // A challenger must *beat* the holder. This is the rule that makes the card sticky, and the one
  // an implementation gets wrong by using `>=`.
  it('does not move on a tie', () => {
    const { holder, outcome, events } = resolve({ [p0]: 6, [p1]: 6 }, p0);
    expect(holder).toBe(p0);
    expect(outcome).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('moves when a challenger goes one better', () => {
    const { holder, best, outcome } = resolve({ [p0]: 6, [p1]: 7 }, p0);
    expect(holder).toBe(p1);
    expect(best).toBe(7);
    expect(outcome).toMatchObject({ from: p0, to: p1 });
  });

  // The almanac's rule for a broken road: if the holder falls behind and two or more players tie
  // for the new lead, nobody holds the card until one of them leads alone.
  it('sets the award aside when the holder falls behind a tie', () => {
    const { holder, best, outcome } = resolve({ [p0]: 3, [p1]: 6, [p2]: 6 }, p0);
    expect(holder).toBeNull();
    expect(best).toBe(6);
    expect(outcome).toMatchObject({ from: p0, to: null });
  });

  it('gives it back as soon as one of the tied players leads alone', () => {
    const { holder, outcome } = resolve({ [p0]: 3, [p1]: 7, [p2]: 6 }, null);
    expect(holder).toBe(p1);
    expect(outcome).toMatchObject({ from: null, to: p1 });
  });

  // The holder is still the holder while they are *equal* best, even after being cut down to it.
  it('keeps it with the holder when they are still tied for the lead', () => {
    const { holder } = resolve({ [p0]: 5, [p1]: 5, [p2]: 5 }, p0);
    expect(holder).toBe(p0);
  });

  it('takes it away entirely when everyone drops below the threshold', () => {
    const { holder, best, outcome } = resolve({ [p0]: 2, [p1]: 4 }, p0);
    expect(holder).toBeNull();
    expect(best).toBe(0);
    expect(outcome).toMatchObject({ from: p0, to: null });
  });

  it('hands it to a single qualifying player when the holder drops out', () => {
    const { holder } = resolve({ [p0]: 1, [p1]: 5, [p2]: 4 }, p0);
    expect(holder).toBe(p1);
  });
});
