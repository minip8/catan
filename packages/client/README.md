# @catan/client

The browser client. No framework, no runtime dependencies — `@catan/core` and the DOM.

```
npm run dev     # from the repo root: vite on http://localhost:5173
npm run build   # static files in packages/client/dist, which @catan/server will host
```

The fragment is the whole of the routing, and both forms are complete:

| | |
|---|---|
| `#seed=1234&players=4` | a hot-seat game dealt in this tab — same fragment, same island |
| `#room=9jyb9g` | a room on the server; a reload is a reconnect |
| `#room=…&server=http://host:3000` | …on a server somewhere else |

## The rule this package obeys

**The client contains no rules.** It never decides whether a spot is legal, whether you can afford
a road, or whose turn it is. It renders what it is given and sends back what it was offered:

```ts
table.snapshot(seat)    // a redacted view, the options that go with it, and the log
table.act(seat, action) // the authority is elsewhere; a refusal is displayed, never pre-empted
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
| `table.ts` | the seam: `Snapshot`, `Table`, and the hot-seat implementation |
| `remote.ts` | the same seam over a websocket, with reconnection |
| `app.ts` | the table, the seat, and the render loop |

The split that matters is `scene`/`narrate`/`targets` (pure, tested) against `board`/`panels`
(mechanical DOM). All the judgement is on the testable side.

## Hot seat and multiplayer are the same screen

`Table` is the only thing that differs between them, and it is a small interface: give the app a
`Snapshot` — a redacted view, its options, the log — and take back an `Action`. A `LocalTable` wraps
a `Session`; a `RemoteTable` wraps a socket. Nothing above the seam knows which it has, because
`update` frames from `@catan/server` carry exactly what `Session.act` produces per viewer.

One asymmetry is real, and the interface says so. `viewpoints` is every seat plus a spectator's for
a local game, and **exactly one** for a networked client — the view the server sent it, which it
cannot use to construct another. So the seat switcher disappears online rather than offering a peek
it could not deliver.

Two details worth knowing:

- **The board is drawn from a picture of it.** The server sends no topology, only a `scenarioId`;
  `contextFor` rebuilds the graph from that id, the same way `replay` does. A game record and a
  game update are both small for the same reason.
- **A dropped socket takes nothing with it.** The seat token is in `localStorage`, the room rebuilds
  from its action log, and rejoining is the same message as joining. What does not come back is the
  log of what happened while the tab was away: the server sends a snapshot, not a history.

In development the client is served from :5173 and the server from :3000, and Vite proxies `/rooms`,
`/health` and `/ws` across so the client can always talk to its own origin. In production the same
is true because the server hosts the built client itself. There is no branch in the code that asks
where the server is.

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

The networked half is tested against the real thing. `remote.test.ts` starts an actual
`@catan/server` and drives a `RemoteTable` over an actual websocket — including restarting the
server underneath a connected client, which exercises reconnection, replay-from-log and derived seat
tokens at once. `wire.test.ts` plays a **whole game to a winner** with three clients over sockets in
about a second, and then checks that each client saw its own cards and none of anyone else's.

That pair is also what keeps `remote.ts` honest about the protocol: it declares its own view of the
wire rather than importing `@catan/server`, because a browser bundle has no business depending on a
package that imports `node:http`.
