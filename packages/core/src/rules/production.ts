/**
 * Resource production.
 *
 * Computed as a *plan* first and applied second. The reason is the bank-shortage rule, which
 * cannot be evaluated one player at a time:
 *
 * > If there are not enough cards of one kind in the bank to pay everyone entitled to them,
 * > **nobody** receives that kind — unless exactly one player is owed it, in which case they
 * > receive as many as remain.
 *
 * Paying players out in seat order would instead let the first player empty the bank, which is
 * the classic bug in this rule. So `planProduction` totals demand per kind across all players
 * before anything moves.
 *
 * The mechanism is metadata-driven throughout: what a terrain yields comes from
 * `RuleSet.terrainYield`, how much a building collects from `PieceKindMeta.production`, and which
 * pieces suppress a hex from `PieceKindMeta.blocksProduction`. The robber is not special-cased
 * anywhere in this file.
 */

import type { CardKind, HexId, PlayerId } from '../ids.js';
import type { Cost, GameState } from '../state/gameState.js';
import { isProducing, piecesOn } from '../state/gameState.js';
import { pieceKind, type RuleContext } from './ruleset.js';

/**
 * A mutable card tally.
 *
 * `Partial` rather than `Record<CardKind, number>` because a tally is built up kind by kind, and
 * `Cost` — its readonly counterpart — is what it becomes once it is handed to `Tx.transfer`.
 */
type Tally = Partial<Record<CardKind, number>>;

export interface ProductionPlan {
  /** What each player actually receives, after the shortage rule. */
  readonly grants: Readonly<Record<PlayerId, Cost>>;
  /** What each player was entitled to, before the shortage rule. */
  readonly claims: Readonly<Record<PlayerId, Cost>>;
  /** Kinds the bank could not cover, and which were therefore withheld or truncated. */
  readonly shorted: readonly CardKind[];
}

/** Whether a hex is suppressed by a piece standing on it — the robber, later the pirate. */
export function isBlockedHex(ctx: RuleContext, state: GameState, hex: HexId): boolean {
  return piecesOn(state.board, hex).some(
    (p) => pieceKind(ctx.rules, p.kind)?.blocksProduction === true,
  );
}

/** The hexes that pay out on `roll`: producing, carrying that number, and not blocked. */
export function producingHexes(ctx: RuleContext, state: GameState, roll: number): readonly HexId[] {
  return ctx.topology.hexes.filter(
    (h) =>
      isProducing(state.board, h) &&
      (state.board.hexes[h]?.numbers ?? []).includes(roll) &&
      !isBlockedHex(ctx, state, h),
  );
}

/**
 * Work out who gets what for a roll, applying the bank-shortage rule.
 *
 * Pure: it reads state and returns a plan, so it can also answer "what would a 6 pay me?" for a
 * UI without touching the game.
 */
export function planProduction(ctx: RuleContext, state: GameState, roll: number): ProductionPlan {
  const claims: Record<PlayerId, Tally> = {};
  const demand = new Map<CardKind, { total: number; players: Set<PlayerId> }>();

  for (const hex of producingHexes(ctx, state, roll)) {
    const terrain = state.board.hexes[hex]?.terrain;
    const kind = terrain === null || terrain === undefined ? null : ctx.rules.terrainYield[terrain];
    if (kind === null || kind === undefined) continue;

    for (const vertex of ctx.topology.hexVertices.get(hex) ?? []) {
      for (const piece of piecesOn(state.board, vertex)) {
        const n = pieceKind(ctx.rules, piece.kind)?.production ?? 0;
        if (n <= 0 || piece.owner === null) continue;
        const forPlayer = claims[piece.owner] ?? {};
        forPlayer[kind] = (forPlayer[kind] ?? 0) + n;
        claims[piece.owner] = forPlayer;
        const d = demand.get(kind) ?? { total: 0, players: new Set<PlayerId>() };
        d.total += n;
        d.players.add(piece.owner);
        demand.set(kind, d);
      }
    }
  }

  const grants: Record<PlayerId, Tally> = {};
  const shorted: CardKind[] = [];

  for (const [kind, { total, players }] of demand) {
    const available = state.bank[kind] ?? 0;
    if (total <= available) {
      for (const p of players) grants[p] = { ...grants[p], [kind]: claims[p]?.[kind] ?? 0 };
      continue;
    }
    shorted.push(kind);
    // Exactly one claimant: they take what is left. Several: nobody gets any of this kind.
    if (players.size === 1) {
      const [only] = [...players];
      if (only !== undefined && available > 0) {
        grants[only] = { ...grants[only], [kind]: available };
      }
    }
  }

  return { grants, claims, shorted };
}
