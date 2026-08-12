/**
 * `@catan/core` — the rules engine.
 *
 * The five entry points from the README, and the types they speak in:
 *
 * ```ts
 * const { ctx, state } = newGame({ scenario: baseScenario34(), rules: baseRules(), seed, players: 4 });
 *
 * reduce(ctx, state, actor, action)   // Result<Tick, RuleViolation> — the authority
 * isLegal(ctx, state, actor, action)  // a dry run of the same thing
 * legalActions(ctx, state, actor)     // descriptors for UIs and bots, never trusted
 * redactFor(state, viewer)            // what one player may see
 * redactEvents(events, viewer)        // ditto, for what just happened
 * ```
 *
 * Exports are deliberately flat and named: this package is consumed by a server, a browser client
 * and a bot, and a deep import path would make refactoring core a breaking change for all three.
 */

export * from './board/generate.js';
export * from './board/presets.js';
export * from './board/scenario.js';
export * from './board/topology.js';

// ── Board ───────────────────────────────────────────────────────────────────────────────────
export * from './coords/axial.js';
export * from './coords/edge.js';
export * from './coords/layout.js';
export * from './coords/vertex.js';
export * from './engine/autoplay.js';
// ── Engine ──────────────────────────────────────────────────────────────────────────────────
export * from './engine/newGame.js';
export * from './engine/reduce.js';
export * from './engine/view.js';
export * from './ext.js';
// ── Identity and primitives ─────────────────────────────────────────────────────────────────
export * from './ids.js';
export * from './result.js';
export * from './rng.js';
// ── Rules ───────────────────────────────────────────────────────────────────────────────────
export * from './rules/action.js';
export * from './rules/award.js';
export * from './rules/event.js';
export * from './rules/placement.js';
export * from './rules/production.js';
export * from './rules/route.js';
export * from './rules/ruleset.js';
export * from './rules/trade.js';
export * from './rules/violation.js';
// ── Rulesets ────────────────────────────────────────────────────────────────────────────────
export {
  ACTION,
  BASE_CARD_DEFS,
  BASE_CARD_KINDS,
  BASE_PIECE_KINDS,
  BASE_RULESET_ID,
  BASE_TERRAIN_YIELD,
  baseRules,
  CITY_COST,
  DEV_CARD_COST,
  DEV_DECK,
  HAND_LIMIT,
  ROAD_COST,
  SETTLEMENT_COST,
  STEP,
} from './rulesets/base/index.js';
// ── State ───────────────────────────────────────────────────────────────────────────────────
export * from './state/gameState.js';
export * from './state/invariants.js';
export * from './state/tx.js';
