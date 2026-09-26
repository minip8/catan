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
  type CardId,
  type CardKind,
  type Cost,
  kindsWhere,
  type PlayerId,
  type PlayerView,
  type RuleContext,
} from '@catan/core';

import { pieceIcon } from './board.js';
import { h, text } from './dom.js';
import { glyphIcon } from './icons.js';
import { bundleText, describeAction, type Line, stepName } from './narrate.js';
import {
  type Affordances,
  defaultGroup,
  type Group,
  type Placement,
  visibleTargets,
} from './targets.js';
import { cardDefName, cardStyle, humanize, pieceName, playerName, seatStyle } from './theme.js';

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
  /** Whether the player has pulled up the action menu. */
  readonly menu: boolean;
  /** Whether every legal spot is lit, rather than only the one under the pointer. */
  readonly spots: boolean;
  /** A development card in hand whose ways of being played are on show. */
  readonly dev: string | null;
  readonly lines: readonly Line[];
  readonly notice: string | null;
  /**
   * The viewpoints this table can offer.
   *
   * Every seat plus a spectator's for a hot-seat game; exactly one for a networked client, which
   * holds the view the server sent it and cannot construct another. The seat switcher renders
   * from this rather than from the player list, so a remote client cannot even offer to peek.
   */
  readonly viewpoints: readonly (PlayerId | null)[];
  /** "Hot seat · seed 11", "Room 9jyb9g · live". */
  readonly label: string;
  /** False while a networked client is reconnecting. */
  readonly ready: boolean;
}

/** A request for a fresh game: how many players, and whether it lives on a server. */
export interface NewGameRequest {
  readonly players: number;
  readonly online: boolean;
}

export interface Handlers {
  readonly act: (action: Action) => void;
  readonly selectGroup: (group: string | null) => void;
  readonly watch: (watching: Watching) => void;
  /** Open a composer for `group`, optionally with one `seed` card already on the give side. */
  readonly compose: (group: Group, seed?: CardKind) => void;
  readonly editDraft: (draft: Draft) => void;
  readonly submitDraft: () => void;
  readonly cancelDraft: () => void;
  readonly chooseNothing: () => void;
  readonly toggleMenu: () => void;
  readonly toggleSpots: () => void;
  readonly pickDev: (card: string | null) => void;
  readonly newGame: (request: NewGameRequest) => void;
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
            `${ui.ctx.scenario.name} · first to ${ui.ctx.scenario.victoryTarget} points · ${ui.label}`,
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
      h('div', { attrs: { class: 'seats' }, children: watchControls(ui, on) }),
      h('div', { attrs: { class: 'seats' }, children: gameControls(ui, on) }),
    ],
  });
}

/**
 * The seat switcher, or a badge saying which seat is yours.
 *
 * A table with one viewpoint has nothing to switch between, and offering the choice would suggest
 * a networked client could look at someone else's hand. It cannot, so it does not ask.
 */
function watchControls(ui: Ui, on: Handlers): readonly HTMLElement[] {
  const seats = ui.viewpoints.filter((seat): seat is PlayerId => seat !== null);

  if (ui.viewpoints.length <= 1) {
    const only = ui.viewpoints[0] ?? null;
    const style = only === null ? null : seatStyle(ui.view.players[only]?.seat ?? 0);
    return [
      text('span', 'seats-label', 'You are'),
      h('span', {
        attrs: {
          class: 'chip chip-seat chip-looking',
          style: style === null ? null : `--seat: ${style.color}; --ink-color: ${style.ink}`,
        },
        children: [style?.name ?? 'a spectator'],
      }),
    ];
  }

  return [
    text('span', 'seats-label', 'Watching'),
    h('button', {
      attrs: {
        class: `chip${ui.watching.mode === 'auto' ? ' chip-on' : ''}`,
        type: 'button',
        title: 'Follow whoever the game is waiting on',
      },
      on: { click: () => on.watch({ mode: 'auto' }) },
      children: ['Hot seat'],
    }),
    ...seats.map((id) => seatButton(ui, on, id)),
    ...(ui.viewpoints.includes(null)
      ? [
          h('button', {
            attrs: {
              class: `chip${ui.watching.mode === 'spectate' ? ' chip-on' : ''}`,
              type: 'button',
            },
            on: { click: () => on.watch({ mode: 'spectate' }) },
            children: ['Spectator'],
          }),
        ]
      : []),
  ];
}

/** Start a fresh game, here or on the server. */
function gameControls(ui: Ui, on: Handlers): readonly HTMLElement[] {
  let players = ui.view.seatOrder.length;
  return [
    h('select', {
      attrs: { class: 'chip chip-select', 'aria-label': 'Players' },
      on: {
        change: (event) => {
          players = Number((event.target as HTMLSelectElement).value);
        },
      },
      children: PLAYER_COUNTS.map((n) =>
        h('option', {
          attrs: { value: n, selected: n === players },
          children: [`${n} players`],
        }),
      ),
    }),
    h('button', {
      attrs: { class: 'chip chip-new', type: 'button' },
      on: { click: () => on.newGame({ players, online: false }) },
      children: ['New hot seat'],
    }),
    h('button', {
      attrs: { class: 'chip chip-new', type: 'button', title: 'Create a room on the server' },
      on: { click: () => on.newGame({ players, online: true }) },
      children: ['New online game'],
    }),
  ];
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
      // `--ink-color`, not `--ink`: the latter is the global body ink, and setting it here would
      // shadow it for everything inside the chip.
      style: `--seat: ${seat.color}; --ink-color: ${seat.ink}`,
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
      class: `player${ui.actors.includes(id) ? ' player-active' : ''}${
        ui.seat === id ? ' player-you' : ''
      }`,
      style: `--seat: ${seat.color}; --ink-color: ${seat.ink}`,
    },
    children: [
      text('span', 'player-avatar', seat.name.charAt(0)),
      h('div', {
        attrs: { class: 'player-body' },
        children: [
          h('div', {
            attrs: { class: 'player-head' },
            children: [
              text('span', 'player-name', seat.name),
              h('span', {
                attrs: { class: 'player-points', title: 'Victory points' },
                children: [text('b', 'player-vp', points), ' VP'],
              }),
            ],
          }),
          h('div', {
            attrs: { class: 'player-stats' },
            children: [
              stat('stat-cards', hand, `${hand} resource card${hand === 1 ? '' : 's'}`),
              stat('stat-dev', dev, `${dev} development card${dev === 1 ? '' : 's'}`),
              ...awards.map((award) => text('span', 'stat stat-award', award)),
            ],
          }),
          text('div', 'player-supply', supply),
        ],
      }),
    ],
  });
}

/** A count beside a tiny card back: the shape Colonist-style scoreboards read at a glance. */
function stat(kind: string, n: number, title: string): HTMLElement {
  return h('span', {
    attrs: { class: `stat ${kind}`, title },
    children: [h('i', { attrs: { class: 'stat-icon', 'aria-hidden': 'true' } }), String(n)],
  });
}

// ── Hand ────────────────────────────────────────────────────────────────────────────────────

/**
 * The hand, and the tray that opens above it.
 *
 * When the player could trade or owes a discard, the resource cards are buttons: clicking one
 * starts that composition with the card on the give side, and clicking more adds more. That is
 * the gesture a card table teaches — you reach for the cards you mean to part with — and it puts
 * the composer directly above the cards it is made of.
 */
export function handPanel(ui: Ui, on: Handlers): HTMLElement {
  if (ui.seat === null) {
    return panel('Hand', [text('p', 'muted', 'Spectators hold no cards.')]);
  }
  const player = ui.view.players[ui.seat];
  if (player === undefined) return panel('Hand', [text('p', 'muted', 'No such seat.')]);

  const tray = trayGroup(ui);
  const held = (kind: string): number => player.cards[kind] ?? 0;
  const pick =
    tray === null
      ? null
      : (kind: CardKind): void => {
          const draft = ui.draft;
          if (draft === null) on.compose(tray, kind);
          else on.editDraft({ ...draft, give: adjust(draft.give, kind, 1, 0, held(kind)) });
        };

  const resources = Object.entries(player.cards)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => cardChip(kind, n, pick === null ? undefined : () => pick(kind)));

  // A development card is played by clicking it, like a resource is traded by clicking it. The
  // engine's offers say which cards can be played now and every way each one can be.
  const plays = acting(ui)
    ? (ui.affordances.groups.find((g) => g.type === 'playDev')?.choices ?? [])
    : [];
  const cards = Object.values(player.hands)
    .flat()
    .map((id) => {
      const def = ui.view.cardInstances[id]?.def ?? null;
      const ways = plays.filter((a) => a.card === id);
      const name = cardDefName(def);
      if (ways.length === 0) return text('li', `dev${def === null ? ' dev-hidden' : ''}`, name);
      const only = ways.length === 1 ? ways[0] : undefined;
      return h('li', {
        attrs: { class: `dev dev-live${ui.dev === id ? ' dev-picked' : ''}` },
        children: [
          h('button', {
            attrs: { class: 'dev-play', type: 'button', title: `Play ${name}` },
            on: {
              click: () =>
                only === undefined ? on.pickDev(ui.dev === id ? null : id) : on.act(only),
            },
            children: [name],
          }),
        ],
      });
    });

  const revealed = player.revealed.map((id) =>
    text('li', 'dev dev-revealed', cardDefName(ui.view.cardInstances[id]?.def ?? null)),
  );

  const hint =
    tray === null || resources.length === 0
      ? []
      : [
          text(
            'p',
            'hand-hint',
            tray.type === 'discard' ? 'Click cards to discard them' : 'Click a card to trade it',
          ),
        ];

  const section = panel('Hand', [
    ...hint,
    h('div', {
      attrs: { class: 'hand' },
      children: [
        h('div', {
          attrs: { class: 'chips' },
          children: resources.length > 0 ? resources : [text('span', 'muted', 'No resources.')],
        }),
        ...(cards.length > 0 ? [h('ul', { attrs: { class: 'devs' }, children: cards })] : []),
      ],
    }),
    ...(revealed.length > 0
      ? [text('h3', 'sub', 'Face up'), h('ul', { attrs: { class: 'devs' }, children: revealed })]
      : []),
    ...(ui.draft !== null && acting(ui) ? [draftForm(ui, ui.draft, on)] : []),
    ...(ui.dev !== null && ui.draft === null ? [devTray(ui, ui.dev, plays, on)] : []),
  ]);
  return section;
}

/** The ways to play one development card — Monopoly's five, Year of Plenty's pairs. */
function devTray(ui: Ui, card: string, plays: readonly Action[], on: Handlers): HTMLElement {
  const ways = plays.filter((a) => a.card === card);
  return h('div', {
    attrs: { class: 'tray', role: 'dialog', 'aria-label': 'Play a card' },
    children: [
      text(
        'h3',
        'tray-title',
        `Play ${cardDefName(ui.view.cardInstances[card as CardId]?.def ?? null)}`,
      ),
      h('div', {
        attrs: { class: 'btns' },
        children: [
          ...ways.map((action) =>
            h('button', {
              attrs: { class: 'btn', type: 'button' },
              on: { click: () => on.act(action) },
              children: [describeAction(ui.view, action)],
            }),
          ),
          h('button', {
            attrs: { class: 'btn', type: 'button' },
            on: { click: () => on.pickDev(null) },
            children: ['Cancel'],
          }),
        ],
      }),
    ],
  });
}

/**
 * What clicking a card in hand composes, if anything. A discard owed comes first — it is the only
 * thing the step allows — and otherwise a trade: an offer to the table if the engine takes one,
 * or a bank trade if that is all there is.
 */
function trayGroup(ui: Ui): Group | null {
  if (!acting(ui)) return null;
  const groups = ui.affordances.groups;
  return (
    groups.find((g) => g.type === 'discard') ??
    groups.find((g) => !g.enumerated) ??
    groups.find((g) => g.type === 'tradeBank') ??
    null
  );
}

/** A resource as a card: its art on a tint of its colour, the count in the corner. */
function cardChip(kind: CardKind, n: number, pick?: () => void): HTMLElement {
  const style = cardStyle(kind);
  const art = glyphIcon(kind, 'card-art');
  return h(pick === undefined ? 'span' : 'button', {
    attrs: {
      class: `card-chip${pick === undefined ? '' : ' card-pick'}`,
      style: `--card: ${style.color}`,
      title: `${n} ${style.label}`,
      type: pick === undefined ? null : 'button',
    },
    on: pick === undefined ? {} : { click: pick },
    children: [
      art ?? text('span', 'card-art card-letter', style.label.charAt(0)),
      text('span', 'card-name', style.label),
      text('span', 'card-count', n),
    ],
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
//
// Offers are split three ways, the way an online table lays them out:
//
// - **Bought** — a piece or a card with a price. These are the Build menu: every purchasable
//   thing as a priced tile, greyed out when the engine is not offering it.
// - **Made from the hand** — trades, discards and development cards. The cards in hand are the
//   controls for these; see `handPanel`.
// - **Everything else** — rolling, ending the turn, answering an offer. The moves that keep the
//   game going, as buttons right on the turn bar.

/** Can the viewer act right now? Everything below hangs off this. */
function acting(ui: Ui): boolean {
  return ui.ready && ui.view.outcome === null && ui.seat !== null && ui.actors.includes(ui.seat);
}

function isPurchase(group: Group): boolean {
  return group.type === 'build' || group.type === 'buyDev';
}

/** Trades and development cards are made from the hand. A discard is too, but it is also owed. */
function fromHand(group: Group): boolean {
  return (
    group.type === 'playDev' ||
    group.type === 'tradeBank' ||
    (!group.enumerated && group.type !== 'discard')
  );
}

/** The moves that keep the game going, for the turn bar. */
function flowGroups(ui: Ui): readonly Group[] {
  return ui.affordances.groups.filter((g) => !isPurchase(g) && !fromHand(g));
}

/** Whether this is a moment for buying at all — the part of a turn with a shop open. */
function shopOpen(ui: Ui): boolean {
  return ui.affordances.groups.some((g) => isPurchase(g) || fromHand(g));
}

/**
 * Whether the Build menu is up. The player pulls it up; the game only forces it open for a spot
 * they clicked that needs a second choice.
 */
function menuOpen(ui: Ui): boolean {
  return ui.menu || ui.choice !== null;
}

/**
 * The strip under the board: what the game wants, the buttons that move it along, and the one
 * that pulls up the Build menu.
 *
 * It never grows. Everything that could — the menu, a composer — opens *over* the board from here
 * rather than pushing it, so the board keeps its size however much there is to do.
 */
export function turnBar(ui: Ui, on: Handlers): HTMLElement {
  const lines: HTMLElement[] = [text('p', 'turn-say', prompt(ui))];
  // Spots are only lit under the pointer unless the player asks for all of them, so say so
  // whenever there are some to find.
  const selected = ui.affordances.groups.find((g) => g.key === ui.group);
  if (acting(ui) && visibleTargets(ui.affordances, ui.group).length > 0) {
    const link = (label: string, click: () => void): HTMLElement =>
      h('button', { attrs: { class: 'link', type: 'button' }, on: { click }, children: [label] });
    lines.push(
      h('p', {
        attrs: { class: 'turn-hint' },
        children: [
          selected === undefined ? '' : `${capitalize(selected.note)}: `,
          ui.spots ? 'pick a lit spot. ' : 'hover the board to find a spot. ',
          link(ui.spots ? 'Hide spots' : 'Show all', () => on.toggleSpots()),
          ...(selected === undefined ? [] : [' · ', link('Cancel', () => on.selectGroup(null))]),
        ],
      }),
    );
  }
  if (ui.notice !== null && ui.ready) lines.push(text('p', 'notice', ui.notice));

  const buttons: HTMLElement[] = acting(ui) ? flowButtons(ui, on) : [];
  if (acting(ui) && shopOpen(ui)) {
    const open = menuOpen(ui);
    const affordable = ui.affordances.groups.filter(isPurchase).length;
    buttons.push(
      h('button', {
        attrs: {
          class: `btn btn-menu${open ? ' btn-on' : ''}`,
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': 'action-menu',
        },
        on: { click: () => on.toggleMenu() },
        children: [
          open ? 'Close' : 'Build',
          open || affordable === 0 ? null : text('span', 'badge', affordable),
        ],
      }),
    );
  }

  return h('div', {
    attrs: { class: 'turn-bar' },
    children: [
      h('div', { attrs: { class: 'turn-prompt' }, children: lines }),
      buttons.length > 0 ? h('div', { attrs: { class: 'turn-btns' }, children: buttons }) : null,
    ],
  });
}

/** Roll, end turn, accept, forfeit — one button per offered move, straight on the bar. */
function flowButtons(ui: Ui, on: Handlers): HTMLElement[] {
  const auto = defaultGroup(ui.affordances);
  return flowGroups(ui).flatMap((group) => {
    const out: HTMLElement[] = [];
    // A placement the step requires is already live on the board; any other needs picking.
    if (group.placements.length > 0 && group.key !== auto) {
      const selected = ui.group === group.key;
      out.push(
        h('button', {
          attrs: { class: `btn${selected ? ' btn-on' : ''}`, type: 'button' },
          on: { click: () => on.selectGroup(selected ? null : group.key) },
          children: [capitalize(group.note)],
        }),
      );
    }
    if (!group.enumerated) {
      // A discard: composed in the tray over the hand, which this opens.
      out.push(
        h('button', {
          attrs: { class: 'btn btn-go', type: 'button' },
          on: { click: () => on.compose(group) },
          children: [`${capitalize(group.note)}…`],
        }),
      );
    } else {
      for (const action of group.choices) {
        out.push(
          h('button', {
            attrs: { class: 'btn btn-go', type: 'button' },
            on: { click: () => on.act(action) },
            children: [describeAction(ui.view, action)],
          }),
        );
      }
    }
    return out;
  });
}

function prompt(ui: Ui): string {
  if (!ui.ready) return ui.notice ?? 'Reconnecting…';
  if (ui.view.outcome !== null) return 'The game is over.';
  const waiting = ui.actors.map((p) => playerName(ui.view.players, p)).join(', ');
  if (!acting(ui)) return waiting === '' ? 'Nobody can act.' : `Waiting for ${waiting}.`;
  const step = ui.view.stack.at(-1);
  return `Your move — ${stepName(step?.kind ?? '').toLowerCase()}`;
}

/**
 * The Build menu: everything that can be bought, as priced tiles, opening above the turn bar.
 *
 * Every purchasable kind is listed whether or not it is on offer, so the menu doubles as the
 * price list; the engine's offers only decide which tiles are live. Prices and piece kinds come
 * from the ruleset's metadata, so a ruleset that adds a ship gets a ship tile.
 *
 * Always in the document, hidden while closed, so it keeps its place as the first panel and a
 * screen reader can find it through the toggle's `aria-controls`.
 */
export function actionsPanel(ui: Ui, on: Handlers): HTMLElement {
  const body = ((): HTMLElement[] => {
    if (!ui.ready) {
      // Offering moves that cannot be delivered would be a lie the reconnect then has to walk back.
      return [
        text('p', 'notice', ui.notice ?? 'Reconnecting…'),
        text('p', 'muted', 'The board is the last thing the server told us.'),
      ];
    }
    if (ui.view.outcome !== null) return [text('p', 'muted', 'The game is over.')];
    if (!acting(ui)) return [text('p', 'muted', prompt(ui))];
    if (ui.choice !== null) return [choiceBlock(ui, ui.choice, on)];
    return [h('div', { attrs: { class: 'shop' }, children: shopTiles(ui, on) })];
  })();

  const section = h('section', {
    attrs: { class: 'panel panel-actions', id: 'action-menu' },
    children: [text('h2', 'panel-title', ui.choice === null ? 'Build' : 'Choose'), ...body],
  });
  if (!menuOpen(ui) || !acting(ui)) section.hidden = true;
  return section;
}

function shopTiles(ui: Ui, on: Handlers): HTMLElement[] {
  const seat = ui.seat === null ? null : (ui.view.players[ui.seat] ?? null);
  const color = seat === null ? '#888' : seatStyle(seat.seat).color;
  const groups = ui.affordances.groups;
  const tiles: HTMLElement[] = [];

  for (const meta of Object.values(ui.ctx.rules.pieceKinds)) {
    if (!meta.owned || meta.cost === undefined) continue;
    const group = groups.find(
      (g) => g.type === 'build' && g.placements.some((p) => p.action.kind === meta.id),
    );
    const selected = group !== undefined && ui.group === group.key;
    const left = seat?.supply[meta.id];
    const n = group?.placements.length ?? 0;
    tiles.push(
      shopTile({
        name: pieceName(meta.id),
        icon: pieceIcon(meta.id, color, 'shop-icon'),
        cost: meta.cost,
        meta:
          group === undefined
            ? left === 0
              ? 'none left'
              : 'not now'
            : selected
              ? 'placing…'
              : `${n} spot${n === 1 ? '' : 's'}`,
        on: selected,
        click: group === undefined ? null : () => on.selectGroup(selected ? null : group.key),
      }),
    );
  }

  const decks = Object.values(ui.ctx.rules.decks);
  for (const deck of decks) {
    const choice = groups
      .find((g) => g.type === 'buyDev')
      ?.choices.find((a) => a.deck === deck.id || a.deck === undefined);
    const remaining = ui.view.decks[deck.id]?.remaining ?? 0;
    tiles.push(
      shopTile({
        name: decks.length === 1 ? 'Development card' : `${humanize(deck.id)} card`,
        icon: h('span', { attrs: { class: 'shop-icon shop-card', 'aria-hidden': 'true' } }),
        cost: deck.cost,
        meta: `${remaining} left`,
        on: false,
        click: choice === undefined ? null : () => on.act(choice),
      }),
    );
  }
  return tiles;
}

interface Tile {
  readonly name: string;
  readonly icon: Element;
  readonly cost: Cost;
  readonly meta: string;
  readonly on: boolean;
  /** `null` when the engine is not offering it: the tile is a price, not a button. */
  readonly click: (() => void) | null;
}

function shopTile(tile: Tile): HTMLElement {
  const cost = Object.entries(tile.cost).flatMap(([kind, n]) =>
    Array.from({ length: n ?? 0 }, () =>
      h('span', {
        attrs: { class: 'cost-card', style: `--card: ${cardStyle(kind).color}` },
        children: [glyphIcon(kind, 'cost-art') ?? cardStyle(kind).label.charAt(0)],
      }),
    ),
  );
  return h('button', {
    attrs: {
      class: `shop-tile${tile.on ? ' shop-on' : ''}`,
      type: 'button',
      disabled: tile.click === null,
      title: `${tile.name}: ${bundleText(tile.cost)}`,
    },
    on: tile.click === null ? {} : { click: tile.click },
    children: [
      tile.icon,
      h('span', {
        attrs: { class: 'shop-body' },
        children: [
          text('span', 'shop-name', tile.name),
          h('span', { attrs: { class: 'shop-cost', 'aria-hidden': 'true' }, children: cost }),
        ],
      }),
      text('span', 'shop-meta', tile.meta),
    ],
  });
}

/**
 * One spot, several things to do there — the robber arriving on a hex with two players on it.
 *
 * Resolved in the menu rather than as a popup over the board: the choice is between *players*,
 * not between places, so there is nothing for a popup to point at.
 */
function choiceBlock(ui: Ui, options: readonly Placement[], on: Handlers): HTMLElement {
  return h('div', {
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
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

  // The bank's offers, read two ways: the best rate per card (a hint on the give side), and any
  // offer that is exactly the bundles on the table (a button). The client computes no rate of its
  // own — a harbour it has never heard of still shows up, because the engine offered it.
  const bank = ui.affordances.groups.find((g) => g.type === 'tradeBank')?.choices ?? [];
  const rates = new Map<string, number>();
  for (const choice of bank) {
    const give = Object.entries(asCounts(choice.give));
    const only = give.length === 1 ? give[0] : undefined;
    if (only === undefined) continue;
    const [kind, n] = only;
    rates.set(kind, Math.min(rates.get(kind) ?? n, n));
  }
  const matches = discarding
    ? []
    : bank.filter(
        (choice) =>
          sameBundle(asCounts(choice.give), draft.give) &&
          sameBundle(asCounts(choice.want), draft.want),
      );

  // What you get on top, what you give at the bottom — nearest the hand it comes out of.
  const rows = [
    stepperRow(
      'give',
      discarding ? 'Discard' : 'You give',
      kinds,
      draft.give,
      (kind, delta) =>
        on.editDraft({ ...draft, give: adjust(draft.give, kind, delta, 0, held(kind)) }),
      (kind) => {
        const rate = rates.get(kind);
        return `${held(kind)} in hand${rate === undefined || discarding ? '' : ` · ${rate}:1`}`;
      },
    ),
  ];
  if (!discarding) {
    rows.unshift(
      stepperRow('want', 'You want', kinds, draft.want, (kind, delta) =>
        on.editDraft({ ...draft, want: adjust(draft.want, kind, delta, 0, 20) }),
      ),
    );
  }

  const ready =
    draft.required === null
      ? sum(draft.give) > 0 && (discarding || sum(draft.want) > 0)
      : total === draft.required;
  // A bank-only composer has nobody to offer to; its only way out is a matching bank trade.
  const offering = discarding || draft.type !== 'tradeBank';

  return h('div', {
    attrs: { class: 'tray', role: 'dialog', 'aria-label': discarding ? 'Discard' : 'Trade' },
    children: [
      h('div', {
        attrs: { class: 'tray-top' },
        children: [
          text('h3', 'tray-title', discarding ? 'Discard' : 'Trade'),
          text(
            'p',
            'draft-head',
            draft.required !== null
              ? `${total} of ${draft.required} cards chosen`
              : sum(draft.give) === 0 && sum(draft.want) === 0
                ? 'Pick what you give and what you want'
                : `${bundleText(draft.give as Cost)} for ${bundleText(draft.want as Cost)}`,
          ),
        ],
      }),
      ...rows,
      ...(ui.notice === null ? [] : [text('p', 'notice', ui.notice)]),
      h('div', {
        attrs: { class: 'btns' },
        children: [
          ...matches.map((choice) =>
            h('button', {
              attrs: { class: 'btn btn-go', type: 'button' },
              on: { click: () => on.act(choice) },
              children: [`Trade with the bank (${sum(asCounts(choice.give))}:1)`],
            }),
          ),
          offering
            ? h('button', {
                attrs: {
                  class: `btn ${matches.length > 0 ? '' : 'btn-go'}`,
                  type: 'button',
                  disabled: !ready,
                },
                on: { click: () => on.submitDraft() },
                children: [discarding ? 'Discard' : 'Offer to players'],
              })
            : null,
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

/**
 * One side of a composition, as cards. Clicking the card adds one; the − and + under it are the
 * same thing spelled out, and the only way to take one back.
 */
function stepperRow(
  side: 'give' | 'want',
  label: string,
  kinds: readonly CardKind[],
  values: Readonly<Record<string, number>>,
  change: (kind: CardKind, delta: number) => void,
  note?: (kind: CardKind) => string,
): HTMLElement {
  return h('div', {
    attrs: { class: 'stepper-row', 'data-side': side },
    children: [
      text('h4', 'sub', label),
      h('div', {
        attrs: { class: 'steppers' },
        children: kinds.map((kind) => {
          const style = cardStyle(kind);
          const n = values[kind] ?? 0;
          return h('div', {
            attrs: {
              class: `stepper${n > 0 ? ' stepper-on' : ''}`,
              style: `--card: ${style.color}`,
            },
            children: [
              h('button', {
                attrs: {
                  class: 'stepper-face',
                  type: 'button',
                  title: `Add a ${style.label}`,
                  'aria-hidden': 'true',
                  tabindex: -1,
                },
                on: { click: () => change(kind, 1) },
                children: [
                  glyphIcon(kind, 'card-art') ??
                    text('span', 'card-art card-letter', style.label.charAt(0)),
                  text('span', 'stepper-value', n),
                ],
              }),
              text('span', 'stepper-name', style.label),
              note === undefined ? null : text('span', 'stepper-note', note(kind)),
              h('div', {
                attrs: { class: 'stepper-controls' },
                children: [
                  h('button', {
                    attrs: { class: 'step', type: 'button', 'aria-label': `one fewer ${kind}` },
                    on: { click: () => change(kind, -1) },
                    children: ['−'],
                  }),
                  h('button', {
                    attrs: { class: 'step', type: 'button', 'aria-label': `one more ${kind}` },
                    on: { click: () => change(kind, 1) },
                    children: ['+'],
                  }),
                ],
              }),
            ],
          });
        }),
      }),
    ],
  });
}

/** A card bundle out of an action field, which arrives untyped. */
function asCounts(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, number> = {};
  for (const [kind, n] of Object.entries(value)) if (typeof n === 'number' && n > 0) out[kind] = n;
  return out;
}

function sameBundle(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? 0) === (b[k] ?? 0));
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

/** A titled card. `panel-<title>` lets the stylesheet place and size each one. */
function panel(title: string, children: readonly HTMLElement[]): HTMLElement {
  return h('section', {
    attrs: { class: `panel panel-${title.toLowerCase()}` },
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
