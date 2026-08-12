/**
 * Replay: rebuilding a game from what was decided, not from what happened.
 *
 * ```
 * (seed, scenarioId, ruleSetId, seatOrder, actionLog) → the whole game
 * ```
 *
 * That is the claim the engine's purity exists to support, and this module is where it is cashed
 * in. Nothing else is stored: no board, no dice results, no shuffles. The board is dealt from the
 * seed, and every die roll and steal comes out of the same generator in the same order, because
 * `Tx.random` is the only entropy in the engine and actions are applied in the order they were
 * played.
 *
 * What it buys:
 *
 * - **Bug reports that reproduce.** A record is a few kilobytes of JSON, and it replays to exactly
 *   the state the player was looking at.
 * - **Desync detection.** A server and a client that disagree about the state after the same log
 *   have a bug in one of them; `replay` is how you find out which.
 * - **Cheap persistence.** Storing the log is smaller and more durable than storing snapshots of a
 *   state whose shape will change as expansions land.
 *
 * A record does *not* store the resulting state, deliberately. A stored state would eventually
 * disagree with the log, and then there would be two truths.
 */

import { scenarioById } from '../board/presets.js';
import type { Scenario } from '../board/scenario.js';
import type { PlayerId } from '../ids.js';
import type { Action } from '../rules/action.js';
import type { GameEvent } from '../rules/event.js';
import type { RuleContext, RuleSet } from '../rules/ruleset.js';
import { baseRules } from '../rulesets/base/index.js';
import type { GameState } from '../state/gameState.js';
import { newGame } from './newGame.js';
import { reduce } from './reduce.js';

/** One entry in the log: who acted, and what they asked for. */
export interface LoggedAction {
  readonly actor: PlayerId;
  readonly action: Action;
}

/** Everything needed to reconstruct a game. JSON, and small. */
export interface GameRecord {
  readonly seed: number;
  readonly scenarioId: string;
  readonly ruleSetId: string;
  readonly seatOrder: readonly PlayerId[];
  readonly actions: readonly LoggedAction[];
}

export interface ReplayOptions {
  /** Supply a scenario that `scenarioById` cannot rebuild — a custom or generated map. */
  readonly scenario?: Scenario;
  /** Supply a ruleset that is not the base game. */
  readonly rules?: RuleSet;
  /**
   * Stop after this many actions, for stepping through a game.
   *
   * The state after `n` actions is exactly what the players saw at that point, which is what makes
   * this usable as the back end of a replay scrubber.
   */
  readonly upTo?: number;
}

export interface Replay {
  readonly ctx: RuleContext;
  readonly state: GameState;
  /** Every event, in order, from the whole run. Redact before showing them to anyone. */
  readonly events: readonly GameEvent[];
  /** How many actions were applied. Less than the log length only when `upTo` was given. */
  readonly applied: number;
}

export class ReplayError extends Error {}

/** Start a record for a game that is about to begin. Append with `record`. */
export function newRecord(state: GameState, actions: readonly LoggedAction[] = []): GameRecord {
  return {
    seed: state.seed,
    scenarioId: state.scenarioId,
    ruleSetId: state.ruleSetId,
    seatOrder: state.seatOrder,
    actions,
  };
}

/** Append an action to a record. */
export function record(from: GameRecord, actor: PlayerId, action: Action): GameRecord {
  return { ...from, actions: [...from.actions, { actor, action }] };
}

/**
 * Rebuild the game a record describes.
 *
 * Throws `ReplayError` on the first action the rules now refuse. That is the point: a log that no
 * longer replays means the engine's behaviour changed under it, and the failure names the action
 * and the violation so the change can be found.
 */
export function replay(saved: GameRecord, options: ReplayOptions = {}): Replay {
  const scenario = options.scenario ?? scenarioById(saved.scenarioId);
  if (scenario === undefined) {
    throw new ReplayError(
      `replay: unknown scenario ${saved.scenarioId} — pass it in options.scenario`,
    );
  }
  const rules = options.rules ?? (saved.ruleSetId === baseRules().id ? baseRules() : undefined);
  if (rules === undefined) {
    throw new ReplayError(`replay: unknown ruleset ${saved.ruleSetId} — pass it in options.rules`);
  }

  const game = newGame({
    scenario,
    rules,
    seed: saved.seed,
    players: saved.seatOrder,
  });

  const limit = Math.min(options.upTo ?? saved.actions.length, saved.actions.length);
  const events: GameEvent[] = [...game.events];
  let state = game.state;

  for (let i = 0; i < limit; i++) {
    const entry = saved.actions[i] as LoggedAction;
    const result = reduce(game.ctx, state, entry.actor, entry.action);
    if (!result.ok) {
      throw new ReplayError(
        `replay: action ${i} (${entry.actor} ${JSON.stringify(entry.action)}) is no longer legal: ` +
          `${result.error.code} — ${result.error.message}`,
      );
    }
    state = result.value.state;
    events.push(...result.value.events);
  }

  return { ctx: game.ctx, state, events, applied: limit };
}
