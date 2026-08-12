/**
 * The reducer's contract, and a fuzz run over whole games.
 *
 * The fuzz test is the most valuable test in the package. It plays complete games from the
 * outside, checking every structural invariant after every action, so a bug anywhere in the rules
 * — a card minted, a piece lost, an occupancy index left stale — surfaces at the action that
 * caused it rather than as a mysterious state ten turns later.
 */

import { describe, expect, it } from 'vitest';

import { baseScenario34, baseScenario56 } from '../board/presets.js';
import { newBaseGame, P, playSetup } from '../game.testkit.js';
import { playerId } from '../ids.js';
import { baseRules } from '../rulesets/base/index.js';
import { currentStep } from '../state/gameState.js';
import { autoplay } from './autoplay.js';
import { invariantsFor, newGame } from './newGame.js';
import { isLegal, legalActions, reduce } from './reduce.js';

const [p0, p1] = P as [(typeof P)[0], (typeof P)[1]];

describe('reduce', () => {
  const game = newBaseGame(11);

  it('refuses anyone who does not own the top step', () => {
    const result = reduce(game.ctx, game.state, p1, { type: 'place' });
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).toBe('notYourStep');
  });

  it('refuses an action the step does not take', () => {
    const result = reduce(game.ctx, game.state, p0, { type: 'endTurn' });
    expect(result.ok || result.error.code).toBe('wrongStep');
  });

  it('refuses a malformed payload without throwing', () => {
    // The reducer's input is untrusted: a hostile client sends whatever it likes.
    for (const action of [
      { type: 'place' },
      { type: 'place', kind: 'settlement' },
      { type: 'place', kind: 'settlement', at: 42 },
      { type: 'place', kind: 'settlement', at: 'not-a-vertex' },
      { type: 'place', kind: 'nonsense', at: '0,0|0,1|1,0' },
    ]) {
      const result = reduce(game.ctx, game.state, p0, action);
      expect(result.ok).toBe(false);
    }
  });

  it('leaves the original state untouched when it refuses', () => {
    const before = JSON.stringify(game.state);
    reduce(game.ctx, game.state, p0, { type: 'place', kind: 'settlement', at: 'nowhere' });
    expect(JSON.stringify(game.state)).toBe(before);
  });

  it('leaves the original state untouched when it accepts', () => {
    // The reducer returns a new state; the caller's copy is never mutated, which is what lets a
    // server hold the previous state for a client that has not acknowledged yet.
    const before = JSON.stringify(game.state);
    const result = reduce(
      game.ctx,
      game.state,
      p0,
      legalActions(game.ctx, game.state, p0)[0]?.options[0] as never,
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(game.state)).toBe(before);
  });

  it('agrees with isLegal on everything it offers', () => {
    let state = playSetup(game);
    for (let turn = 0; turn < 12; turn++) {
      const step = currentStep(state);
      if (step === undefined) break;
      const actor = ([step.actor].flat()[0] ?? p0) as typeof p0;
      const options = legalActions(game.ctx, state, actor).flatMap((s) => s.options);
      for (const option of options) {
        expect(isLegal(game.ctx, state, actor, option).ok).toBe(true);
      }
      const chosen = options[0];
      if (chosen === undefined) break;
      const result = reduce(game.ctx, state, actor, chosen);
      if (!result.ok) throw new Error(result.error.message);
      state = result.value.state;
    }
  });

  it('offers nothing to a player whose step it is not', () => {
    expect(legalActions(game.ctx, game.state, p1)).toEqual([]);
  });
});

describe('autoplay', () => {
  // Several seeds, because a single game exercises one board and one sequence of rolls. Each run
  // asserts the invariants after every action, so this is a fuzz test wearing a plain coat.
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`plays a 4-player game from seed ${seed} without breaking an invariant`, () => {
      const game = newBaseGame(seed);
      const result = autoplay(game.ctx, game.state, {
        seed,
        maxActions: 4000,
        invariants: invariantsFor(game.ctx, game.state),
      });

      // `stalled` means some step offered nobody anything — a deadlock, and always a bug.
      expect(result.end).not.toBe('stalled');
      expect(result.log.length).toBeGreaterThan(20);
      if (result.end === 'won') {
        const winner = result.state.outcome?.winner as typeof p0;
        expect(game.ctx.rules.victoryPoints(game.ctx, result.state, winner)).toBeGreaterThanOrEqual(
          baseScenario34().victoryTarget,
        );
      }
    });
  }

  it('plays a 6-player game on the larger board', () => {
    const game = newGame({
      scenario: baseScenario56(),
      rules: baseRules(),
      seed: 8,
      players: 6,
    });
    const result = autoplay(game.ctx, game.state, {
      seed: 8,
      maxActions: 2500,
      invariants: invariantsFor(game.ctx, game.state),
    });
    expect(result.end).not.toBe('stalled');
  });

  it('replays identically from the same seeds', () => {
    // The whole replay contract in one assertion: same seed, same choices, same game.
    const run = () => {
      const game = newBaseGame(21);
      return autoplay(game.ctx, game.state, { seed: 99, maxActions: 400 });
    };
    const a = run();
    const b = run();
    expect(b.state).toEqual(a.state);
    expect(b.log.map((s) => s.action)).toEqual(a.log.map((s) => s.action));
  });

  it('reaches a winner given enough actions', () => {
    // Random play is slow to win — it trades badly and builds at random — so this needs headroom.
    const game = newBaseGame(7, 3);
    const result = autoplay(game.ctx, game.state, { seed: 4, maxActions: 8000 });
    expect(result.end).toBe('won');
    expect(result.state.outcome).not.toBeNull();
    expect(result.state.seatOrder).toContain(result.state.outcome?.winner);
  });

  it('never lets a player act out of turn', () => {
    const game = newBaseGame(31);
    const result = autoplay(game.ctx, game.state, { seed: 31, maxActions: 600 });
    // Every logged action was accepted, and `reduce` accepts only step owners — so the log is a
    // record of correctly-attributed authority. Spot-check that it is not all one player.
    const actors = new Set(result.log.map((s) => s.actor));
    expect(actors.size).toBeGreaterThan(1);
    expect([...actors].every((a) => result.state.seatOrder.includes(a))).toBe(true);
  });
});

describe('three-player games', () => {
  it('seats three players and opens the same way', () => {
    const game = newGame({
      scenario: baseScenario34(),
      rules: baseRules(),
      seed: 2,
      players: 3,
    });
    expect(game.state.seatOrder).toEqual([0, 1, 2].map(playerId));
    expect(game.state.stack).toHaveLength(3 * 2 + 1);
    const opened = playSetup(game);
    expect(currentStep(opened)?.kind).toBe('roll');
  });
});
