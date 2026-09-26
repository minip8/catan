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

// ── Interface icons ─────────────────────────────────────────────────────────────────────────
//
// The action bar and the scoreboard draw a few things that are not terrain: a trade, a turn
// ending, dice, the bank, an army, a road. Same 24-unit box, drawn in the ink colour so they sit
// on any tile.

const INK = '#2f3f52';

const line = (d: string, width = 2): SVGElement =>
  s('path', {
    attrs: {
      d,
      fill: 'none',
      stroke: INK,
      'stroke-width': width,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
  });

const UI: Readonly<Record<string, Draw>> = {
  // Two arrows chasing each other round a circle.
  trade: () => [
    line('M -8 -2 A 8.5 8.5 0 0 1 7 -5.5'),
    line('M 3.5 -8 L 7.4 -5.2 L 4 -1.8'),
    line('M 8 2 A 8.5 8.5 0 0 1 -7 5.5'),
    line('M -3.5 8 L -7.4 5.2 L -4 1.8'),
  ],
  hourglass: () => [
    line('M -7 -10 H 7 M -7 10 H 7'),
    line('M -5.5 -10 C -5.5 -3 5.5 -3 5.5 0 M 5.5 -10 C 5.5 -3 -5.5 -3 -5.5 0', 1.6),
    line('M -5.5 10 C -5.5 3 5.5 3 5.5 0 M 5.5 10 C 5.5 3 -5.5 3 -5.5 0', 1.6),
    s('path', { attrs: { d: 'M -4 8.8 Q 0 4 4 8.8 Z', fill: '#e0b35a' } }),
    s('path', { attrs: { d: 'M -3.4 -6.5 H 3.4 L 0 -2.2 Z', fill: '#e0b35a' } }),
  ],
  dice: () =>
    (
      [
        [-5, -3, [[-5, -3]]],
        [
          5,
          3,
          [
            [3, 1],
            [7, 5],
          ],
        ],
      ] as const
    ).flatMap(([cx, cy, pips]) => [
      s('rect', {
        attrs: {
          x: cx - 5.5,
          y: cy - 5.5,
          width: 11,
          height: 11,
          rx: 2.4,
          fill: '#fff',
          stroke: INK,
          'stroke-width': 1.6,
        },
      }),
      ...pips.map(([px, py]) => s('circle', { attrs: { cx: px, cy: py, r: 1.4, fill: INK } })),
    ]),
  bank: () => [
    s('path', { attrs: { d: 'M -11 -4 L 0 -11 L 11 -4 Z', fill: '#c9a15a', stroke: INK } }),
    ...[-7, -2.3, 2.3, 7].map((x) =>
      s('rect', { attrs: { x: x - 1.3, y: -3, width: 2.6, height: 10, fill: '#e8d3a2' } }),
    ),
    s('rect', { attrs: { x: -11, y: 7, width: 22, height: 3, fill: '#c9a15a', stroke: INK } }),
  ],
  // Largest Army: a shield.
  army: () => [
    s('path', {
      attrs: {
        d: 'M 0 -10 L 8 -7 V 0 C 8 6 4 9 0 11 C -4 9 -8 6 -8 0 V -7 Z',
        fill: '#d8dde3',
        stroke: INK,
        'stroke-width': 1.6,
        'stroke-linejoin': 'round',
      },
    }),
    line('M 0 -6 V 7 M -4.5 -1 H 4.5', 1.6),
  ],
  // Longest Road: an arched run of road.
  road: () => [
    s('path', {
      attrs: {
        d: 'M -10 7 Q 0 -11 10 7',
        fill: 'none',
        stroke: INK,
        'stroke-width': 5,
        'stroke-linecap': 'round',
      },
    }),
    s('path', {
      attrs: {
        d: 'M -10 7 Q 0 -11 10 7',
        fill: 'none',
        stroke: '#d8dde3',
        'stroke-width': 2.4,
        'stroke-dasharray': '2.5 2',
      },
    }),
  ],
};

/** An interface icon by name: `trade`, `hourglass`, `dice`, `bank`, `army`, `road`. */
export function uiIcon(name: string, className: string): SVGElement | null {
  const draw = UI[name];
  if (draw === undefined) return null;
  return s('svg', {
    attrs: { class: className, viewBox: '-12 -12 24 24', 'aria-hidden': 'true' },
    children: draw(),
  });
}
