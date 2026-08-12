/**
 * The opening placement.
 *
 * One step per player per round, rather than one step per piece. The step carries its own progress
 * (`placed`) and the intersection the round's settlement went on (`anchor`), which is what makes
 * "your opening road must touch the settlement you just placed" a local check rather than a search
 * through the board for which of your settlements is roadless.
 *
 * The rounds themselves come from `Scenario.setup`, so the base game's
 * settlement-road-then-reverse is data. Cities & Knights places a city in round two and some
 * Seafarers scenarios add a third round; both are new rows, not new code.
 *
 * Starting resources are granted **when the settlement is placed**, not after the road. The
 * rulebook grants them for the second settlement, and nothing between the two placements can
 * change what that settlement produces, so the earlier moment is equivalent and simpler.
 */

import type { CardKind, LocusId, PlayerId, VertexId } from '../../../ids.js';
import { OK_VOID, type Result } from '../../../result.js';
import { spec, str } from '../../../rules/action.js';
import { event } from '../../../rules/event.js';
import { edgeEndsOf, placementOptions } from '../../../rules/placement.js';
import { pieceKind, type RuleContext, type StepHandler } from '../../../rules/ruleset.js';
import { type RuleViolation, violation } from '../../../rules/violation.js';
import type { GameState, Step } from '../../../state/gameState.js';
import { isProducing, piecesOn } from '../../../state/gameState.js';
import { BANK, type Tx } from '../../../state/tx.js';
import { ACTION, buildPiece, stepBool, stepList, stepStr } from '../common.js';

/** The piece this step is waiting for, or `undefined` once the round is complete. */
function pendingKind(step: Step): string | undefined {
  const place = stepList<string>(step, 'place');
  return place[stepList<string>(step, 'placed').length];
}

/**
 * Where the pending piece may go.
 *
 * Opening placements connect to nothing (`'none'`) — that is the entire difference between setup
 * and ordinary building — except that once the round's settlement is down, the road must touch it.
 */
function options(
  ctx: RuleContext,
  state: GameState,
  actor: PlayerId,
  kind: string,
  anchor: VertexId | undefined,
): readonly LocusId[] {
  const all = placementOptions(ctx, state, actor, kind, 'none');
  if (anchor === undefined) return all;
  const meta = pieceKind(ctx.rules, kind);
  if (meta?.locus !== 'edge') return all;
  return all.filter((e) => edgeEndsOf(ctx, e).includes(anchor));
}

/**
 * Pay a player for the settlement they just placed.
 *
 * Reads the piece's own `production`, so a ruleset whose opening round places a city (Cities &
 * Knights) pays out two cards per hex without this function knowing what a city is.
 */
function grantOpeningProduction(ctx: RuleContext, tx: Tx, actor: PlayerId, vertex: VertexId): void {
  const granted: Partial<Record<CardKind, number>> = {};
  const rate = piecesOn(tx.state.board, vertex)
    .filter((p) => p.owner === actor)
    .reduce((best, p) => Math.max(best, pieceKind(ctx.rules, p.kind)?.production ?? 0), 0);

  for (const hex of ctx.topology.vertexHexes.get(vertex) ?? []) {
    if (!isProducing(tx.state.board, hex)) continue;
    const terrain = tx.state.board.hexes[hex]?.terrain;
    const kind = terrain == null ? null : ctx.rules.terrainYield[terrain];
    if (kind == null) continue;
    const available = Math.min(rate, tx.state.bank[kind] ?? 0);
    if (available > 0) granted[kind] = (granted[kind] ?? 0) + available;
  }

  if (Object.keys(granted).length === 0) return;
  tx.transfer(BANK, actor, granted);
  tx.emit(event('production', { player: actor, cards: granted, reason: 'setup', at: vertex }));
}

export const setupHandler: StepHandler = {
  actions(ctx, state, step, actor) {
    const kind = pendingKind(step);
    if (kind === undefined) return [];
    const anchor = stepStr<VertexId>(step, 'anchor');
    return [
      spec(
        ACTION.place,
        options(ctx, state, actor, kind, anchor).map((at) => ({ type: ACTION.place, kind, at })),
        { note: `place your opening ${kind}` },
      ),
    ];
  },

  apply(ctx, tx, step, actor, action): Result<void, RuleViolation> {
    if (action.type !== ACTION.place) {
      return violation('wrongStep', 'you must place your opening pieces first', {
        expected: ACTION.place,
      });
    }

    const expected = pendingKind(step);
    if (expected === undefined) {
      throw new Error('setup: the step has nothing left to place but is still on the stack');
    }

    const kind = str(action, 'kind');
    if (!kind.ok) return kind;
    const at = str<LocusId>(action, 'at');
    if (!at.ok) return at;

    if (kind.value !== expected) {
      return violation('wrongStep', `you must place a ${expected} now`, { expected });
    }
    const meta = pieceKind(ctx.rules, kind.value);
    if (meta === undefined) {
      return violation('illegalTarget', `${kind.value} is not a piece in this ruleset`);
    }

    const anchor = stepStr<VertexId>(step, 'anchor');
    if (
      meta.locus === 'edge' &&
      anchor !== undefined &&
      !edgeEndsOf(ctx, at.value).includes(anchor)
    ) {
      return violation('notConnected', 'your opening road must touch the settlement you placed', {
        anchor,
      });
    }

    const built = buildPiece(ctx, tx, actor, kind.value, at.value, {
      free: true,
      connection: 'none',
    });
    if (!built.ok) return built;

    const placed = [...stepList<string>(step, 'placed'), kind.value];
    const isAnchor = meta.locus === 'vertex' && anchor === undefined;
    if (isAnchor && stepBool(step, 'grant')) {
      grantOpeningProduction(ctx, tx, actor, at.value as VertexId);
    }

    if (placed.length >= stepList<string>(step, 'place').length) tx.pop();
    else tx.amendTop({ placed, anchor: isAnchor ? at.value : anchor });
    return OK_VOID;
  },
};
