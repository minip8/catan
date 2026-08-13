/**
 * The seam itself.
 *
 * `app.test.ts` exercises the local table thoroughly by clicking on it; what is checked here is the
 * contract the app is written against, and the one function that makes a networked client possible
 * at all — rebuilding the rule context from a view, so a board can be drawn from a picture of it.
 */

import { describe, expect, it } from 'vitest';

import { contextFor, LocalTable } from './table.js';

describe('LocalTable', () => {
  it('offers every seat and a spectator, and redacts each one separately', () => {
    const table = new LocalTable({ seed: 11, players: 4 });

    expect(table.viewpoints).toEqual(['p0', 'p1', 'p2', 'p3', null]);
    for (const viewer of table.viewpoints) {
      const snap = table.snapshot(viewer);
      expect(snap.viewer).toBe(viewer);
      expect(snap.view.viewer).toBe(viewer);
      expect(snap.view.rng).toBeNull();
    }
    // Only the seat being waited on is offered anything, and a spectator never is.
    expect(table.snapshot('p0' as never).options.length).toBeGreaterThan(0);
    expect(table.snapshot('p1' as never).options).toEqual([]);
    expect(table.snapshot(null).options).toEqual([]);
  });

  it('advances on a legal move and explains an illegal one', () => {
    const table = new LocalTable({ seed: 11, players: 4 });
    let changes = 0;
    table.onChange(() => {
      changes += 1;
    });

    table.act('p0' as never, { type: 'endTurn' });
    expect(table.notice).toContain('opening');
    expect(table.snapshot(null).at).toBe(0);
    expect(changes).toBe(1);

    const action = table.snapshot('p0' as never).options.flatMap((spec) => spec.options)[0];
    if (action === undefined) throw new Error('nothing offered');
    table.act('p0' as never, action);

    expect(table.notice).toBeNull();
    expect(table.snapshot(null).at).toBe(1);
    expect(table.snapshot(null).events.some((event) => event.type === 'build')).toBe(true);
  });

  it('is always ready, because there is nothing to be waiting for', () => {
    const table = new LocalTable({ seed: 11, players: 3 });
    expect(table.ready).toBe(true);
    expect(table.label).toBe('Hot seat · seed 11');
  });
});

describe('contextFor', () => {
  it('rebuilds the board graph from a view that never carried one', () => {
    const table = new LocalTable({ seed: 11, players: 4 });
    const view = table.snapshot(null).view;

    // This is what a networked client does with the first message it receives: the server sends
    // ids and mutable state, and the topology — which is neither — is derived.
    const ctx = contextFor(view);
    expect(ctx.scenario.id).toBe(view.scenarioId);
    expect(ctx.topology.hexes).toEqual(table.ctx.topology.hexes);
    expect(ctx.topology.vertices).toEqual(table.ctx.topology.vertices);
    expect(ctx.rules.id).toBe(view.ruleSetId);
  });

  it('refuses a game it does not have the code for', () => {
    const view = new LocalTable({ seed: 11, players: 4 }).snapshot(null).view;
    expect(() => contextFor({ ...view, scenarioId: 'seafarers/heads-of-the-rivers' })).toThrow(
      /does not know the scenario/,
    );
    expect(() => contextFor({ ...view, ruleSetId: 'catan/cities-and-knights' })).toThrow(
      /does not know the ruleset/,
    );
  });
});
