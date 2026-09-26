import { describe, expect, it } from 'vitest';

import { MAX_SCALE, MIN_SCALE, panBy, viewOf, WHOLE, zoomAt } from './zoom.js';

const base = { x: -100, y: -50, width: 400, height: 200 };

describe('zoom', () => {
  it('shows the whole board at scale 1', () => {
    expect(viewOf(base, WHOLE)).toEqual(base);
  });

  it('keeps the point under the cursor fixed', () => {
    const z = zoomAt(base, WHOLE, 2, 0, 0);
    const view = viewOf(base, z);
    expect(view.width).toBe(200);
    // (0,0) was a quarter of the way across; it still is.
    expect((0 - view.x) / view.width).toBeCloseTo((0 - base.x) / base.width);
    expect((0 - view.y) / view.height).toBeCloseTo((0 - base.y) / base.height);
  });

  it('drags freely, but never loses the board', () => {
    // Whole-board zoom still pans.
    const moved = viewOf(base, panBy(base, WHOLE, 50, 0));
    expect(moved.x).toBeCloseTo(base.x + 50);

    const z = panBy(base, zoomAt(base, WHOLE, 2, 100, 50), 10_000, -10_000);
    const view = viewOf(base, z);
    expect(view.x + view.width / 2).toBeCloseTo(base.x + base.width);
    expect(view.y + view.height / 2).toBeCloseTo(base.y);
    // Flung far past the edge and back a little: the excess was not banked.
    const back = viewOf(base, panBy(base, z, -10, 0));
    expect(back.x).toBeCloseTo(view.x - 10);
  });

  it('clamps between a board smaller than its box and the closest zoom', () => {
    expect(zoomAt(base, WHOLE, 0.01, 0, 0).scale).toBe(MIN_SCALE);
    expect(zoomAt(base, WHOLE, 100, 0, 0).scale).toBe(MAX_SCALE);
  });
});
