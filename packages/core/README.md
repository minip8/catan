# @catan/core

The rules engine. Deliberately dependency-free.

## The contract

```ts
reduce(state, actor, action): Result<Tick, RuleViolation>
isLegal(state, actor, action): Result<void, RuleViolation>
legalActions(state, actor): ActionSpec[]
redactFor(state, actor): PlayerView
redactEvents(events, actor): GameEvent[]
```

## Invariants

- **No I/O, no `Date`, no `Math.random`.** All entropy comes from `state.rng`, advanced purely.
  This is what makes `(seed, scenarioId, ruleSetId, actionLog)` a complete replay.
- **The engine never throws for a rule violation.** Violations are values (`Result`). Throwing is
  reserved for engine bugs, i.e. broken invariants.
- **`isLegal` is the only authority.** `legalActions` returns *descriptors* for UIs and bots and is
  never trusted by the reducer.
- **Authority comes from owning the top step**, never from `turn.active`. Even the base game has
  steps that belong to non-active players (discard-on-7).
- **Topology is immutable and lives outside `GameState`.** Terrain and number tokens are mutable
  state; the graph is not.
- **No literal `['brick','lumber','ore','grain','wool']` outside the base ruleset definition.**
  Hand limits, discards, steals, and monopoly all derive from `cardKinds` metadata.
