/**
 * The reducer — the whole of core's control flow.
 *
 * ```
 * reduce(ctx, state, actor, action): Result<Tick, RuleViolation>
 * ```
 *
 * What it does is deliberately thin, because everything Catan-specific belongs to the ruleset:
 *
 * 1. Clone the state. Handlers mutate the clone, so a refused action leaves the original
 *    untouched and there is no rollback path to get wrong.
 * 2. Find the top of the continuation stack and check that `actor` owns it. **Authority comes
 *    from owning the step, never from `turn.active`** — discard-on-7 belongs to whoever is over
 *    the hand limit, and the active player is usually not among them.
 * 3. Hand the action to the step handler the ruleset registered for that step's kind.
 * 4. Settle: re-resolve awards, check for a winner, and run any `system` steps the action pushed,
 *    repeating until control comes to rest on a step a player owns.
 *
 * Step 4 is centralised on purpose. Longest Road can change because of an action by a player who
 * does not hold it — an opponent's settlement cuts your road — so "recompute the awards" cannot be
 * the responsibility of the handler that happens to have run. Doing it here means no handler can
 * forget.
 */

import type { PlayerId } from '../ids.js';
import { ok, type Result } from '../result.js';
import type { Action, ActionSpec } from '../rules/action.js';
import { resolveAwards } from '../rules/award.js';
import { event, type GameEvent } from '../rules/event.js';
import type { RuleContext } from '../rules/ruleset.js';
import { type RuleViolation, violation } from '../rules/violation.js';
import { currentStep, type GameState, stepBelongsTo } from '../state/gameState.js';
import { assertInvariants, type InvariantContext } from '../state/invariants.js';
import { Tx } from '../state/tx.js';

/** The result of an accepted action: the new state, and everything that happened. */
export interface Tick {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * How many `system` steps may resolve after one action before the engine calls it a bug.
 *
 * A system step that pushes itself, or a pair that push each other, would otherwise hang the
 * server on a single action. The real bound is small — a 7 resolves at most a discard step and a
 * robber step — so anything near this limit is a ruleset defect, not a long turn.
 */
const MAX_SYSTEM_STEPS = 256;

export interface ReduceOptions {
  /**
   * Check structural invariants after the action and throw if they are broken.
   *
   * On in tests and dev builds, off in production. When on, a reducer bug surfaces at the action
   * that caused it rather than several turns later when the bank mysteriously runs dry.
   */
  readonly invariants?: InvariantContext;
}

/**
 * Deep-copy the state for a handler to mutate.
 *
 * A JSON round trip rather than `structuredClone`, which makes the copy *enforce* the rule that
 * `GameState` is JSON-serialisable: a `Map` or a `Date` smuggled into the state would be visibly
 * mangled here, at the first action, rather than at the first time the state crossed the wire.
 */
function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

export function reduce(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  action: Action,
  options: ReduceOptions = {},
): Result<Tick, RuleViolation> {
  if (state.outcome !== null) {
    return violation('gameOver', `the game is already won by ${state.outcome.winner}`);
  }

  const step = currentStep(state);
  if (step === undefined) {
    return violation('gameOver', 'there is nothing to act on');
  }
  if (!stepBelongsTo(step, actor)) {
    return violation('notYourStep', `${actor} does not own the current step (${step.kind})`, {
      step: step.kind,
      actor,
    });
  }

  const handler = ctx.rules.steps[step.kind];
  if (handler?.apply === undefined) {
    return violation('wrongStep', `step ${step.kind} takes no player actions`, { step: step.kind });
  }

  const tx = new Tx(ctx, cloneState(state));
  // The step the handler sees comes from the *draft*, so anything it mutates through `amendTop`
  // is visible to it, not to a stale copy of the original state.
  const draftStep = currentStep(tx.state);
  if (draftStep === undefined) throw new Error('reduce: the draft lost its step');

  const applied = handler.apply(ctx, tx, draftStep, actor, action);
  if (!applied.ok) return applied;

  settle(ctx, tx);

  if (options.invariants !== undefined) assertInvariants(tx.state, options.invariants);
  return ok({ state: tx.state, events: tx.events });
}

/**
 * Bring the game to rest: awards, victory, then any `system` steps, and repeat.
 *
 * The loop is not a formality. A system step can hand out a card (setup production), which can
 * change a victory-point total; a resolved award can win the game. Running the three to a fixed
 * point is what makes the order they are written in irrelevant.
 */
export function settle(ctx: RuleContext, tx: Tx): void {
  for (let guard = 0; guard <= MAX_SYSTEM_STEPS; guard++) {
    resolveAwards(ctx, tx);
    if (checkVictory(ctx, tx)) return;

    const step = currentStep(tx.state);
    if (step === undefined || step.actor !== 'system') return;

    const handler = ctx.rules.steps[step.kind];
    if (handler?.run === undefined) {
      throw new Error(`settle: system step ${step.kind} has no handler`);
    }
    handler.run(ctx, tx, step);
  }
  throw new Error(
    `settle: ${MAX_SYSTEM_STEPS} system steps resolved without reaching a player — ` +
      'a step handler is pushing itself',
  );
}

/**
 * End the game if the active player has reached the target.
 *
 * Only the active player is considered, which is the published rule: you win *on your turn*.
 * Reaching 10 points because someone else's road was cut on their turn does not win the game
 * there and then — it wins it when your turn comes round, which this check reaches via the
 * `beginTurn` step.
 */
export function checkVictory(ctx: RuleContext, tx: Tx): boolean {
  const state = tx.state;
  if (state.outcome !== null) return true;

  const active = state.turn.active;
  const points = ctx.rules.victoryPoints(ctx, state, active);
  if (points < ctx.scenario.victoryTarget) return false;

  tx.finish({ winner: active, reason: `reached ${points} victory points` });
  tx.emit(event('victory', { player: active, points }));
  return true;
}

/**
 * Whether an action would be accepted, without keeping the result.
 *
 * Implemented as a dry run of `reduce` rather than as a parallel set of checks. Two
 * implementations of legality would eventually disagree, and the one that mattered would be
 * whichever the reducer used — so this is the only way to make the README's claim that `isLegal`
 * is the authority literally true.
 */
export function isLegal(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  action: Action,
): Result<void, RuleViolation> {
  const result = reduce(ctx, state, actor, action);
  return result.ok ? ok(undefined) : result;
}

/**
 * What `actor` may do right now, as descriptors for UIs and bots.
 *
 * Never consulted by the reducer. A spec is a hint: it may be stale by the time it is played, and
 * a ruleset may legitimately enumerate a subset (`enumerated: false`). `isLegal` decides.
 */
export function legalActions(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
): readonly ActionSpec[] {
  if (state.outcome !== null) return [];
  const step = currentStep(state);
  if (step === undefined || !stepBelongsTo(step, actor)) return [];
  return ctx.rules.steps[step.kind]?.actions?.(ctx, state, step, actor) ?? [];
}
