/**
 * Everything beside the board: who is playing, what you hold, what you may do, and what happened.
 *
 * The panels are functions of a `Ui` snapshot, so a render is a fresh read of the session rather
 * than a set of mutations applied to the DOM. That is what keeps the client honest about
 * redaction: the scoreboard, the hand and the log are all built from a `PlayerView`, and the view
 * is the only thing the app ever holds. If a panel could show a card the viewer may not see, the
 * bug would have to be in `redactFor`, not here.
 *
 * The action bar deserves the same note as `targets.ts`: it renders `ActionSpec`s, and its buttons
 * send back objects the engine handed it. It has no idea what a knight is.
 */

import {
  type Action,
  type CardKind,
  type Cost,
  kindsWhere,
  type PlayerId,
  type PlayerView,
  type RuleContext,
} from '@catan/core';

import { h, text } from './dom.js';
import { bundleText, describeAction, type Line, stepName } from './narrate.js';
import type { Affordances, Group, Placement } from './targets.js';
import { cardDefName, cardStyle, humanize, playerName, seatStyle } from './theme.js';

/** A composed action the engine could not enumerate: a discard, or a trade offer. */
export interface Draft {
  readonly group: string;
  readonly type: string;
  readonly give: Readonly<Record<string, number>>;
  readonly want: Readonly<Record<string, number>>;
  /** How many cards `give` must total, when the step fixes it. */
  readonly required: number | null;
}

/**
 * Whose screen this is.
 *
 * `auto` is what makes a hot-seat game playable: the screen belongs to whoever the engine is
 * waiting on, so passing the laptop is the only handover. Pinning a seat is for looking at the
 * game from one player's side — including looking at your own hand while it is not your turn.
 */
export type Watching =
  | { readonly mode: 'auto' }
  | { readonly mode: 'seat'; readonly seat: PlayerId }
  | { readonly mode: 'spectate' };

export interface Ui {
  readonly ctx: RuleContext;
  readonly view: PlayerView;
  /** Whose eyes we are looking through, resolved from `watching`. `null` is a spectator. */
  readonly seat: PlayerId | null;
  readonly watching: Watching;
  /** Who the engine is waiting on. */
  readonly actors: readonly PlayerId[];
  readonly affordances: Affordances;
  readonly group: string | null;
  readonly draft: Draft | null;
  /** Several actions offered at one spot, awaiting a pick. */
  readonly choice: readonly Placement[] | null;
  readonly lines: readonly Line[];
  readonly notice: string | null;
}

export interface Handlers {
  readonly act: (action: Action) => void;
  readonly selectGroup: (group: string | null) => void;
  readonly watch: (watching: Watching) => void;
  readonly compose: (group: Group) => void;
  readonly editDraft: (draft: Draft) => void;
  readonly submitDraft: () => void;
  readonly cancelDraft: () => void;
  readonly chooseNothing: () => void;
  readonly newGame: (players: number) => void;
}

/** Player counts core will deal a board for. Above six there is no official layout. */
const PLAYER_COUNTS = [3, 4, 5, 6, 7, 8, 9, 10] as const;

// ── Header ──────────────────────────────────────────────────────────────────────────────────

export function headerPanel(ui: Ui, on: Handlers): HTMLElement {
  const step = ui.view.stack.at(-1);
  const waiting = ui.actors.map((p) => playerName(ui.view.players, p)).join(', ');
  const status =
    ui.view.outcome !== null
      ? `${playerName(ui.view.players, ui.view.outcome.winner)} wins — ${ui.view.outcome.reason}`
      : step === undefined
        ? 'Nothing to do'
        : `${stepName(step.kind)} — ${waiting}`;

  return h('header', {
    attrs: { class: 'top' },
    children: [
      h('div', {
        attrs: { class: 'title' },
        children: [
          text('h1', 'title-name', 'Catan'),
          text(
            'p',
            'title-sub',
            `${ui.ctx.scenario.name} · first to ${ui.ctx.scenario.victoryTarget} points · seed ${ui.view.seed}`,
          ),
          // Core marks its 7-10 player layouts unofficial because no published rules cover them.
          ui.ctx.scenario.unofficial === true
            ? text(
                'p',
                'title-warn',
                'Unofficial layout — there are no published rules above 6 players',
              )
            : h('span'),
        ],
      }),
      text('p', `status${ui.view.outcome !== null ? ' status-won' : ''}`, status),
      h('div', {
        attrs: { class: 'seats' },
        children: [
          text('span', 'seats-label', 'Watching'),
          h('button', {
            attrs: {
              class: `chip${ui.watching.mode === 'auto' ? ' chip-on' : ''}`,
              type: 'button',
              title: 'Follow whoever the engine is waiting on',
            },
            on: { click: () => on.watch({ mode: 'auto' }) },
            children: ['Hot seat'],
          }),
          ...ui.view.seatOrder.map((id) => seatButton(ui, on, id)),
          h('button', {
            attrs: {
              class: `chip${ui.watching.mode === 'spectate' ? ' chip-on' : ''}`,
              type: 'button',
            },
            on: { click: () => on.watch({ mode: 'spectate' }) },
            children: ['Spectator'],
          }),
          h('select', {
            attrs: { class: 'chip chip-select', 'aria-label': 'Players' },
            on: {
              change: (event) => on.newGame(Number((event.target as HTMLSelectElement).value)),
            },
            children: PLAYER_COUNTS.map((n) =>
              h('option', {
                attrs: { value: n, selected: n === ui.view.seatOrder.length },
                children: [`${n} players`],
              }),
            ),
          }),
          h('button', {
            attrs: { class: 'chip chip-new', type: 'button' },
            on: { click: () => on.newGame(ui.view.seatOrder.length) },
            children: ['New game'],
          }),
        ],
      }),
    ],
  });
}

function seatButton(ui: Ui, on: Handlers, id: PlayerId): HTMLElement {
  const seat = seatStyle(ui.view.players[id]?.seat ?? 0);
  const pinned = ui.watching.mode === 'seat' && ui.watching.seat === id;
  const looking = ui.seat === id;
  return h('button', {
    attrs: {
      class: `chip chip-seat${pinned ? ' chip-on' : ''}${looking ? ' chip-looking' : ''}${
        ui.actors.includes(id) ? ' chip-active' : ''
      }`,
      type: 'button',
      style: `--seat: ${seat.color}; --ink: ${seat.ink}`,
    },
    on: { click: () => on.watch({ mode: 'seat', seat: id }) },
    children: [seat.name],
  });
}

// ── Players ─────────────────────────────────────────────────────────────────────────────────

export function playersPanel(ui: Ui): HTMLElement {
  const rows = ui.view.seatOrder.map((id) => playerRow(ui, id));
  return panel('Players', [h('ul', { attrs: { class: 'players' }, children: rows })]);
}

function playerRow(ui: Ui, id: PlayerId): HTMLElement {
  const player = ui.view.players[id];
  if (player === undefined) return h('li');
  const seat = seatStyle(player.seat);
  const points = ui.ctx.rules.victoryPoints(ui.ctx, ui.view, id);
  const hand = Object.values(player.cards).reduce((a, b) => a + b, 0);
  const dev = Object.values(player.hands).reduce((a, b) => a + b.length, 0);
  const awards = Object.entries(ui.view.awards)
    .filter(([, award]) => award.holder === id)
    .map(([name]) => humanize(name));

  const supply = Object.entries(player.supply)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(' · ');

  return h('li', {
    attrs: {
      class: `player${ui.actors.includes(id) ? ' player-active' : ''}`,
      style: `--seat: ${seat.color}; --ink: ${seat.ink}`,
    },
    children: [
      h('div', {
        attrs: { class: 'player-head' },
        children: [
          text('span', 'player-name', seat.name),
          text('span', 'player-points', `${points} VP`),
        ],
      }),
      text(
        'div',
        'player-stats',
        `${hand} cards · ${dev} dev · ${awards.join(', ') || 'no awards'}`,
      ),
      text('div', 'player-supply', supply),
    ],
  });
}

// ── Hand ────────────────────────────────────────────────────────────────────────────────────

export function handPanel(ui: Ui): HTMLElement {
  if (ui.seat === null) return panel('Hand', [text('p', 'muted', 'Spectators hold no cards.')]);
  const player = ui.view.players[ui.seat];
  if (player === undefined) return panel('Hand', [text('p', 'muted', 'No such seat.')]);

  const resources = Object.entries(player.cards)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => cardChip(kind, n));

  const cards = Object.values(player.hands)
    .flat()
    .map((id) => {
      const def = ui.view.cardInstances[id]?.def ?? null;
      return text('li', `dev${def === null ? ' dev-hidden' : ''}`, cardDefName(def));
    });

  const revealed = player.revealed.map((id) =>
    text('li', 'dev dev-revealed', cardDefName(ui.view.cardInstances[id]?.def ?? null)),
  );

  return panel('Hand', [
    h('div', {
      attrs: { class: 'chips' },
      children: resources.length > 0 ? resources : [text('span', 'muted', 'No resources.')],
    }),
    ...(cards.length > 0 ? [h('ul', { attrs: { class: 'devs' }, children: cards })] : []),
    ...(revealed.length > 0
      ? [text('h3', 'sub', 'Face up'), h('ul', { attrs: { class: 'devs' }, children: revealed })]
      : []),
  ]);
}

function cardChip(kind: CardKind, n: number): HTMLElement {
  const style = cardStyle(kind);
  return h('span', {
    attrs: { class: 'card-chip', style: `--card: ${style.color}` },
    children: [text('span', 'card-name', style.label), text('span', 'card-count', n)],
  });
}

export function bankPanel(ui: Ui): HTMLElement {
  const chips = Object.entries(ui.view.bank).map(([kind, n]) => cardChip(kind, n));
  const decks = Object.entries(ui.view.decks).map(([id, deck]) =>
    text('span', 'deck', `${id}: ${deck.remaining} left`),
  );
  return panel('Bank', [
    h('div', { attrs: { class: 'chips' }, children: chips }),
    h('div', { attrs: { class: 'decks' }, children: decks }),
  ]);
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────

export function actionsPanel(ui: Ui, on: Handlers): HTMLElement {
  if (ui.view.outcome !== null) {
    return panel('Actions', [text('p', 'muted', 'The game is over.')]);
  }
  if (ui.seat === null || !ui.actors.includes(ui.seat)) {
    const waiting = ui.actors.map((p) => playerName(ui.view.players, p)).join(', ');
    return panel('Actions', [
      text('p', 'muted', waiting === '' ? 'Nobody can act.' : `Waiting for ${waiting}.`),
    ]);
  }
  if (ui.draft !== null) return panel('Actions', [draftForm(ui, ui.draft, on)]);
  if (ui.choice !== null) return panel('Actions', [choiceBlock(ui, ui.choice, on)]);

  const groups = ui.affordances.groups.map((group) => groupBlock(ui, group, on));
  const notice = ui.notice === null ? [] : [text('p', 'notice', ui.notice)];
  return panel('Actions', [...notice, ...groups]);
}

/**
 * One spot, several things to do there — the robber arriving on a hex with two players on it.
 *
 * Resolved in the panel rather than as a popup over the board: the choice is between *players*,
 * not between places, so there is nothing for a popup to point at.
 */
function choiceBlock(ui: Ui, options: readonly Placement[], on: Handlers): HTMLElement {
  return h('div', {
    attrs: { class: 'group' },
    children: [
      text('h3', 'sub', 'Choose'),
      h('div', {
        attrs: { class: 'btns' },
        children: [
          ...options.map((option) =>
            h('button', {
              attrs: { class: 'btn', type: 'button' },
              on: { click: () => on.act(option.action) },
              children: [describeAction(ui.view, option.action)],
            }),
          ),
          h('button', {
            attrs: { class: 'btn', type: 'button' },
            on: { click: () => on.chooseNothing() },
            children: ['Cancel'],
          }),
        ],
      }),
    ],
  });
}

function groupBlock(ui: Ui, group: Group, on: Handlers): HTMLElement {
  const children: HTMLElement[] = [text('h3', 'sub', group.note)];

  if (group.placements.length > 0) {
    const selected = ui.group === group.key;
    children.push(
      h('button', {
        attrs: { class: `btn${selected ? ' btn-on' : ''}`, type: 'button' },
        on: { click: () => on.selectGroup(selected ? null : group.key) },
        children: [
          selected
            ? `Showing ${group.placements.length} spots — click the board`
            : `Show ${group.placements.length} spots`,
        ],
      }),
    );
  }

  if (group.choices.length > 0) {
    children.push(
      h('div', {
        attrs: { class: 'btns' },
        children: group.choices.map((action) =>
          h('button', {
            attrs: { class: 'btn', type: 'button' },
            on: { click: () => on.act(action) },
            children: [describeAction(ui.view, action)],
          }),
        ),
      }),
    );
  }

  if (!group.enumerated) {
    children.push(
      h('button', {
        attrs: { class: 'btn btn-compose', type: 'button' },
        on: { click: () => on.compose(group) },
        children: [group.choices.length > 0 ? 'Choose different cards…' : 'Compose…'],
      }),
    );
  }

  return h('div', { attrs: { class: 'group' }, children });
}

// ── Composing what the engine could not enumerate ───────────────────────────────────────────

/**
 * The form for a discard or a trade offer.
 *
 * These are the two places the client builds an action from scratch, because their legal spaces
 * are combinatorial — a hand of eight has seventy legal four-card discards, and a trade offer is
 * any bundle for any bundle. The form is deliberately permissive: it enforces only what it can
 * show the player (you cannot offer cards you do not hold), and lets the engine refuse the rest.
 */
function draftForm(ui: Ui, draft: Draft, on: Handlers): HTMLElement {
  const player = ui.seat === null ? undefined : ui.view.players[ui.seat];
  const held = (kind: string): number => player?.cards[kind] ?? 0;
  const total = sum(draft.give);
  const discarding = draft.type === 'discard';

  const kinds = discarding
    ? kindsWhere(ui.ctx.rules, (m) => m.countsTowardHandLimit)
    : kindsWhere(ui.ctx.rules, (m) => m.tradeable);

  const rows = [
    stepperRow(discarding ? 'Discard' : 'You give', kinds, draft.give, (kind, delta) =>
      on.editDraft({ ...draft, give: adjust(draft.give, kind, delta, 0, held(kind)) }),
    ),
  ];
  if (!discarding) {
    rows.push(
      stepperRow('You want', kinds, draft.want, (kind, delta) =>
        on.editDraft({ ...draft, want: adjust(draft.want, kind, delta, 0, 20) }),
      ),
    );
  }

  const ready =
    draft.required === null
      ? sum(draft.give) > 0 && (discarding || sum(draft.want) > 0)
      : total === draft.required;

  return h('div', {
    attrs: { class: 'draft' },
    children: [
      text(
        'p',
        'draft-head',
        draft.required === null
          ? `Offering ${bundleText(draft.give as Cost)} for ${bundleText(draft.want as Cost)}`
          : `${total} of ${draft.required} cards chosen`,
      ),
      ...rows,
      ...(ui.notice === null ? [] : [text('p', 'notice', ui.notice)]),
      h('div', {
        attrs: { class: 'btns' },
        children: [
          h('button', {
            attrs: { class: 'btn btn-go', type: 'button', disabled: !ready },
            on: { click: () => on.submitDraft() },
            children: [discarding ? 'Discard' : 'Offer'],
          }),
          h('button', {
            attrs: { class: 'btn', type: 'button' },
            on: { click: () => on.cancelDraft() },
            children: ['Cancel'],
          }),
        ],
      }),
    ],
  });
}

function stepperRow(
  label: string,
  kinds: readonly CardKind[],
  values: Readonly<Record<string, number>>,
  change: (kind: CardKind, delta: number) => void,
): HTMLElement {
  return h('div', {
    attrs: { class: 'stepper-row' },
    children: [
      text('h4', 'sub', label),
      h('div', {
        attrs: { class: 'steppers' },
        children: kinds.map((kind) =>
          h('div', {
            attrs: { class: 'stepper', style: `--card: ${cardStyle(kind).color}` },
            children: [
              text('span', 'stepper-name', cardStyle(kind).label),
              h('div', {
                attrs: { class: 'stepper-controls' },
                children: [
                  h('button', {
                    attrs: { class: 'step', type: 'button', 'aria-label': `one fewer ${kind}` },
                    on: { click: () => change(kind, -1) },
                    children: ['−'],
                  }),
                  text('span', 'stepper-value', values[kind] ?? 0),
                  h('button', {
                    attrs: { class: 'step', type: 'button', 'aria-label': `one more ${kind}` },
                    on: { click: () => change(kind, 1) },
                    children: ['+'],
                  }),
                ],
              }),
            ],
          }),
        ),
      }),
    ],
  });
}

// ── Log ─────────────────────────────────────────────────────────────────────────────────────

export function logPanel(ui: Ui): HTMLElement {
  const lines = [...ui.lines].reverse().slice(0, 60);
  return panel('Log', [
    h('ol', {
      attrs: { class: 'log' },
      children: lines.map((line) =>
        h('li', {
          attrs: {
            class: `log-line log-${line.kind}`,
            style: line.seat === null ? null : `--seat: ${seatStyle(line.seat).color}`,
          },
          children: [line.text],
        }),
      ),
    }),
  ]);
}

// ── Shared ──────────────────────────────────────────────────────────────────────────────────

function panel(title: string, children: readonly HTMLElement[]): HTMLElement {
  return h('section', {
    attrs: { class: 'panel' },
    children: [text('h2', 'panel-title', title), ...children],
  });
}

function sum(bundle: Readonly<Record<string, number>>): number {
  return Object.values(bundle).reduce((a, b) => a + b, 0);
}

function adjust(
  bundle: Readonly<Record<string, number>>,
  kind: string,
  delta: number,
  min: number,
  max: number,
): Readonly<Record<string, number>> {
  const next = Math.max(min, Math.min(max, (bundle[kind] ?? 0) + delta));
  const out = { ...bundle, [kind]: next };
  if (next === 0) delete out[kind];
  return out;
}
