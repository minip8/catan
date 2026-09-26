/**
 * The client's central claim, under test: everything clickable came from the engine.
 *
 * These tests deliberately use real specs from a real game rather than hand-built ones, because
 * the mapping they check is structural — "a field whose value is a place becomes a spot on the
 * board" — and a hand-built spec could accidentally be built to match.
 */

import { type Action, type ActionSpec, spec } from '@catan/core';
import { describe, expect, it } from 'vitest';

import { advance, fixture, P } from './fixture.testkit.js';
import { affordances, locusOf, visibleTargets } from './targets.js';

const [p0, p1] = P as [(typeof P)[0], (typeof P)[1]];

describe('locusOf', () => {
  it('finds the place an action names', () => {
    const f = fixture();
    const place = f.session.options(p0)[0]?.options[0] as Action;
    expect(locusOf(f.ctx, place)).toEqual({ locus: place.at, kind: 'vertex' });
  });

  it('is not fooled by a field that merely looks like an id', () => {
    const f = fixture();
    const hex = f.ctx.topology.hexes[0];
    // `victim` is a player, `kind` is a piece kind, and neither is a place on this board.
    const action = { type: 'moveRobber', hex, victim: p1, kind: 'road' };
    expect(locusOf(f.ctx, action)).toEqual({ locus: hex, kind: 'hex' });
    expect(locusOf(f.ctx, { type: 'endTurn' })).toBeNull();
    expect(locusOf(f.ctx, { type: 'playDev', card: 'c3', kind: 'ore' })).toBeNull();
  });
});

describe('affordances', () => {
  it('puts opening placements on the board and nothing in the action bar', () => {
    const f = fixture();
    const { groups, targets } = affordances(f.ctx, f.session.options(p0));

    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (group === undefined) throw new Error('no group');
    expect(group.note).toContain('settlement');
    expect(group.choices).toHaveLength(0);
    expect(group.placements.length).toBeGreaterThan(20);
    expect(targets.every((t) => t.kind === 'vertex')).toBe(true);
    expect(targets).toHaveLength(group.placements.length);
  });

  it('separates the roll from the places to build once a turn is under way', () => {
    // Eight opening placements per player pair, then the first roll.
    const f = advance(fixture(), 16);
    const roller = f.state.turn.active;
    const { groups, targets } = affordances(f.ctx, f.session.options(roller));

    expect(groups.map((g) => g.type)).toContain('roll');
    const roll = groups.find((g) => g.type === 'roll');
    expect(roll?.choices).toHaveLength(1);
    expect(roll?.placements).toHaveLength(0);
    expect(targets).toHaveLength(0);
  });

  it('gathers several actions offered at one spot', () => {
    const f = fixture();
    const hex = f.ctx.topology.hexes.find((h) => f.state.board.hexes[h]?.class === 'land');
    const specs: readonly ActionSpec[] = [
      spec('moveRobber', [
        { type: 'moveRobber', hex, victim: null },
        { type: 'moveRobber', hex, victim: p0 },
        { type: 'moveRobber', hex, victim: p1 },
      ]),
    ];

    const { targets } = affordances(f.ctx, specs);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.options).toHaveLength(3);
    expect(targets[0]?.kind).toBe('hex');
  });

  it('keeps two specs of the same type apart', () => {
    const f = fixture();
    const specs = [
      spec('build', [], { note: 'build a road' }),
      spec('build', [], { note: 'build a settlement' }),
      spec('build', [], { note: 'build a road' }),
    ];
    const keys = affordances(f.ctx, specs).groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(3);
  });

  it('marks a space the engine could not enumerate', () => {
    const f = fixture();
    const specs = [spec('offerTrade', [], { enumerated: false, note: 'offer a trade' })];
    const group = affordances(f.ctx, specs).groups[0];
    expect(group?.enumerated).toBe(false);
    expect(group?.choices).toHaveLength(0);
  });
});

describe('visibleTargets', () => {
  it('shows one group at a time when a group is selected', () => {
    const f = fixture();
    const hexes = f.ctx.topology.hexes.slice(0, 2);
    const specs = [
      spec(
        'a',
        hexes.map((hex) => ({ type: 'a', hex })),
      ),
      spec(
        'b',
        hexes.map((hex) => ({ type: 'b', hex })),
      ),
    ];
    const affs = affordances(f.ctx, specs);
    const first = affs.groups[0]?.key ?? null;

    // Two kinds on offer: nothing shows until the player picks one.
    expect(visibleTargets(affs, null)).toEqual([]);

    const filtered = visibleTargets(affs, first);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((t) => t.options.length === 1)).toBe(true);
    expect(filtered.every((t) => t.options[0]?.action.type === 'a')).toBe(true);
  });

  it('does not offer a purchase unasked', () => {
    const f = fixture();
    const hexes = f.ctx.topology.hexes.slice(0, 2);
    const affs = affordances(f.ctx, [
      spec(
        'build',
        hexes.map((hex) => ({ type: 'build', hex })),
      ),
    ]);
    expect(visibleTargets(affs, null)).toEqual([]);
  });

  it('shows the spots unasked when a placement is all that is on offer', () => {
    const f = fixture();
    const hexes = f.ctx.topology.hexes.slice(0, 2);
    const affs = affordances(f.ctx, [
      spec(
        'a',
        hexes.map((hex) => ({ type: 'a', hex })),
      ),
    ]);
    expect(visibleTargets(affs, null)).toHaveLength(2);
  });
});
