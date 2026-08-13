/**
 * English for what the engine says.
 *
 * Two directions, both pure and both tested: `narrate` turns a `GameEvent` into a line of log, and
 * `describeAction` turns an offered `Action` into a button label.
 *
 * The interesting constraint is that this runs on **redacted** events. A steal the viewer was not
 * party to arrives with its payload replaced by `hidden: true`, so the narration has to be able to
 * say "Blue robbed White" without knowing what was taken — and must never be written in a way that
 * quietly assumes the secret is there. Every reader below therefore falls back rather than
 * throwing, and the `hidden` marker is a first-class case, not an error path.
 */

import type { Action, CardId, Cost, GameEvent, PlayerId, PlayerView } from '@catan/core';

import { cardDefName, cardStyle, humanize, pieceName, playerName, seatStyle } from './theme.js';

export interface Line {
  /** The event type, so the log can style a victory differently from a dice roll. */
  readonly kind: string;
  /** Whose line it is, for colour. `null` for events that belong to the table. */
  readonly seat: number | null;
  readonly text: string;
}

const STEPS: Readonly<Record<string, string>> = {
  setup: 'Opening placement',
  roll: 'Roll the dice',
  main: 'Build, trade, play',
  discard: 'Discard',
  robber: 'Move the robber',
  freeBuild: 'Free placement',
  trade: 'Trade offer',
};

export function stepName(kind: string): string {
  return STEPS[kind] ?? kind;
}

export function narrate(view: PlayerView, event: GameEvent): Line {
  const d = event.data;
  const who = player(d, 'player');
  const name = (id: PlayerId | null): string =>
    id === null ? 'Someone' : playerName(view.players, id);
  const line = (text: string, actor: PlayerId | null = who): Line => ({
    kind: event.type,
    seat: actor === null ? null : (view.players[actor]?.seat ?? null),
    text,
  });

  switch (event.type) {
    case 'turn':
      return line(`${name(who)}'s turn (turn ${num(d, 'n')})`);

    case 'dice': {
      const dice = list(d, 'dice')
        .filter((n): n is number => typeof n === 'number')
        .join(' + ');
      return line(`${name(who)} rolled ${num(d, 'total')}${dice === '' ? '' : ` (${dice})`}`);
    }

    case 'production': {
      // Two shapes: the opening grant names one player, a roll names everyone who claimed.
      if (who !== null) return line(`${name(who)} collects ${bundleText(cost(d, 'cards'))}`);
      const grants = record(d, 'grants');
      const paid = Object.entries(grants)
        .map(([id, got]) => `${name(id as PlayerId)} ${bundleText(got as Cost)}`)
        .join(', ');
      const short = list(d, 'shorted');
      const shortage = short.length === 0 ? '' : ` — the bank ran short of ${short.join(', ')}`;
      if (paid === '') return line(`Nobody produces on ${num(d, 'roll')}${shortage}`, null);
      return line(`Production on ${num(d, 'roll')}: ${paid}${shortage}`, null);
    }

    case 'build': {
      const free = d.free === true ? ' (free)' : '';
      return line(`${name(who)} builds a ${pieceName(str(d, 'kind'))}${free}`);
    }

    case 'buyDev': {
      const drew = event.secret === undefined ? '' : ` — ${cardDefName(str(event.secret, 'def'))}`;
      return line(`${name(who)} buys a development card${drew}`);
    }

    case 'playDev':
      return line(`${name(who)} plays ${cardDefName(str(d, 'def'))}`);

    case 'yearOfPlenty':
      return line(`${name(who)} takes ${bundleText(cost(d, 'taken'))} from the bank`);

    case 'monopoly':
      return line(
        `${name(who)} monopolises ${cardStyle(str(d, 'kind')).label} — ${num(d, 'total')} cards`,
      );

    case 'discard':
      return line(`${name(who)} discards ${bundleText(cost(d, 'cards'))}`);

    case 'robber':
      return line(`${name(who)} moves the robber`);

    case 'steal': {
      const from = player(d, 'from');
      const to = player(d, 'to');
      const what =
        event.secret === undefined ? 'a card' : cardStyle(str(event.secret, 'kind')).label;
      return line(`${name(to)} steals ${what} from ${name(from)}`, to);
    }

    case 'trade': {
      const partner = str(d, 'with');
      const other = partner === 'bank' ? 'the bank' : name(partner as PlayerId);
      return line(
        `${name(who)} trades ${bundleText(cost(d, 'give'))} to ${other} for ${bundleText(cost(d, 'want'))}`,
      );
    }

    case 'tradeOffered':
      return line(
        `${name(who)} offers ${bundleText(cost(d, 'give'))} for ${bundleText(cost(d, 'want'))}`,
      );

    case 'tradeResponse':
      return line(`${name(who)} ${d.accept === true ? 'accepts' : 'declines'}`);

    case 'tradeClosed':
      return line(`The offer was ${str(d, 'outcome')}`, null);

    case 'skip':
      return line(`${name(who)} forfeits the placement`);

    case 'endTurn':
      return line(`${name(who)} ends their turn`);

    case 'award': {
      const to = player(d, 'to');
      const award = humanize(str(d, 'award'));
      if (to === null) return line(`${award} is set aside — nobody leads`, null);
      return line(`${name(to)} takes ${award} with ${num(d, 'best')}`, to);
    }

    case 'victory':
      return line(`${name(who)} wins with ${num(d, 'points')} victory points`);

    default:
      return line(humanize(event.type), who);
  }
}

/** The label for a button that plays `action`. */
export function describeAction(view: PlayerView, action: Action): string {
  const name = (id: unknown): string =>
    typeof id === 'string' ? playerName(view.players, id as PlayerId) : 'someone';

  switch (action.type) {
    case 'roll':
      return 'Roll the dice';
    case 'endTurn':
      return 'End turn';
    case 'skip':
      return 'Forfeit this placement';
    case 'buyDev':
      return 'Buy a development card';
    case 'build':
    case 'place':
      return pieceName(String(action.kind ?? 'piece'));
    case 'moveRobber':
      return action.victim === null || action.victim === undefined
        ? 'Move the robber here'
        : `Rob ${name(action.victim)}`;
    case 'tradeBank':
      return `${bundleText(action.give as Cost)} → ${bundleText(action.want as Cost)}`;
    case 'discard':
      return `Discard ${bundleText(action.cards as Cost)}`;
    case 'respondTrade':
      return action.accept === true ? 'Accept' : 'Decline';
    case 'completeTrade':
      return `Trade with ${name(action.with)}`;
    case 'cancelTrade':
      return 'Withdraw the offer';
    case 'offerTrade':
      return 'Offer a trade';
    case 'playDev':
      return describeDevCard(view, action);
    default:
      return humanize(action.type);
  }
}

function describeDevCard(view: PlayerView, action: Action): string {
  const card = (typeof action.card === 'string' ? action.card : '') as CardId;
  const def = view.cardInstances[card]?.def ?? null;
  const base = cardDefName(def);
  if (Array.isArray(action.kinds)) {
    const kinds = action.kinds.map((k) => cardStyle(String(k)).label).join(' + ');
    return `${base}: ${kinds}`;
  }
  if (typeof action.kind === 'string') return `${base}: ${cardStyle(action.kind).label}`;
  return base;
}

/** `{ brick: 2, ore: 1 }` → `2 Brick, 1 Ore`. Empty bundles read as "nothing". */
export function bundleText(bundle: Cost | undefined): string {
  const parts = Object.entries(bundle ?? {})
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([kind, n]) => `${n} ${cardStyle(kind).label}`);
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}

/** The colour a line is drawn in, given its seat. */
export function lineColor(seat: number | null): string | null {
  return seat === null ? null : seatStyle(seat).color;
}

// ── Readers ─────────────────────────────────────────────────────────────────────────────────
//
// Event payloads are `Record<string, unknown>` — core does not interpret them and neither does
// the type system. These keep the narration total: a field that is missing or the wrong shape
// produces a duller sentence, never a thrown renderer.

function str(data: Readonly<Record<string, unknown>>, field: string): string {
  const value = data[field];
  return typeof value === 'string' ? value : '';
}

function num(data: Readonly<Record<string, unknown>>, field: string): number {
  const value = data[field];
  return typeof value === 'number' ? value : 0;
}

function player(data: Readonly<Record<string, unknown>>, field: string): PlayerId | null {
  const value = data[field];
  return typeof value === 'string' ? (value as PlayerId) : null;
}

function list(data: Readonly<Record<string, unknown>>, field: string): readonly unknown[] {
  const value = data[field];
  return Array.isArray(value) ? value : [];
}

function record(
  data: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  const value = data[field];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cost(data: Readonly<Record<string, unknown>>, field: string): Cost {
  return record(data, field) as Cost;
}
