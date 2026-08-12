# @catan/core

The rules engine. Deliberately dependency-free.

## The contract

```ts
const { ctx, state } = newGame({ scenario: baseScenario34(), rules: baseRules(), seed, players: 4 });

reduce(ctx, state, actor, action)   // Result<Tick, RuleViolation> — the authority
isLegal(ctx, state, actor, action)  // a dry run of reduce, so the two cannot disagree
legalActions(ctx, state, actor)     // ActionSpec[] for UIs and bots, never trusted
redactFor(state, viewer)            // PlayerView — what one player may see
redactEvents(events, viewer)        // ditto, for what just happened
replay(record)                      // (seed, scenarioId, ruleSetId, seats, log) → the whole game
```

## How a turn moves

There is no phase enum. `state.stack` is a continuation stack whose **last element is the top**,
and a step belongs to whoever is named in its `actor`:

```
beginTurn (system)  →  roll  →  main  →  beginTurn (next player)
                         ↑        ↑
             a 7 pushes discard + robber above whatever it interrupted;
             a knight pushes robber; Road Building pushes two freeBuilds
```

Because an interruption sits *above* the step it interrupts, nothing has to remember where to
return to. A knight played before the roll leaves `roll` underneath, so the player still rolls; the
same knight played in the main phase returns to `main`.

`discard` is the step that justifies the design: its actor is a **list** of players, none of them
the active one, all acting independently before it resolves.

## Layout

| | |
|---|---|
| `ids`, `result`, `rng` | branded ids, the violation channel, the only entropy |
| `coords/`, `board/` | the lattice, vertex/edge identity, scenarios, topology, board generation |
| `state/` | `GameState`, the structural invariants, and `Tx` — the only sanctioned mutator |
| `rules/` | mechanisms parameterised by ruleset tables: placement, production, trade, route, awards |
| `engine/` | `newGame`, `reduce`, `redactFor`, `replay`, and `autoplay` for fuzzing |
| `rulesets/base/` | the base game: the tables, and the step handlers |

The `rules/` ÷ `rulesets/` split is the one to keep: `rules/` knows *how* legality is computed,
`rulesets/` knows *what* each piece, card and step is.

## Invariants

- **No I/O, no `Date`, no `Math.random`.** All entropy comes from `state.rng`, advanced purely
  through `Tx.random`. This is what makes `(seed, scenarioId, ruleSetId, actionLog)` a complete
  replay — see `replay.ts`, and the tests that rebuild whole games from their logs.
- **The engine never throws for a rule violation.** Violations are values (`Result`). Throwing is
  reserved for engine bugs, i.e. broken invariants.
- **`isLegal` is the only authority.** `legalActions` returns *descriptors* for UIs and bots and is
  never trusted by the reducer. The fuzz test asserts that everything offered is accepted.
- **Authority comes from owning the top step**, never from `turn.active`. Even the base game has
  steps that belong to non-active players (discard-on-7).
- **Topology is immutable and lives outside `GameState`.** Terrain and number tokens are mutable
  state; the graph is not.
- **No literal `['brick','lumber','ore','grain','wool']` outside the base ruleset definition.**
  Hand limits, discards, steals, and monopoly all derive from `cardKinds` metadata.
- **`GameState` is JSON.** No `Map`s, no class instances — the reducer's clone is a JSON round trip
  precisely so that a violation of this shows up immediately.
- **Secrecy is a property of the event, not of the call site.** Anything one player learns that
  another does not goes in `GameEvent.secret` with an `audience`.

## Adding an expansion

Nothing in `engine/` or `rules/` should need to change. An expansion supplies a `RuleSet` — its own
`cardKinds`, `pieceKinds`, `cardDefs`, `decks`, `awards` and `steps` — plus scenarios, and widens
`PlayerExtensions` / `GameExtensions` by declaration merging if it needs state of its own.

## Testing

```
npm test          # the whole suite
npm run typecheck # including test files
npm run check     # biome
```

`autoplay` plays complete games through the public API with `assertInvariants` running after every
action. It is the highest-value test in the package: run it over seeds and any card that is minted,
piece that is lost, or index left stale surfaces at the action that caused it. Fixtures shared
between test files live in `*.testkit.ts`, which the build excludes.
