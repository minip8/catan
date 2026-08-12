/**
 * Fixtures shared by the rule tests. Not shipped — see `tsconfig.json`'s `exclude`.
 *
 * The guiding rule here is that a test drives the engine **the way a client does**: `newGame`,
 * then `legalActions`, then `reduce`. Tests that hand-build a `GameState` end up asserting against
 * a board no reducer ever produced, and they keep passing after the reducer breaks.
 *
 * The one exception is `grant`, which moves cards from the bank into a hand so a test can set up
 * "this player can afford a city" without rolling dice until it happens. It conserves cards, so
 * the invariants still hold afterwards.
 */

import { expect } from 'vitest';

import { baseScenario34 } from './board/presets.js';
import { invariantsFor, type NewGame, newGame } from './engine/newGame.js';
import { legalActions, reduce, type Tick } from './engine/reduce.js';
import type { CardKind, EdgeId, PlayerId, VertexId } from './ids.js';
import { playerId } from './ids.js';
import type { Result } from './result.js';
import type { Action } from './rules/action.js';
import type { RuleContext } from './rules/ruleset.js';
import type { RuleViolation, ViolationCode } from './rules/violation.js';
import { baseRules } from './rulesets/base/index.js';
import { type Cost, currentStep, type GameState } from './state/gameState.js';
import { assertInvariants } from './state/invariants.js';

export const P = [0, 1, 2, 3].map(playerId) as readonly PlayerId[];

export function newBaseGame(seed = 1, players = 4): NewGame {
  return newGame({ scenario: baseScenario34(), rules: baseRules(), seed, players });
}

/** Apply an action, asserting it was legal, and check the invariants on the way out. */
export function act(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  action: Action,
): GameState {
  const result = reduce(ctx, state, actor, action);
  if (!result.ok) {
    throw new Error(
      `expected ${actor}'s ${JSON.stringify(action)} to be legal, but: ` +
        `${result.error.code} — ${result.error.message}`,
    );
  }
  assertInvariants(result.value.state, invariantsFor(ctx, result.value.state));
  return result.value.state;
}

/** Apply an action expected to be refused, and assert the code. Returns the violation. */
export function refuse(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  action: Action,
  code?: ViolationCode,
): RuleViolation {
  const result = reduce(ctx, state, actor, action);
  if (result.ok) {
    throw new Error(`expected ${actor}'s ${JSON.stringify(action)} to be refused, but it was not`);
  }
  if (code !== undefined) expect(result.error.code).toBe(code);
  return result.error;
}

export function tick(ctx: RuleContext, state: GameState, actor: PlayerId, action: Action): Tick {
  const result = reduce(ctx, state, actor, action);
  if (!result.ok) throw new Error(`unexpected violation: ${result.error.message}`);
  return result.value;
}

/** The first action of the given type on offer to `actor`, or `undefined`. */
export function offered(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  type: string,
): readonly Action[] {
  return legalActions(ctx, state, actor).find((s) => s.type === type)?.options ?? [];
}

/**
 * Play the whole opening, choosing the `pick`-th option each time.
 *
 * Deterministic and dull on purpose: the tests that follow care about what the board looks like
 * afterwards, not about the opening being good.
 */
export function playSetup(game: NewGame, pick = 0): GameState {
  let state = game.state;
  for (let guard = 0; guard < 64; guard++) {
    const step = currentStep(state);
    if (step === undefined || step.kind !== 'setup') return state;
    const actor = step.actor as PlayerId;
    const options = offered(game.ctx, state, actor, 'place');
    const choice = options[Math.min(pick, options.length - 1)];
    if (choice === undefined) throw new Error(`playSetup: ${actor} has nowhere to place`);
    state = act(game.ctx, state, actor, choice);
  }
  throw new Error('playSetup: the opening did not finish');
}

/**
 * Move cards from the bank into a hand.
 *
 * Conserving, so the invariants hold — this is "the player earned these earlier", not "these were
 * conjured", which is the difference between a fixture and a corrupt state.
 */
export function grant(state: GameState, player: PlayerId, cards: Cost): GameState {
  const p = state.players[player];
  if (p === undefined) throw new Error(`grant: unknown player ${player}`);
  for (const [kind, n] of Object.entries(cards)) {
    if (n === undefined) continue;
    const available = state.bank[kind as CardKind] ?? 0;
    if (available < n) throw new Error(`grant: the bank has only ${available} ${kind}`);
    state.bank[kind as CardKind] = available - n;
    p.cards[kind as CardKind] = (p.cards[kind as CardKind] ?? 0) + n;
  }
  return state;
}

/** Everything a player owns of one kind, by locus. */
export function lociOf(state: GameState, player: PlayerId, kind: string): readonly string[] {
  return Object.values(state.board.pieces)
    .filter((p) => p.owner === player && p.kind === kind && p.at !== null)
    .map((p) => p.at as string);
}

export function vertexOf(state: GameState, player: PlayerId, kind = 'settlement'): VertexId {
  const [first] = lociOf(state, player, kind);
  if (first === undefined) throw new Error(`${player} has no ${kind}`);
  return first as VertexId;
}

export function edgeOf(state: GameState, player: PlayerId): EdgeId {
  const [first] = lociOf(state, player, 'road');
  if (first === undefined) throw new Error(`${player} has no road`);
  return first as EdgeId;
}

/** Unwrap a `Result` in a test, with the violation in the failure message. */
export function unwrap<T>(result: Result<T, RuleViolation>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
