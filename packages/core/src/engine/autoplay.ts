/**
 * A driver that plays a game by itself.
 *
 * Its job is not to play *well* — it picks uniformly among the actions the ruleset offers — but to
 * play *legally, from the outside*, exactly as a client would: read `legalActions`, send one, get
 * a `Tick` back. That makes it three useful things at once:
 *
 * - a fuzz harness (run it with the invariant check on, over thousands of seeds, and any state
 *   corruption surfaces at the action that caused it),
 * - a smoke test that the rules do not deadlock — every reachable step must offer somebody
 *   something to do, or the game stops with `stalled`,
 * - the baseline a real bot is measured against.
 *
 * Its own randomness is a separate generator from the game's. Sharing one would make the *choice*
 * of action perturb the dice, so replaying a recorded action log would diverge.
 */

import type { PlayerId } from '../ids.js';
import { nextBelow, type RngState, seedRng } from '../rng.js';
import type { Action } from '../rules/action.js';
import type { GameEvent } from '../rules/event.js';
import type { RuleContext } from '../rules/ruleset.js';
import { currentStep, type GameState } from '../state/gameState.js';
import type { InvariantContext } from '../state/invariants.js';
import { legalActions, reduce } from './reduce.js';

/** One action, and what it did. */
export interface AutoplayStep {
  readonly actor: PlayerId;
  readonly action: Action;
  readonly events: readonly GameEvent[];
}

export type AutoplayEnd = 'won' | 'exhausted' | 'stalled';

export interface AutoplayResult {
  readonly state: GameState;
  readonly log: readonly AutoplayStep[];
  /**
   * - `won` — someone reached the victory target.
   * - `exhausted` — the action budget ran out. Normal for a short budget.
   * - `stalled` — nobody could act. **Always a bug**: a step exists that offers no legal action.
   */
  readonly end: AutoplayEnd;
}

export interface AutoplayOptions {
  readonly seed?: number;
  /** Safety valve. A base-game 4-player game finishes in a few hundred actions. */
  readonly maxActions?: number;
  /** Check structural invariants after every action. On by default — this is a test tool. */
  readonly invariants?: InvariantContext | null;
  /**
   * Last resort for steps whose legal space the ruleset does not enumerate.
   *
   * Consulted only when every spec for the current actor is empty. Returning `undefined` lets the
   * run stall, which is the honest outcome: a step nobody can satisfy is a bug worth failing on.
   */
  readonly compose?: (ctx: RuleContext, state: GameState, actor: PlayerId) => Action | undefined;
}

export function autoplay(
  ctx: RuleContext,
  initial: GameState,
  options: AutoplayOptions = {},
): AutoplayResult {
  const { maxActions = 5000, invariants = null, compose } = options;
  let rng: RngState = seedRng(options.seed ?? 1);
  const pick = (bound: number): number => {
    const draw = nextBelow(rng, bound);
    rng = draw.state;
    return draw.value;
  };

  let state = initial;
  const log: AutoplayStep[] = [];

  for (let i = 0; i < maxActions; i++) {
    if (state.outcome !== null) return { state, log, end: 'won' };

    const step = currentStep(state);
    if (step === undefined) return { state, log, end: 'stalled' };
    const actors = step.actor === 'system' ? [] : [step.actor].flat();
    // A system step left at the top after `settle` means the ruleset has no handler for it.
    if (actors.length === 0) return { state, log, end: 'stalled' };

    const actor = actors[pick(actors.length)] as PlayerId;
    const options_ = legalActions(ctx, state, actor).flatMap((s) => s.options);
    const action =
      options_.length > 0 ? options_[pick(options_.length)] : compose?.(ctx, state, actor);
    if (action === undefined) return { state, log, end: 'stalled' };

    const tick = reduce(ctx, state, actor, action, invariants ? { invariants } : {});
    if (!tick.ok) {
      // `legalActions` offered it, so the reducer must accept it. If it does not, the two have
      // drifted apart — which is exactly the bug this harness exists to find.
      throw new Error(
        `autoplay: ${actor} was offered ${JSON.stringify(action)} but it was refused: ` +
          `${tick.error.code} — ${tick.error.message}`,
      );
    }
    state = tick.value.state;
    log.push({ actor, action, events: tick.value.events });
  }

  return { state, log, end: state.outcome === null ? 'exhausted' : 'won' };
}
