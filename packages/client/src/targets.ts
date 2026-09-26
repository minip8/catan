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
 * The group whose spots show before anyone asks: the only thing on offer, when it is a placement.
 *
 * The opening and the robber offer nothing *but* a spot, so making the player ask to see them
 * would be a click that decides nothing. Anywhere else — a turn with roads, settlements and a roll
 * all on offer — spots are noise until the player says which kind they want.
 */
export function defaultGroup(affordances: Affordances): string | null {
  const [only, ...rest] = affordances.groups;
  return only !== undefined && rest.length === 0 && only.placements.length > 0 ? only.key : null;
}

/** The targets the board should show: the selected group's, the default group's, or none. */
export function visibleTargets(affordances: Affordances, group: string | null): readonly Target[] {
  const shown = group ?? defaultGroup(affordances);
  if (shown === null) return [];
  return affordances.targets
    .map((target) => ({ ...target, options: target.options.filter((o) => o.group === shown) }))
    .filter((target) => target.options.length > 0);
}
