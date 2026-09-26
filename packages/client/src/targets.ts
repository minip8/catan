/**
 * Turning what the engine offers into what the player can click.
 *
 * This module is the reason the client contains no rules. It never asks "is it my turn", "can I
 * afford this" or "is that spot too close to a settlement" — it takes `legalActions`, sorts the
 * offered actions into *places on the board* and *choices in a menu*, and sends back one of the
 * very objects it was given. Anything the engine did not offer is unclickable, which means a UI
 * bug can produce a missing option but never an illegal one.
 *
 * Two mechanisms do the sorting, and both are deliberately ruleset-agnostic:
 *
 * - **A board target is any action with a field naming a locus.** Not "an action of type `build`
 *   has an `at`" — the client asks the topology whether the string is a vertex, an edge or a hex.
 *   `moveRobber`'s `hex`, `build`'s `at` and a future ship's `path` all land here for free, and a
 *   field like `victim: 'p2'` does not, because `p2` is not a place.
 * - **A group is one `ActionSpec`.** The engine already groups its offers the way a player thinks
 *   about them — one spec per piece kind, each with a `note` like "build a settlement" — so the
 *   client reuses that grouping instead of inventing categories the ruleset would outgrow.
 */

import {
  type Action,
  type ActionSpec,
  type LocusId,
  type LocusKind,
  locusKindOf,
  type RuleContext,
} from '@catan/core';

/** Where an action wants to happen, if anywhere. */
export interface Located {
  readonly locus: LocusId;
  readonly kind: LocusKind;
}

/** One action, offered at one place on the board. */
export interface Placement extends Located {
  /** The `Group.key` it came from, so the board can show one kind of placement at a time. */
  readonly group: string;
  readonly action: Action;
}

/** Everything on offer at one locus. More than one when the same spot allows a choice. */
export interface Target extends Located {
  readonly options: readonly Placement[];
  /** Lit only under the pointer: a spot to price, not a spot the player has asked to see. */
  readonly quiet?: boolean;
}

/** One `ActionSpec`, split into what goes on the board and what goes in the action bar. */
export interface Group {
  /** Stable across renders of different states, so a selected group survives an action. */
  readonly key: string;
  readonly type: string;
  readonly note: string;
  /** False when the engine could not enumerate the space — the client must compose the action. */
  readonly enumerated: boolean;
  /** Offered actions that name no place: roll, end turn, accept an offer. */
  readonly choices: readonly Action[];
  /** Offered actions that name a place. The board shows these; the bar only counts them. */
  readonly placements: readonly Placement[];
}

export interface Affordances {
  readonly groups: readonly Group[];
  readonly targets: readonly Target[];
}

/**
 * The place an action names, or `null`.
 *
 * Checked against the topology rather than by field name. An action naming two loci would be
 * reported as its first — no base-game action does, and a ruleset that adds one wants a UI
 * gesture of its own anyway.
 */
export function locusOf(ctx: RuleContext, action: Action): Located | null {
  for (const [field, value] of Object.entries(action)) {
    if (field === 'type' || typeof value !== 'string') continue;
    const locus = value as LocusId;
    // The engine's own answer to "which member of `LocusId` is this string", so the client cannot
    // develop a second opinion about what counts as a vertex.
    const kind = locusKindOf(ctx, locus);
    if (kind !== undefined) return { locus, kind };
  }
  return null;
}

export function affordances(ctx: RuleContext, specs: readonly ActionSpec[]): Affordances {
  const groups: Group[] = [];
  const byLocus = new Map<LocusId, Placement[]>();
  const used = new Set<string>();

  for (const spec of specs) {
    const note = spec.note ?? spec.type;
    let key = `${spec.type}|${note}`;
    // Two specs of the same type with the same note would be indistinguishable to the UI; keep
    // the key unique so selecting one cannot silently select the other.
    while (used.has(key)) key += '+';
    used.add(key);

    const choices: Action[] = [];
    const placements: Placement[] = [];
    for (const action of spec.options) {
      const at = locusOf(ctx, action);
      if (at === null) {
        choices.push(action);
        continue;
      }
      const placement: Placement = { ...at, group: key, action };
      placements.push(placement);
      const existing = byLocus.get(at.locus);
      if (existing === undefined) byLocus.set(at.locus, [placement]);
      else existing.push(placement);
    }

    groups.push({ key, type: spec.type, note, enumerated: spec.enumerated, choices, placements });
  }

  const targets: Target[] = [...byLocus.entries()].map(([locus, options]) => ({
    locus,
    kind: options[0]?.kind ?? 'offboard',
    options,
  }));
  return { groups, targets };
}

/**
 * The group whose spots are live before anyone asks: the one placement on offer, when it is
 * something the step requires rather than something the player chose to buy.
 *
 * The opening, the robber and a Road Building placement offer nothing *but* a spot (bar, for the
 * last, a way to forfeit it), so making the player ask to see them would be a click that decides
 * nothing. A turn that offers a road *purchase* is different: a stray click on the board must not
 * spend the player's cards, so builds wait until the player picks one.
 */
export function defaultGroup(affordances: Affordances): string | null {
  const placing = affordances.groups.filter((g) => g.placements.length > 0);
  const [only, ...rest] = placing;
  return only !== undefined && rest.length === 0 && only.type !== 'build' ? only.key : null;
}

/** The targets the board should show: the selected group's, the default group's, or none. */
export function visibleTargets(affordances: Affordances, group: string | null): readonly Target[] {
  const shown = group ?? defaultGroup(affordances);
  if (shown === null) return [];
  return affordances.targets
    .map((target) => ({ ...target, options: target.options.filter((o) => o.group === shown) }))
    .filter((target) => target.options.length > 0);
}

// ── Purchases ───────────────────────────────────────────────────────────────────────────────

/** Something that could be bought at a spot, and whether the engine would take it right now. */
export interface Purchase {
  readonly action: Action;
  /** The engine is offering it: the player can pay. Otherwise it is only a prospect. */
  readonly affordable: boolean;
}

/** A spot on the board with the purchases it allows. */
export interface PurchaseSpot extends Located {
  readonly purchases: readonly Purchase[];
}

/**
 * Where the player could buy something, paid for or not.
 *
 * `prospects` is the engine's answer to "what could go where, cost aside"; the offered actions
 * say which of those the player can pay for. So this still decides nothing — it only lines two
 * engine answers up — and the unaffordable ones, if sent, are refused by the engine as usual.
 */
export function purchaseSpots(
  ctx: RuleContext,
  prospects: readonly ActionSpec[],
  affordances: Affordances,
): readonly PurchaseSpot[] {
  const offered = new Set(
    affordances.groups.flatMap((g) => g.placements.map((p) => actionKey(p.action))),
  );
  const byLocus = new Map<LocusId, { kind: LocusKind; purchases: Purchase[] }>();
  for (const spec of prospects) {
    for (const action of spec.options) {
      const at = locusOf(ctx, action);
      if (at === null) continue;
      const purchase = { action, affordable: offered.has(actionKey(action)) };
      const existing = byLocus.get(at.locus);
      if (existing === undefined) byLocus.set(at.locus, { kind: at.kind, purchases: [purchase] });
      else existing.purchases.push(purchase);
    }
  }
  return [...byLocus.entries()].map(([locus, { kind, purchases }]) => ({ locus, kind, purchases }));
}

/** Purchase spots as quiet board targets: there to be found, lit only under the pointer. */
export function spotTargets(spots: readonly PurchaseSpot[]): readonly Target[] {
  return spots.map((spot) => ({
    locus: spot.locus,
    kind: spot.kind,
    quiet: true,
    options: spot.purchases.map((p) => ({
      locus: spot.locus,
      kind: spot.kind,
      group: 'purchase',
      action: p.action,
    })),
  }));
}

/** The same action, however it was reached. Actions are flat records, so key order is enough. */
function actionKey(action: Action): string {
  return JSON.stringify(Object.entries(action).sort(([a], [b]) => a.localeCompare(b)));
}
