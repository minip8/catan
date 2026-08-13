import { describe, expect, it } from 'vitest';

import { newBaseGame, P } from '../game.testkit.js';
import { replay } from './replay.js';
import { restoreSession, Session } from './session.js';

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

describe('restoreSession', () => {
  function played(actions: number): Session {
    const session = new Session(newBaseGame(5));
    for (let i = 0; i < actions; i++) {
      const step = session.state.stack.at(-1);
      const actor = ([step?.actor].flat()[0] ?? p0) as typeof p0;
      // The first option of the first spec is not always there — a trade offer is advertised
      // with an empty option list — so take the first action anything offers.
      const action = session.options(actor).flatMap((spec) => spec.options)[0];
      if (action === undefined) break;
      const result = session.act(actor, action);
      if (!result.ok) throw new Error(result.error.message);
    }
    return session;
  }

  it('comes back holding the same state and the same history', () => {
    const original = played(24);
    const restored = restoreSession(original.record);

    expect(restored.state).toEqual(original.state);
    expect(restored.record).toEqual(original.record);
  });

  it('keeps appending to the log it was given, not starting a new one', () => {
    const original = played(24);
    const restored = restoreSession(original.record);

    const step = restored.state.stack.at(-1);
    const actor = ([step?.actor].flat()[0] ?? p0) as typeof p0;
    const action = restored.options(actor).flatMap((spec) => spec.options)[0];
    if (action === undefined) throw new Error('nothing to play');
    const result = restored.act(actor, action);
    if (!result.ok) throw new Error(result.error.message);

    expect(restored.record.actions).toHaveLength(original.record.actions.length + 1);
    // The record is still a complete replay of the whole game, not just of what happened after
    // the restore — which is the point of restoring it this way.
    expect(replay(restored.record).state).toEqual(restored.state);
  });

  it('cuts the record to what it actually replayed', () => {
    const original = played(24);
    const half = Math.floor(original.record.actions.length / 2);
    const partial = restoreSession(original.record, { upTo: half });

    expect(partial.record.actions).toHaveLength(half);
    expect(replay(partial.record).state).toEqual(partial.state);
  });

  it('refuses a record from a different game', () => {
    const mine = new Session(newBaseGame(5));
    const theirs = new Session(newBaseGame(6));
    expect(() => new Session(newBaseGame(5), { record: theirs.record })).toThrow(
      /does not belong to this game/,
    );
    expect(() => new Session(newBaseGame(5), { record: mine.record })).not.toThrow();
  });
});
