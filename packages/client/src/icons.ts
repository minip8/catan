/**
 * Small pictures: the tree on a forest, the sheep on a pasture, the same sheep on a wool card.
 *
 * One table serves both the board and the hand, keyed by terrain *and* by the card it yields, so a
 * hand reads back onto the island the way the colours already do. Each glyph is drawn in a 24-unit
 * box centred on the origin; callers scale and place it.
 *
 * Like everything in `theme.ts`, the lookup is open: a terrain or card nobody has drawn returns
 * `null`, and the caller falls back to a label. Drawing is plain shapes rather than `feTurbulence`
 * or images, for the same reason the board's grain is a pattern — the tree is rebuilt on every
 * action, and flat shapes are what stays cheap to rebuild.
 */

import { s } from './dom.js';

type Draw = () => SVGElement[];

const tree: Draw = () => [
  s('rect', { attrs: { x: -1.6, y: 6, width: 3.2, height: 5, rx: 0.8, fill: '#6b4423' } }),
  s('polygon', {
    attrs: {
      points: '0,-11 7.5,1 3.8,1 9,8 -9,8 -3.8,1 -7.5,1',
      fill: '#1f5a2d',
      stroke: '#143d1e',
      'stroke-width': 0.8,
      'stroke-linejoin': 'round',
    },
  }),
  // Lit from the left, like the tiles' bevel.
  s('polygon', {
    attrs: { points: '0,-11 -7.5,1 -3.8,1 -9,8 0,8', fill: '#ffffff', 'fill-opacity': 0.14 },
  }),
];

const sheep: Draw = () => [
  s('line', { attrs: { x1: -4, y1: 3, x2: -4, y2: 8.5, stroke: '#3b3833', 'stroke-width': 1.8 } }),
  s('line', { attrs: { x1: 3, y1: 3, x2: 3, y2: 8.5, stroke: '#3b3833', 'stroke-width': 1.8 } }),
  s('path', {
    attrs: {
      // A fleece: five overlapping arcs round an oval, so the outline is lumpy rather than smooth.
      d: 'M -8 2 a 3.2 3.2 0 0 1 0 -5 a 3.4 3.4 0 0 1 5 -3.2 a 3.4 3.4 0 0 1 6 0 a 3.2 3.2 0 0 1 4.6 4 a 3 3 0 0 1 -1.6 5.4 a 3.4 3.4 0 0 1 -5.4 1.4 a 3.4 3.4 0 0 1 -5.6 0 a 3 3 0 0 1 -3 -2.6 Z',
      fill: '#f6f3ea',
      stroke: '#bfb7a2',
      'stroke-width': 0.8,
    },
  }),
  s('ellipse', { attrs: { cx: 8.6, cy: -1.6, rx: 2.8, ry: 3.4, fill: '#3b3833' } }),
];

const wheat: Draw = () =>
  [-24, 0, 24].flatMap((deg) => {
    const rad = (deg * Math.PI) / 180;
    const tipX = Math.sin(rad) * 10;
    const tipY = 9 - Math.cos(rad) * 17;
    return [
      s('line', {
        attrs: { x1: 0, y1: 10, x2: tipX, y2: tipY + 3, stroke: '#9a6b12', 'stroke-width': 1.3 },
      }),
      s('ellipse', {
        attrs: {
          cx: tipX,
          cy: tipY,
          rx: 2.4,
          ry: 5,
          transform: `rotate(${deg} ${tipX.toFixed(1)} ${tipY.toFixed(1)})`,
          fill: '#f0c347',
          stroke: '#9a6b12',
          'stroke-width': 0.8,
        },
      }),
    ];
  });

const bricks: Draw = () =>
  [
    [-9, 2.5],
    [0.5, 2.5],
    [-4.25, -3],
  ].map(([x, y]) =>
    s('rect', {
      attrs: {
        x,
        y,
        width: 8.5,
        height: 5,
        rx: 0.7,
        fill: '#b9471f',
        stroke: '#6e2710',
        'stroke-width': 0.9,
      },
    }),
  );

const mountain: Draw = () => [
  s('polygon', { attrs: { points: '0,9 5.5,-3 12,9', fill: '#4a525b' } }),
  s('polygon', {
    attrs: {
      points: '-11,9 -1,-10 8,9',
      fill: '#626c77',
      stroke: '#39404a',
      'stroke-width': 0.8,
      'stroke-linejoin': 'round',
    },
  }),
  s('polygon', { attrs: { points: '-1,-10 -4.4,-3.6 -2.2,-5 0,-2.8 2,-5.8', fill: '#f4f6f8' } }),
];

const cactus: Draw = () => [
  s('path', {
    attrs: {
      d: 'M -1.8 9 V -7 a 1.8 1.8 0 0 1 3.6 0 V 9 Z M -1.8 2 H -5 a 1.5 1.5 0 0 1 -1.5 -1.5 V -3 a 1.3 1.3 0 0 1 2.6 0 V -0.6 H -1.8 Z M 1.8 -1 H 4.4 V -5 a 1.3 1.3 0 0 1 2.6 0 V -1 a 1.8 1.8 0 0 1 -1.8 1.8 H 1.8 Z',
      fill: '#5b8f3e',
      stroke: '#3c6428',
      'stroke-width': 0.7,
    },
  }),
];

/** Terrain ids and the cards they yield, drawn alike. */
const GLYPHS: Readonly<Record<string, Draw>> = {
  forest: tree,
  lumber: tree,
  pasture: sheep,
  wool: sheep,
  fields: wheat,
  grain: wheat,
  hills: bricks,
  brick: bricks,
  mountains: mountain,
  ore: mountain,
  desert: cactus,
};

/** The glyph's shapes, or `null` for a name nobody has drawn. */
export function glyph(name: string): SVGElement[] | null {
  return GLYPHS[name]?.() ?? null;
}

/** A standalone inline icon for HTML — a card face, a harbour key. */
export function glyphIcon(name: string, className: string): SVGElement | null {
  const shapes = glyph(name);
  if (shapes === null) return null;
  return s('svg', {
    attrs: { class: className, viewBox: '-12 -12 24 24', 'aria-hidden': 'true' },
    children: shapes,
  });
}
