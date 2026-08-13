/**
 * A real game to render.
 *
 * The client's tests are about presentation, but they run against genuine engine output — a dealt
 * board, real `ActionSpec`s, real events. A hand-written fixture would drift from the engine the
 * first time a spec changed shape, and drifting silently is exactly the failure these tests exist
 * to catch.
 */

import {
  baseRules,
  type GameState,
  type NewGame,
  newGame,
  type PlayerId,
  type PlayerView,
  playerId,
  type RuleContext,
  Session,
  scenarioForPlayers,
} from '@catan/core';

export interface Fixture {
  readonly game: NewGame;
  readonly ctx: RuleContext;
  readonly session: Session;
  readonly state: GameState;
  /** The spectator's view — the strictest redaction, so nothing under test can cheat. */
  readonly view: PlayerView;
}

export const P: readonly PlayerId[] = [0, 1, 2, 3].map(playerId);

export function fixture(seed = 11, players = 4): Fixture {
  const game = newGame({
    scenario: scenarioForPlayers(players),
    rules: baseRules(),
    seed,
    players,
  });
  const session = new Session(game);
  return {
    game,
    ctx: game.ctx,
    session,
    state: session.state,
    view: session.view(null),
  };
}

/** Play the first offered option for whoever the engine is waiting on, `steps` times. */
export function advance(fixture: Fixture, steps: number): Fixture {
  for (let i = 0; i < steps; i++) {
    const step = fixture.session.state.stack.at(-1);
    if (step === undefined || step.actor === 'system') break;
    const actor = (Array.isArray(step.actor) ? step.actor[0] : step.actor) as PlayerId;
    const action = fixture.session.options(actor)[0]?.options[0];
    if (action === undefined) break;
    const result = fixture.session.act(actor, action);
    if (!result.ok) throw new Error(`advance: ${result.error.message}`);
  }
  return {
    ...fixture,
    state: fixture.session.state,
    view: fixture.session.view(null),
  };
}
