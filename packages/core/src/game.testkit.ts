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
import type { CardId, CardKind, DeckId, EdgeId, PlayerId, VertexId } from './ids.js';
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

/**
 * Every option of the given action type on offer to `actor`.
 *
 * Flattened across specs, because a step may offer several specs of one type — the main phase
 * emits one `build` spec per piece kind so a UI can group them, and a test asking "what can I
 * build?" wants all three.
 */
export function offered(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  type: string,
): readonly Action[] {
  return legalActions(ctx, state, actor)
    .filter((s) => s.type === type)
    .flatMap((s) => s.options);
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
 * Drive the game until `player` (or anyone) is in the main phase, playing every step that gets in
 * the way with its first offered option.
 *
 * Other players' turns are ended immediately rather than played, so a test that wants "it is now
 * p0's build phase, three turns later" does not have to care what p1 built in the meantime.
 */
export function advanceToMain(game: NewGame, from: GameState, player?: PlayerId): GameState {
  let state = from;
  for (let guard = 0; guard < 400; guard++) {
    if (state.outcome !== null) throw new Error('advanceToMain: the game ended');
    const step = currentStep(state);
    if (step === undefined) throw new Error('advanceToMain: nothing to do');
    const actor = ([step.actor].flat()[0] ?? '') as PlayerId;
    if (step.kind === 'main' && (player === undefined || actor === player)) return state;

    const action =
      step.kind === 'main'
        ? { type: 'endTurn' }
        : legalActions(game.ctx, state, actor).flatMap((s) => s.options)[0];
    if (action === undefined) throw new Error(`advanceToMain: ${actor} cannot act on ${step.kind}`);
    state = act(game.ctx, state, actor, action);
  }
  throw new Error('advanceToMain: gave up');
}

/** End the current turn and come back round to `player`'s main phase. */
export function laterTurn(game: NewGame, from: GameState, player: PlayerId): GameState {
  const step = currentStep(from);
  const actor = ([step?.actor].flat()[0] ?? '') as PlayerId;
  const ended = step?.kind === 'main' ? act(game.ctx, from, actor, { type: 'endTurn' }) : from;
  return advanceToMain(game, ended, player);
}

/**
 * Roll until a robber roll comes up, ending each turn in between.
 *
 * Returns the state with the 7 already rolled, so the top of the stack is whatever the 7 pushed —
 * a discard step if anyone is over the limit, the robber otherwise.
 */
export function rollUntilRobber(game: NewGame, from: GameState): GameState {
  let state = from;
  for (let guard = 0; guard < 400; guard++) {
    const step = currentStep(state);
    if (step === undefined) throw new Error('rollUntilRobber: nothing to do');
    const actor = ([step.actor].flat()[0] ?? '') as PlayerId;
    if (step.kind === 'discard' || step.kind === 'robber') return state;
    const action = step.kind === 'main' ? { type: 'endTurn' } : { type: 'roll' };
    state = act(game.ctx, state, actor, action);
  }
  throw new Error('rollUntilRobber: no 7 in 400 actions');
}

/**
 * Move the named card definitions to the top of a deck.
 *
 * Reordering a draw pile keeps every card in exactly one place, so the invariants still hold — it
 * is the same surgery as stacking a deck before a demonstration game.
 */
export function stackDeck(state: GameState, deck: DeckId, defs: readonly string[]): GameState {
  const pile = state.decks[deck];
  if (pile === undefined) throw new Error(`stackDeck: no ${deck} deck`);
  const rest = [...pile.draw];
  const top: CardId[] = [];
  for (const def of defs) {
    const i = rest.findIndex((c) => state.cardInstances[c]?.def === def);
    if (i < 0) throw new Error(`stackDeck: no ${def} left in the ${deck} deck`);
    top.push(rest.splice(i, 1)[0] as CardId);
  }
  pile.draw = [...top, ...rest];
  return state;
}

/** The cards in a player's hand whose definition is `def`. */
export function handCards(state: GameState, player: PlayerId, def: string): readonly CardId[] {
  const p = state.players[player];
  return Object.values(p?.hands ?? {})
    .flat()
    .filter((c) => state.cardInstances[c]?.def === def);
}

/**
 * Move cards from the bank into a hand, returning a copy.
 *
 * Conserving, so the invariants hold — this is "the player earned these earlier", not "these were
 * conjured", which is the difference between a fixture and a corrupt state. It copies rather than
 * mutates so that a test can *probe* with it (`offered(ctx, grant(state, …), …)`) without the
 * probe quietly enriching the state it was asking about.
 */
export function grant(from: GameState, player: PlayerId, cards: Cost): GameState {
  const state = JSON.parse(JSON.stringify(from)) as GameState;
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
