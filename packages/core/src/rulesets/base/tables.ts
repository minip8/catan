/**
 * The base game, as data.
 *
 * This file is the **only** place in the engine that enumerates the five resources, names the
 * terrain that produces them, or knows what a city costs. Everything else reads these tables
 * through `RuleSet`. That is not architectural decoration: it is what lets Cities & Knights add
 * commodities that count toward the hand limit but cannot be stolen, without a single `if` in the
 * discard code.
 *
 * Numbers are from the rulebook and the almanac:
 *
 * | | |
 * |---|---|
 * | Road | 1 brick, 1 lumber — 15 per player |
 * | Settlement | 1 brick, 1 lumber, 1 wool, 1 grain — 5 per player, 1 VP |
 * | City | 3 ore, 2 grain — 4 per player, 2 VP, replaces a settlement |
 * | Development card | 1 ore, 1 wool, 1 grain — 25 in the deck |
 * | Hand limit | 7; on a 7 you discard half, rounded down |
 * | Longest Road | 5 segments, worth 2 VP |
 * | Largest Army | 3 knights, worth 2 VP |
 */

import { BASE_RESOURCES, type CardKind, type PieceKind, type TerrainId } from '../../ids.js';
import type { CardKindMeta, DeckSpec, PieceKindMeta } from '../../rules/ruleset.js';
import type { Cost } from '../../state/gameState.js';

export const BASE_RULESET_ID = 'catan/base';

/** The one development deck. Cities & Knights replaces it with three. */
export const DEV_DECK = 'dev';

// ── Card kinds ──────────────────────────────────────────────────────────────────────────────

/**
 * The five resources behave identically in the base game, so the table is one shape repeated.
 * The flags exist because expansions break that symmetry, not because the base game needs them.
 */
export const BASE_CARD_KINDS: Readonly<Record<CardKind, CardKindMeta>> = Object.fromEntries(
  BASE_RESOURCES.map((id) => [
    id,
    {
      id,
      countsTowardHandLimit: true,
      stealable: true,
      monopolisable: true,
      tradeable: true,
      maritime: true,
      banked: true,
    } satisfies CardKindMeta,
  ]),
) as Readonly<Record<CardKind, CardKindMeta>>;

/** What each terrain pays out. The desert pays nothing, which is why it takes no number token. */
export const BASE_TERRAIN_YIELD: Readonly<Record<TerrainId, CardKind | null>> = {
  hills: 'brick',
  forest: 'lumber',
  mountains: 'ore',
  fields: 'grain',
  pasture: 'wool',
  desert: null,
};

// ── Costs ───────────────────────────────────────────────────────────────────────────────────

export const ROAD_COST: Cost = { brick: 1, lumber: 1 };
export const SETTLEMENT_COST: Cost = { brick: 1, lumber: 1, wool: 1, grain: 1 };
export const CITY_COST: Cost = { ore: 3, grain: 2 };
export const DEV_CARD_COST: Cost = { ore: 1, wool: 1, grain: 1 };

// ── Piece kinds ─────────────────────────────────────────────────────────────────────────────

export const BASE_PIECE_KINDS: Readonly<Record<PieceKind, PieceKindMeta>> = {
  road: {
    id: 'road',
    locus: 'edge',
    limit: 15,
    cost: ROAD_COST,
    victoryPoints: 0,
    production: 0,
    exclusive: true,
    routeSegment: true,
    blocksRoute: false,
    blocksProduction: false,
    // A road may run along a coast, but not between two sea hexes. That is the whole of the
    // land/sea rule for the base game — Seafarers' ship is the same entry with `'water'`.
    needsAdjacent: 'land',
    connection: 'network',
    owned: true,
  },
  settlement: {
    id: 'settlement',
    locus: 'vertex',
    limit: 5,
    cost: SETTLEMENT_COST,
    victoryPoints: 1,
    production: 1,
    exclusive: true,
    routeSegment: false,
    blocksRoute: true,
    blocksProduction: false,
    needsAdjacent: 'land',
    connection: 'route',
    owned: true,
  },
  city: {
    id: 'city',
    locus: 'vertex',
    limit: 4,
    cost: CITY_COST,
    victoryPoints: 2,
    production: 2,
    exclusive: true,
    routeSegment: false,
    blocksRoute: true,
    blocksProduction: false,
    needsAdjacent: 'land',
    // A city replaces a settlement that is already connected, so it needs nothing of its own.
    connection: 'none',
    upgradesFrom: 'settlement',
    owned: true,
  },
  /**
   * The robber is a piece like any other — unowned, on a hex, blocking production. Modelling it
   * this way rather than as a `robberHex` field is what lets the pirate, the merchant and Cities &
   * Knights' knights join later without reshaping `Board`.
   */
  robber: {
    id: 'robber',
    locus: 'hex',
    limit: null,
    victoryPoints: 0,
    production: 0,
    exclusive: false,
    routeSegment: false,
    blocksRoute: false,
    blocksProduction: true,
    needsAdjacent: 'land',
    connection: 'none',
    owned: false,
  },
};

// ── The development deck ────────────────────────────────────────────────────────────────────

/**
 * 25 cards: 14 knights, 5 victory points, and 2 each of the three progress cards.
 *
 * The five victory-point cards are distinct definitions rather than five copies of one, because
 * they have distinct printed names — and because a UI that reveals "Library" at the moment of
 * victory reads better than one that reveals "victory point ×5".
 */
export const DEV_DECK_COMPOSITION: Readonly<Record<string, number>> = {
  knight: 14,
  roadBuilding: 2,
  yearOfPlenty: 2,
  monopoly: 2,
  chapel: 1,
  library: 1,
  market: 1,
  greatHall: 1,
  university: 1,
};

export const BASE_DECKS: Readonly<Record<string, DeckSpec>> = {
  [DEV_DECK]: {
    id: DEV_DECK,
    cost: DEV_CARD_COST,
    composition: DEV_DECK_COMPOSITION,
    // The base deck is not recycled: when it runs out, no more cards can be bought. The almanac
    // is explicit that the deck is not reshuffled.
    recycle: false,
  },
};

// ── Thresholds ──────────────────────────────────────────────────────────────────────────────

export const HAND_LIMIT = 7;
export const DISCARD_FRACTION = 0.5;
export const ROBBER_ROLL = 7;
export const LONGEST_ROAD_THRESHOLD = 5;
export const LARGEST_ARMY_THRESHOLD = 3;
export const AWARD_VALUE = 2;
export const DICE = { count: 2, sides: 6 } as const;
