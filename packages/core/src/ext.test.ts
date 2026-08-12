import { describe, expect, it } from 'vitest';

import type { GameExtensions, PlayerExtensions } from './ext.js';

/**
 * A compile-time guard, and the reason this file exists.
 *
 * This augmentation only compiles if `PlayerExtensions` and `GameExtensions` are **interfaces**.
 * Declaration merging does not work on type aliases, so if either is ever converted to
 * `type X = {}` — which a lint autofix will happily do to an empty interface — this file stops
 * typechecking and every expansion loses its attachment point.
 */
declare module './ext.js' {
  interface PlayerExtensions {
    testExpansion?: { readonly knights: number };
  }
  interface GameExtensions {
    testExpansion?: { readonly barbarianPos: number };
  }
}

describe('expansion attachment points', () => {
  it('accepts state contributed by an expansion', () => {
    const playerExt: Partial<PlayerExtensions> = { testExpansion: { knights: 3 } };
    const gameExt: Partial<GameExtensions> = { testExpansion: { barbarianPos: 2 } };

    expect(playerExt.testExpansion?.knights).toBe(3);
    expect(gameExt.testExpansion?.barbarianPos).toBe(2);
  });

  /** Core contributes nothing, so a base game's ext bags are simply empty. */
  it('is empty for the base game', () => {
    const playerExt: Partial<PlayerExtensions> = {};
    const gameExt: Partial<GameExtensions> = {};
    expect(Object.keys(playerExt)).toEqual([]);
    expect(Object.keys(gameExt)).toEqual([]);
  });
});
