/**
 * The whole view layer's dependency on a framework, which is to say: none.
 *
 * `h` and `s` build HTML and SVG elements; the app re-renders whole panels into a container on
 * every change. That is affordable because the board is nineteen hexes and the game advances once
 * per click — a diffing library would be buying performance nobody can perceive at the cost of a
 * build step, a runtime, and a second mental model of the DOM.
 *
 * What a framework would give us for free and this does not is preserved element identity across
 * renders, which is what CSS transitions animate against. Pieces therefore carry a stable `id`
 * derived from the engine's `PieceId`, and the board's entry animation is keyed off *appearance*
 * rather than off movement — good enough for a piece that is placed and never moves again, and
 * honest about what it cannot do for the robber.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Element children: text, nodes, and nothing (so `cond && node` is a legal child). */
export type Child = Node | string | number | false | null | undefined;

export type Attrs = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Event handlers, keyed by event name — `{ click: () => … }`. */
export type Handlers = Readonly<Record<string, (event: Event) => void>>;

export interface Options {
  readonly attrs?: Attrs;
  readonly on?: Handlers;
  readonly children?: readonly Child[];
}

function build(el: Element, options: Options): Element {
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [name, handler] of Object.entries(options.on ?? {})) {
    el.addEventListener(name, handler);
  }
  for (const child of options.children ?? []) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }
  return el;
}

export function h(tag: string, options: Options = {}): HTMLElement {
  return build(document.createElement(tag), options) as HTMLElement;
}

export function s(tag: string, options: Options = {}): SVGElement {
  return build(document.createElementNS(SVG_NS, tag), options) as SVGElement;
}

/** Shorthand for the commonest case: a styled element holding text. */
export function text(tag: string, className: string, content: Child): HTMLElement {
  return h(tag, { attrs: { class: className }, children: [content] });
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/** Replace a container's contents. */
export function render(into: Element, ...children: readonly Child[]): void {
  into.replaceChildren(
    ...children.filter((c): c is Node | string => typeof c === 'object' || typeof c === 'string'),
  );
}
