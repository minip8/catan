/**
 * Zooming and panning the board.
 *
 * The board is one SVG, so a zoom is nothing but a smaller `viewBox` over the same scene. The state
 * is three numbers — how far in, and where the middle is — held by the app rather than the SVG,
 * because the app replaces the whole SVG on every action and a zoom that reset on each click would
 * be worse than none.
 *
 * The maths is pure and tested; `attachZoom` is the thin part that listens to wheels, drags and
 * pinches. While a gesture is in flight it writes the `viewBox` straight onto the live element
 * rather than re-rendering, so panning costs one attribute per frame and not a rebuilt board.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Zoom {
  /** 1 shows the whole board; 2 shows half its width. */
  readonly scale: number;
  /** The middle of the view, in scene units. `null` is the middle of the board. */
  readonly cx: number | null;
  readonly cy: number | null;
}

/** Below 1 the board is smaller than its box: room to see it whole whatever the screen. */
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 4;
export const WHOLE: Zoom = { scale: 1, cx: null, cy: null };

export function parseBox(viewBox: string): Box {
  const [x = 0, y = 0, width = 0, height = 0] = viewBox.split(' ').map(Number);
  return { x, y, width, height };
}

/**
 * The part of the scene a zoom shows.
 *
 * The board can be dragged at any zoom, even whole, so the view may run past the sea's edge; what
 * it may not do is lose the board. The middle of the view is kept inside `base`, which leaves at
 * least a quarter of the board on screen however far it is flung.
 */
export function viewOf(base: Box, zoom: Zoom): Box {
  const scale = clamp(zoom.scale, MIN_SCALE, MAX_SCALE);
  const width = base.width / scale;
  const height = base.height / scale;
  const cx = clamp(zoom.cx ?? base.x + base.width / 2, base.x, base.x + base.width);
  const cy = clamp(zoom.cy ?? base.y + base.height / 2, base.y, base.y + base.height);
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

export function boxString(box: Box): string {
  return [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 10) / 10).join(' ');
}

/** Zoom by `factor`, keeping the scene point under the cursor where it is. */
export function zoomAt(base: Box, zoom: Zoom, factor: number, px: number, py: number): Zoom {
  const view = viewOf(base, zoom);
  const scale = clamp(zoom.scale * factor, MIN_SCALE, MAX_SCALE);
  const width = base.width / scale;
  const height = base.height / scale;
  const x = px - ((px - view.x) / view.width) * width;
  const y = py - ((py - view.y) / view.height) * height;
  return settle(base, { scale, cx: x + width / 2, cy: y + height / 2 });
}

/** Move the view by a distance in scene units. */
export function panBy(base: Box, zoom: Zoom, dx: number, dy: number): Zoom {
  const view = viewOf(base, zoom);
  return settle(base, {
    scale: zoom.scale,
    cx: view.x + view.width / 2 + dx,
    cy: view.y + view.height / 2 + dy,
  });
}

/** Store the clamped centre, so a pan past the edge does not bank distance to unwind later. */
function settle(base: Box, zoom: Zoom): Zoom {
  const view = viewOf(base, zoom);
  return { scale: zoom.scale, cx: view.x + view.width / 2, cy: view.y + view.height / 2 };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ── Gestures ────────────────────────────────────────────────────────────────────────────────

/** How far a press may wander, in screen pixels, and still count as a click. */
const SLOP = 5;

/**
 * Wire wheel, drag and pinch onto a board SVG, listening on `surface` — the whole area the board
 * can be seen in, not just the SVG's own box.
 *
 * That matters because the board draws past its box once dragged, and because a wheel or pinch
 * the board does not handle is one the browser does: a trackpad pinch over open water would zoom
 * the *page*, which the board's own controls then cannot undo. Anything over the controls that
 * float on the surface (`.hud`, `.rail`) is left alone.
 *
 * A drag that moved more than a few pixels swallows the click that ends it, so panning across a
 * live spot does not build on it. `store` is called on every change, and is expected to remember
 * the zoom without re-rendering.
 */
export function attachZoom(
  svg: SVGSVGElement,
  surface: HTMLElement,
  base: Box,
  initial: Zoom,
  store: (zoom: Zoom) => void,
): void {
  let zoom = initial;
  const pointers = new Map<number, { x: number; y: number }>();
  let dragged = false;
  let start: { x: number; y: number } | null = null;
  let pinch: number | null = null;

  const onBoard = (target: EventTarget | null): boolean =>
    !(target instanceof Element) || target.closest('.hud, .rail') === null;

  const apply = (next: Zoom): void => {
    zoom = next;
    svg.setAttribute('viewBox', boxString(viewOf(base, zoom)));
    store(zoom);
  };

  /** Screen pixels to scene units, and a screen point to a scene point. */
  const unit = (): number => 1 / (svg.getScreenCTM?.()?.a ?? 1);
  const toScene = (clientX: number, clientY: number): { x: number; y: number } => {
    const ctm = svg.getScreenCTM?.();
    if (ctm === null || ctm === undefined) return { x: 0, y: 0 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  };

  surface.addEventListener(
    'wheel',
    (event) => {
      if (!onBoard(event.target)) return;
      event.preventDefault();
      const at = toScene(event.clientX, event.clientY);
      apply(zoomAt(base, zoom, Math.exp(-event.deltaY * 0.0015), at.x, at.y));
    },
    { passive: false },
  );

  surface.addEventListener('pointerdown', (event) => {
    if (!onBoard(event.target)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      start = { x: event.clientX, y: event.clientY };
      dragged = false;
    }
    if (pointers.size === 2) pinch = spread(pointers);
  });

  surface.addEventListener('pointermove', (event) => {
    const last = pointers.get(event.pointerId);
    if (last === undefined) return;
    const now = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, now);

    if (pointers.size === 2 && pinch !== null) {
      const next = spread(pointers);
      const mid = middle(pointers);
      const at = toScene(mid.x, mid.y);
      dragged = true;
      apply(zoomAt(base, zoom, next / pinch, at.x, at.y));
      pinch = next;
      return;
    }

    if (start !== null && !dragged && Math.hypot(now.x - start.x, now.y - start.y) > SLOP) {
      dragged = true;
      surface.setPointerCapture?.(event.pointerId);
    }
    if (dragged) {
      const k = unit();
      apply(panBy(base, zoom, (last.x - now.x) * k, (last.y - now.y) * k));
    }
  });

  const release = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) start = null;
  };
  surface.addEventListener('pointerup', release);
  surface.addEventListener('pointercancel', release);

  // Capture phase, so it runs before a target's own click handler and can cancel it.
  surface.addEventListener(
    'click',
    (event) => {
      if (!dragged) return;
      dragged = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}

function spread(pointers: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...pointers.values()];
  return a === undefined || b === undefined ? 1 : Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
}

function middle(pointers: Map<number, { x: number; y: number }>): { x: number; y: number } {
  const [a, b] = [...pointers.values()];
  if (a === undefined || b === undefined) return { x: 0, y: 0 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
