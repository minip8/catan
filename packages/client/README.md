# @catan/client

The browser client. No framework, no runtime dependencies — `@catan/core` and the DOM.

```
npm run dev     # from the repo root: vite on http://localhost:5173
npm run build   # static files in packages/client/dist
```

A board is a link: `#seed=1234&players=4`. Same fragment, same island, every time.

## The rule this package obeys

**The client contains no rules.** It never decides whether a spot is legal, whether you can afford
a road, or whose turn it is. It calls three methods and renders what comes back:

```ts
session.view(seat)      // everything drawn — board, hands, scoreboard, log
session.options(seat)   // everything clickable
session.act(seat, a)    // the authority; its refusal is displayed, never pre-empted
```

Every clickable thing on screen is an `Action` object the engine handed over, sent back unchanged.
A bug in this package can therefore hide a legal move, but it cannot invent an illegal one.

## How an offer becomes an affordance

`targets.ts` sorts the offered actions two ways, both ruleset-agnostic:

- **A board target is any action with a field naming a locus.** Not "a `build` has an `at`" — it
  asks the topology whether the string is a vertex, an edge or a hex. `moveRobber`'s `hex` and a
  future ship's `path` land there for free; `victim: 'p2'` does not, because `p2` is not a place.
- **A group is one `ActionSpec`.** The engine already groups its offers the way a player thinks
  about them, with a `note` like "build a settlement", so the UI reuses that instead of inventing
  categories the ruleset would outgrow.

Two specs arrive with `enumerated: false` — a discard and a trade offer, whose legal spaces are
combinatorial. Those are the only actions the client composes itself, and the only place it knows
an action's field names.

## Layout

| | |
|---|---|
| `dom.ts` | `h`/`s`: about forty lines, in place of a framework |
| `theme.ts` | names and colours, with a fallback for every open taxonomy |
| `targets.ts` | `ActionSpec[]` → spots on the board and buttons in the bar |
| `scene.ts` | the board as pure data, positioned by core's layout helpers |
| `board.ts` | scene → SVG |
| `narrate.ts` | events → log lines, actions → button labels |
| `panels.ts` | scoreboard, hand, bank, action bar, log, composer forms |
| `app.ts` | the session, the seat, and the render loop |

The split that matters is `scene`/`narrate`/`targets` (pure, tested) against `board`/`panels`
(mechanical DOM). All the judgement is on the testable side.

## Hot seat, and why it is a redaction test

The screen follows whoever the engine is waiting on, and switching seats really does switch eyes:
the hand, the log and the scoreboard are rebuilt from `redactFor(state, seat)`. A development card
you cannot see is a card this client does not have. Since every seat is one click from every other,
a leak in redaction shows up here immediately — which is why `app.test.ts` plays the opening and
then checks that the seats disagree about what is on the table.

The scoreboard is computed with `rules.victoryPoints` over the *view*, so it naturally under-counts
opponents' hidden victory-point cards. That is not an approximation — it is exactly what the other
players at the table can see.

## Testing

```
npm test              # from the repo root
```

`targets`, `scene` and `narrate` are tested as data against real engine output. `app.test.ts` runs
in jsdom: it mounts the app, clicks the board through the opening, rolls, composes a trade offer,
and reads the DOM back — which is what catches a listener bound to a node the next render replaces.
