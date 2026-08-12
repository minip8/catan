import { describe, expect, it } from 'vitest';

import { newBaseGame, P } from '../game.testkit.js';
import { replay } from './replay.js';
import { Session } from './session.js';

const [p0, p1] = P as [(typeof P)[0], (typeof P)[1]];

describe('Session', () => {
  it('advances on a legal action and delivers one view per seat plus spectators', () => {
    const session = new Session(newBaseGame(11), { checkInvariants: true });
    const action = session.options(p0)[0]?.options[0];
    expect(action).toBeDefined();

    const result = session.act(p0, action as never);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value).toHaveLength(session.state.seatOrder.length + 1);
    expect(result.value.map((d) => d.viewer)).toEqual([...session.state.seatOrder, null]);
    for (const delivery of result.value) {
      expect(delivery.view.rng).toBeNull();
      expect(delivery.view.viewer).toBe(delivery.viewer);
    }
  });

  it('changes nothing when the action is refused', () => {
    const session = new Session(newBaseGame(11));
    const before = JSON.stringify(session.state);

    const result = session.act(p1, { type: 'endTurn' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(session.record.actions).toHaveLength(0);
  });

  it('keeps a record that replays to the state it holds', () => {
    const session = new Session(newBaseGame(5));
    for (let i = 0; i < 40 && !session.over; i++) {
      const step = session.state.stack.at(-1);
      const actor = ([step?.actor].flat()[0] ?? p0) as typeof p0;
      const action = session.options(actor)[0]?.options[0];
      if (action === undefined) break;
      const result = session.act(actor, action);
      if (!result.ok) throw new Error(result.error.message);
    }

    expect(session.record.actions.length).toBeGreaterThan(8);
    expect(replay(session.record).state).toEqual(session.state);
  });
});
