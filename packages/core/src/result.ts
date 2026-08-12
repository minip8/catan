/**
 * `Result` is how the engine reports rule violations.
 *
 * **The engine never throws for a rule violation.** An illegal action is an ordinary,
 * expected outcome — a client asked for something the rules forbid — and callers must be
 * forced to handle it. Throwing is reserved for engine *bugs* (see `invariants.ts`), where
 * the process should stop rather than continue with corrupt state.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** `Ok<void>`, allocated once — the overwhelmingly common return of `isLegal`. */
export const OK_VOID: Ok<void> = { ok: true, value: undefined };

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export function andThen<T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/**
 * Unwrap a `Result` that is expected to be `Ok`, throwing if it is not.
 *
 * Only for tests and for call sites that have already checked legality — never as a way to
 * skip handling a violation.
 */
export function expect<T, E>(r: Result<T, E>, message: string): T {
  if (!r.ok) {
    throw new Error(`${message}: ${JSON.stringify(r.error)}`);
  }
  return r.value;
}

/** Returns the first `Err` in `results`, or `Ok<void>` if they all succeeded. */
export function all<E>(results: Iterable<Result<unknown, E>>): Result<void, E> {
  for (const r of results) {
    if (!r.ok) return r;
  }
  return OK_VOID;
}
