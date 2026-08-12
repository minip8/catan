/**
 * The replay contract, checked against real games rather than fixtures.
 *
 * Every test here plays a game with `autoplay`, keeps only the action log, and rebuilds the game
 * from it — which is the same thing a bug report, a desync check and a saved game all do.
 */

import { describe, expect, it } from 'vitest';

import { generatedScenario } from '../board/presets.js';
import { newBaseGame } from '../game.testkit.js';
import { baseRules } from '../rulesets/base/index.js';
import { autoplay } from './autoplay.js';
import { newGame } from './newGame.js';
import { newRecord, ReplayError, replay } from './replay.js';

function playAndRecord(seed: number, maxActions = 600) {
  const game = newBaseGame(seed);
  const run = autoplay(game.ctx, game.state, { seed, maxActions });
  const saved = newRecord(
    game.state,
    run.log.map((s) => ({ actor: s.actor, action: s.action })),
  );
  return { game, run, saved };
}

describe('replay', () => {
  it('rebuilds a game exactly from seed and action log', () => {
    const { run, saved } = playAndRecord(17);
    expect(saved.actions.length).toBeGreaterThan(50);

    const rebuilt = replay(saved);
    expect(rebuilt.applied).toBe(saved.actions.length);
    expect(rebuilt.state).toEqual(run.state);
  });

  it('carries nothing but the decisions', () => {
    const { saved } = playAndRecord(17, 60);
    // The record holds no board, no dice, no shuffles — those all come back out of the seed.
    expect(Object.keys(saved).sort()).toEqual([
      'actions',
      'ruleSetId',
      'scenarioId',
      'seatOrder',
      'seed',
    ]);
    expect(JSON.stringify(saved)).not.toContain('terrain');
  });

  it('stops where it is told, so a scrubber can step through', () => {
    const { saved } = playAndRecord(17, 200);
    const half = Math.floor(saved.actions.length / 2);

    const partial = replay(saved, { upTo: half });
    expect(partial.applied).toBe(half);

    // Continuing from the same log reaches the same place as replaying it whole.
    const whole = replay(saved);
    expect(whole.state).not.toEqual(partial.state);
    expect(replay(saved, { upTo: saved.actions.length }).state).toEqual(whole.state);
  });

  it('reports the first action that is no longer legal', () => {
    const { saved } = playAndRecord(17, 40);
    const tampered = {
      ...saved,
      actions: [
        { actor: saved.seatOrder[1] as never, action: { type: 'endTurn' } },
        ...saved.actions,
      ],
    };
    expect(() => replay(tampered)).toThrow(ReplayError);
    expect(() => replay(tampered)).toThrow(/action 0/);
  });

  it('refuses a scenario it cannot rebuild, unless given one', () => {
    const scenario = generatedScenario(7);
    const game = newGame({ scenario, rules: baseRules(), seed: 4, players: 7 });
    const saved = newRecord(game.state, []);

    // Generated boards *are* rebuildable from their id, so this one round-trips.
    expect(replay(saved).state).toEqual(game.state);

    const unknown = { ...saved, scenarioId: 'someone/custom/map' };
    expect(() => replay(unknown)).toThrow(/unknown scenario/);
    expect(replay(unknown, { scenario }).state.scenarioId).toBe(scenario.id);
  });

  it('refuses a ruleset it does not know', () => {
    const { saved } = playAndRecord(17, 10);
    expect(() => replay({ ...saved, ruleSetId: 'catan/seafarers' })).toThrow(/unknown ruleset/);
  });
});
