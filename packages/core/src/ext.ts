/**
 * Attachment points for expansion state.
 *
 * Core ships these **empty** and never reads them. An expansion widens them by declaration
 * merging, so its state rides along inside `GameState` without core knowing the field exists:
 *
 * ```ts
 * // expansions/cities-knights/ext.ts
 * declare module '@catan/core/ext' {
 *   interface PlayerExtensions {
 *     ck: { improvements: Record<'trade' | 'politics' | 'science', number>; walls: number };
 *   }
 *   interface GameExtensions {
 *     ck: { barbarianPos: number; firstAttackResolved: boolean };
 *   }
 * }
 * ```
 *
 * Declaration merging rather than making `GameState` generic. A generic `GameState<Ext>` would
 * infect every function signature in the engine and every reducer return type, for no gain: there
 * is exactly one ruleset in play per game, so the extra type parameter would never vary usefully
 * within a single call graph. It also keeps `GameState` a plain JSON-serialisable object.
 */

// These MUST stay `interface`, not `type`. Declaration merging only works on interfaces, so
// converting either of these to a type alias silently breaks every expansion's ability to extend
// it. Keep the ignore directives on one line each — a wrapped biome-ignore does not attach, and
// the autofix will "helpfully" rewrite the interface into a type alias.

// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty; expansions widen it.
export interface PlayerExtensions {}

// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty; expansions widen it.
export interface GameExtensions {}
