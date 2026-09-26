/**
 * What each seat hears. The synthesis is not tested — jsdom has no Web Audio, and `Sounds` must
 * quietly do nothing there — but the choice of cue is, because it is per viewer.
 */

import { event, redactEvent, secretEvent } from '@catan/core';
import { describe, expect, it } from 'vitest';

import { P } from './fixture.testkit.js';
import { cueFor, cuesFor, Sounds } from './sound.js';

const [p0, p1, p2] = P as [(typeof P)[0], (typeof P)[1], (typeof P)[2]];

describe('cueFor', () => {
  it('chimes a roll only for the players it paid', () => {
    const production = event('production', { roll: 8, grants: { [p0]: { ore: 1 } } });
    expect(cuesFor([event('dice', { player: p1 }), production], p0)).toEqual(['dice', 'collect']);
    expect(cuesFor([event('dice', { player: p1 }), production], p1)).toEqual(['dice']);
    expect(cueFor(production, null)).toBe('collect');
  });

  it('gives each piece its own sound', () => {
    expect(cueFor(event('build', { player: p0, kind: 'road' }), p1)).toBe('road');
    expect(cueFor(event('build', { player: p0, kind: 'settlement' }), p1)).toBe('settlement');
    expect(cueFor(event('build', { player: p0, kind: 'city' }), p1)).toBe('city');
  });

  it('sounds a steal differently to the victim, even when the loot is hidden', () => {
    const steal = secretEvent('steal', { from: p0, to: p1 }, { kind: 'ore' }, [p0, p1]);
    expect(cueFor(redactEvent(steal, p0), p0)).toBe('stolen');
    expect(cueFor(redactEvent(steal, p1), p1)).toBe('steal');
    expect(cueFor(redactEvent(steal, p2), p2)).toBe('steal');
  });

  it('announces a turn only to the player whose turn it is', () => {
    const turn = [event('endTurn', { player: p0 }), event('turn', { player: p1, n: 2 })];
    expect(cuesFor(turn, p1)).toEqual(['tick', 'yourTurn']);
    expect(cuesFor(turn, p2)).toEqual(['tick']);
    expect(cuesFor(turn, null)).toEqual(['tick']);
  });

  it('plays the winner a fanfare and everyone else a sigh', () => {
    const won = event('victory', { player: p0, points: 10 });
    expect(cueFor(won, p0)).toBe('victory');
    expect(cueFor(won, p1)).toBe('defeat');
  });

  it('stays silent for what it does not know, and does not stutter', () => {
    expect(cueFor(event('somethingNew', {}), p0)).toBeNull();
    const builds = Array.from({ length: 3 }, () => event('build', { player: p0, kind: 'road' }));
    expect(cuesFor(builds, p0)).toEqual(['road']);
  });
});

describe('Sounds', () => {
  it('is a no-op without Web Audio', () => {
    const sounds = new Sounds();
    expect(() => sounds.playAll(['dice', 'victory'])).not.toThrow();
  });
});
