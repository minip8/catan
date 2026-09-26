import { describe, expect, it } from 'vitest';

import { MAX_SCALE, panBy, viewOf, WHOLE, zoomAt } from './zoom.js';

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

  it('never shows past the edge of the board', () => {
    const z = panBy(base, zoomAt(base, WHOLE, 2, 100, 50), 10_000, -10_000);
    const view = viewOf(base, z);
    expect(view.x + view.width).toBeCloseTo(base.x + base.width);
    expect(view.y).toBeCloseTo(base.y);
    // Panned far past the edge and back a little: the excess was not banked.
    const back = viewOf(base, panBy(base, z, -10, 0));
    expect(back.x).toBeCloseTo(view.x - 10);
  });

  it('clamps between the whole board and the closest zoom', () => {
    expect(zoomAt(base, WHOLE, 0.5, 0, 0)).toEqual(WHOLE);
    expect(zoomAt(base, WHOLE, 100, 0, 0).scale).toBe(MAX_SCALE);
  });
});
