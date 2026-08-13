/**
 * The scene, as SVG.
 *
 * Mechanical by design: every position, angle and label was decided in `scene.ts`, so this file
 * only chooses shapes. The one judgement it makes is the drawing order — water, land, harbours,
 * tokens, roads, buildings, then live targets on top — because a target the player cannot see is
 * a spot they cannot use.
 *
 * Piece shapes are a small table with a fallback, for the same reason the theme is: `PieceKind` is
 * an open union, and a ruleset that adds a ship or a knight should get a plausible marker rather
 * than nothing at all.
 *
 * Depth comes from a single `<defs>` block rather than from per-terrain artwork. Two rules make
 * that work over an open taxonomy:
 *
 * - **Shading is neutral alpha, never a computed colour.** A lit roof is white at 16%, a shaded
 *   wall is black at 20%. Seat colours past the published six are `hsl()` strings from
 *   `seatStyle`'s fallback, and alpha composites over any of them without colour maths.
 * - **One gradient serves every hex.** The bevel is in `objectBoundingBox` units and the hexes are
 *   all one size, so a single definition lights all nineteen identically.
 *
 * The grain is a declarative `<pattern>` and deliberately not `feTurbulence`: the app re-renders
 * the whole SVG on every action, and a per-hex turbulence filter would be re-rasterised each time.
 */

import type { LocusId } from '@catan/core';

import { s } from './dom.js';
import type { DockShape, HexShape, PieceShape, Scene, TargetShape, Token } from './scene.js';
import { cardStyle, SEA_FILL, seatStyle, terrainStyle } from './theme.js';

export interface BoardHandlers {
  readonly onTarget: (locus: LocusId, event: MouseEvent) => void;
}

export function boardSvg(scene: Scene, handlers: BoardHandlers): SVGElement {
  const [x = 0, y = 0, width = 0, height = 0] = scene.viewBox.split(' ').map(Number);
  return s('svg', {
    attrs: {
      class: 'board',
      viewBox: scene.viewBox,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Game board',
    },
    children: [
      defs(),
      // The water is one graded body behind everything. Sea hexes still draw (they are part of the
      // scene, and the topology is what says where the coast is) but blend into it, so the ocean
      // does not read as a honeycomb of blue tiles.
      s('rect', { attrs: { class: 'sea', x, y, width, height, fill: 'url(#b-sea)' } }),
      s('g', {
        attrs: { class: 'hexes' },
        children: scene.hexes.map((hex) => hexGroup(hex, scene.size)),
      }),
      s('g', {
        attrs: { class: 'docks' },
        children: scene.docks.flatMap((dock) => dockGroup(dock, scene.size)),
      }),
      s('g', {
        attrs: { class: 'pieces' },
        children: scene.pieces.map((piece) => pieceGroup(piece, scene.size)),
      }),
      s('g', {
        attrs: { class: 'targets' },
        children: scene.targets.map((target) => targetGroup(target, scene.size, handlers)),
      }),
    ],
  });
}

// ── Paint ───────────────────────────────────────────────────────────────────────────────────

/**
 * The four pieces of paint the board reuses. Ids are prefixed `b-` because they land in the
 * document's global id space, which the panels also live in.
 */
function defs(): SVGElement {
  return s('defs', {
    children: [
      // The bevel. Light from the upper left, shadow gathering at the lower right — the whole of
      // why a tile reads as raised rather than as a coloured shape.
      s('radialGradient', {
        attrs: { id: 'b-sheen', cx: '0.34', cy: '0.24', r: '0.92' },
        children: [
          stop('0', '#ffffff', '0.20'),
          stop('0.5', '#ffffff', '0.03'),
          stop('1', '#000000', '0.26'),
        ],
      }),
      // Terrain grain: four specks in a rotated tile, rendered once and repeated across all land.
      s('pattern', {
        attrs: {
          id: 'b-grain',
          width: 14,
          height: 14,
          patternUnits: 'userSpaceOnUse',
          patternTransform: 'rotate(24)',
        },
        children: [
          speck(3.0, 2.5, 1.15, '#ffffff', '0.05'),
          speck(10.2, 6.8, 0.9, '#000000', '0.06'),
          speck(6.1, 11.4, 1.0, '#ffffff', '0.035'),
          speck(12.6, 1.4, 0.7, '#000000', '0.05'),
        ],
      }),
      // Deeper water towards the rim, so the island sits in a basin rather than on a flat field.
      s('radialGradient', {
        attrs: { id: 'b-sea', cx: '0.5', cy: '0.46', r: '0.74' },
        children: [
          stop('0', '#2a6d99', '1'),
          stop('0.6', '#1d4d70', '1'),
          stop('1', '#0f2f47', '1'),
        ],
      }),
      // One lift, shared by tokens, harbour badges and pieces.
      s('filter', {
        attrs: { id: 'b-raise', x: '-40%', y: '-40%', width: '180%', height: '180%' },
        children: [
          s('feDropShadow', {
            attrs: {
              dx: 0,
              dy: 1.8,
              stdDeviation: 1.6,
              'flood-color': '#000000',
              'flood-opacity': 0.45,
            },
          }),
        ],
      }),
    ],
  });
}

function stop(offset: string, color: string, opacity: string): SVGElement {
  return s('stop', {
    attrs: { offset, 'stop-color': color, 'stop-opacity': opacity },
  });
}

function speck(cx: number, cy: number, r: number, fill: string, opacity: string): SVGElement {
  return s('circle', { attrs: { cx, cy, r, fill, 'fill-opacity': opacity } });
}

// ── Hexes ───────────────────────────────────────────────────────────────────────────────────

function hexGroup(hex: HexShape, size: number): SVGElement {
  const style = terrainStyle(hex.terrain);
  const water = hex.class === 'sea';
  const outline = hex.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const children: SVGElement[] = [
    s('polygon', {
      attrs: {
        class: `hex hex-${hex.class}${hex.blocked ? ' hex-blocked' : ''}`,
        points: outline,
        fill: water ? SEA_FILL : style.fill,
      },
      children: [s('title', { children: [water ? 'Sea' : style.label] })],
    }),
  ];

  // Grain then bevel, over the same outline. Land only: the sea is meant to look flat and wet.
  // Neither carries the `hex` class — `app.test.ts` counts one `.hex` per hex group — and both are
  // transparent to the pointer so the tile's own tooltip and hit area survive underneath.
  if (!water) {
    children.push(
      s('polygon', { attrs: { class: 'hex-grain', points: outline, fill: 'url(#b-grain)' } }),
      s('polygon', { attrs: { class: 'hex-sheen', points: outline, fill: 'url(#b-sheen)' } }),
    );
  }

  if (!water && hex.terrain !== null) {
    children.push(
      s('text', {
        attrs: {
          class: 'hex-label',
          x: hex.center.x,
          y: hex.center.y + size * 0.62,
          'text-anchor': 'middle',
        },
        children: [style.label],
      }),
    );
  }

  hex.tokens.forEach((token, index) => {
    // Spread multiple tokens along the hex's width. The base game never has more than one, but a
    // Traders & Barbarians lake carries four and would otherwise stack them on one spot.
    const spread = hex.tokens.length === 1 ? 0 : (index - (hex.tokens.length - 1) / 2) * size * 0.6;
    children.push(tokenGroup(hex.center.x + spread, hex.center.y, size, token));
  });

  // The robber itself is a piece and is drawn in the pieces layer; `blocked` only dims the hex,
  // so a hex is never told twice that production has stopped there.
  return s('g', { attrs: { class: 'hex-group' }, children });
}

function tokenGroup(x: number, y: number, size: number, token: Token): SVGElement {
  const radius = size * 0.26;
  const pips = Array.from({ length: token.pips }, (_, i) => {
    const spacing = radius * 0.24;
    const offset = (i - (token.pips - 1) / 2) * spacing;
    return s('circle', {
      attrs: { cx: x + offset, cy: y + radius * 0.52, r: radius * 0.075, class: 'pip' },
    });
  });
  return s('g', {
    attrs: { class: `token${token.hot ? ' token-hot' : ''}` },
    children: [
      s('circle', { attrs: { cx: x, cy: y, r: radius, class: 'token-face' } }),
      // An inset ring, the way a printed token is bordered. Red on a 6 or an 8, so the two hot
      // numbers are findable by shape as well as by colour.
      s('circle', { attrs: { cx: x, cy: y, r: radius * 0.84, class: 'token-ring' } }),
      s('text', {
        attrs: { x, y: y + radius * 0.12, 'text-anchor': 'middle', class: 'token-value' },
        children: [token.value],
      }),
      ...pips,
    ],
  });
}

// ── Harbours ────────────────────────────────────────────────────────────────────────────────

function dockGroup(dock: DockShape, size: number): SVGElement[] {
  // Each mooring is drawn twice: a dark pier under a pale plank, which is what lets a thin line
  // stay legible over water that is now graded rather than flat.
  const out: SVGElement[] = dock.anchors.flatMap((anchor) => {
    const ends = { x1: anchor.x, y1: anchor.y, x2: dock.at.x, y2: dock.at.y };
    return [
      s('line', { attrs: { class: 'dock-pier', ...ends } }),
      s('line', { attrs: { class: 'dock-line', ...ends } }),
    ];
  });
  const label = dock.kind === null ? 'any' : cardStyle(dock.kind).label;
  out.push(
    s('g', {
      attrs: { class: 'dock' },
      children: [
        s('circle', {
          attrs: {
            cx: dock.at.x,
            cy: dock.at.y,
            r: size * 0.26,
            class: 'dock-face',
            fill: dock.kind === null ? '#e8e4dc' : cardStyle(dock.kind).color,
          },
        }),
        s('text', {
          attrs: {
            x: dock.at.x,
            y: dock.at.y - size * 0.02,
            'text-anchor': 'middle',
            class: 'dock-ratio',
          },
          children: [dock.label],
        }),
        s('text', {
          attrs: {
            x: dock.at.x,
            y: dock.at.y + size * 0.15,
            'text-anchor': 'middle',
            class: 'dock-kind',
          },
          children: [label],
        }),
      ],
    }),
  );
  return out;
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────

function pieceGroup(piece: PieceShape, size: number): SVGElement {
  const seat = piece.seat === null ? null : seatStyle(piece.seat);
  const fill = seat?.color ?? '#3a3a3a';
  const transform = `translate(${piece.at.x} ${piece.at.y}) rotate(${(piece.angle * 180) / Math.PI})`;

  return s('g', {
    attrs: { class: `piece piece-${piece.kind}`, id: `piece-${piece.id}`, transform },
    children: shapeFor(piece.kind, size, fill),
  });
}

/**
 * The drawn form of a piece: a seat-coloured silhouette, then neutral shading over it. Unknown
 * kinds get a disc, which is better than nothing.
 */
function shapeFor(kind: string, size: number, fill: string): SVGElement[] {
  switch (kind) {
    case 'road':
      return road(size * 0.4, fill);
    case 'settlement':
      return settlement(size * 0.3, fill);
    case 'city':
      return city(size * 0.36, fill);
    case 'robber':
      return robber(size * 0.22);
    default:
      return [s('circle', { attrs: { r: size * 0.18, fill, class: 'building' } })];
  }
}

/** A plank with the light catching its upper edge. */
function road(r: number, fill: string): SVGElement[] {
  const thickness = r * 0.4;
  return [
    s('rect', {
      attrs: {
        x: -r,
        y: -thickness,
        width: r * 2,
        height: thickness * 2,
        rx: r * 0.125,
        fill,
        class: 'road',
      },
    }),
    s('rect', {
      attrs: {
        x: -r * 0.94,
        y: -thickness * 0.86,
        width: r * 1.88,
        height: thickness * 0.72,
        rx: r * 0.1,
        fill: '#ffffff',
        'fill-opacity': 0.18,
        class: 'shade',
      },
    }),
  ];
}

/** A gabled house: lit roof, shaded right wall. */
function settlement(r: number, fill: string): SVGElement[] {
  return [
    s('polygon', {
      attrs: {
        points: points([
          [-r, r * 0.6],
          [-r, -r * 0.2],
          [0, -r],
          [r, -r * 0.2],
          [r, r * 0.6],
        ]),
        fill,
        class: 'building',
      },
    }),
    shade(
      [
        [-r, -r * 0.2],
        [0, -r],
        [r, -r * 0.2],
      ],
      '#ffffff',
      0.16,
    ),
    shade(
      [
        [r * 0.25, -r * 0.8],
        [r, -r * 0.2],
        [r, r * 0.6],
        [r * 0.25, r * 0.6],
      ],
      '#000000',
      0.2,
    ),
  ];
}

/** A house with a taller wing — the city silhouette, lit and shaded the same way. */
function city(r: number, fill: string): SVGElement[] {
  return [
    s('polygon', {
      attrs: {
        points: points([
          [-r, r * 0.55],
          [-r, -r * 0.25],
          [-r * 0.45, -r * 0.85],
          [0, -r * 0.25],
          [0, -r * 0.55],
          [r * 0.5, -r * 0.55],
          [r, -r * 0.05],
          [r, r * 0.55],
        ]),
        fill,
        class: 'building',
      },
    }),
    shade(
      [
        [-r, -r * 0.25],
        [-r * 0.45, -r * 0.85],
        [0, -r * 0.25],
      ],
      '#ffffff',
      0.18,
    ),
    shade(
      [
        [r * 0.5, -r * 0.55],
        [r, -r * 0.05],
        [r, r * 0.55],
        [r * 0.5, r * 0.55],
      ],
      '#000000',
      0.2,
    ),
  ];
}

/**
 * A pawn, drawn as one path so the cream outline runs round the silhouette rather than through
 * the neck. The arc is the head; the two curves are the shoulders falling to the base.
 */
function robber(r: number): SVGElement[] {
  const d = [
    `M ${(-r * 0.9).toFixed(1)} ${(r * 1.0).toFixed(1)}`,
    `C ${(-r * 0.72).toFixed(1)} ${(r * 0.25).toFixed(1)},`,
    `${(-r * 0.42).toFixed(1)} ${(r * 0.05).toFixed(1)},`,
    `${(-r * 0.34).toFixed(1)} ${(-r * 0.3).toFixed(1)}`,
    `A ${(r * 0.42).toFixed(1)} ${(r * 0.42).toFixed(1)} 0 1 1`,
    `${(r * 0.34).toFixed(1)} ${(-r * 0.3).toFixed(1)}`,
    `C ${(r * 0.42).toFixed(1)} ${(r * 0.05).toFixed(1)},`,
    `${(r * 0.72).toFixed(1)} ${(r * 0.25).toFixed(1)},`,
    `${(r * 0.9).toFixed(1)} ${(r * 1.0).toFixed(1)}`,
    'Z',
  ].join(' ');
  return [
    s('path', { attrs: { d, fill: '#2b2521', class: 'robber' } }),
    // Kept below the neck: the shoulders are a cubic, and a straight highlight taken any higher
    // would cut outside the curve it is meant to sit on.
    shade(
      [
        [-r * 0.78, r * 1.0],
        [-r * 0.45, r * 0.09],
        [-r * 0.24, r * 0.09],
        [-r * 0.4, r * 1.0],
      ],
      '#ffffff',
      0.14,
    ),
  ];
}

/** A neutral highlight or shadow over a piece. Alpha, so it works over any seat colour. */
function shade(
  pairs: readonly (readonly [number, number])[],
  fill: string,
  opacity: number,
): SVGElement {
  return s('polygon', {
    attrs: { points: points(pairs), fill, 'fill-opacity': opacity, class: 'shade' },
  });
}

function points(pairs: readonly (readonly [number, number])[]): string {
  return pairs.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

// ── Targets ─────────────────────────────────────────────────────────────────────────────────

function targetGroup(target: TargetShape, size: number, handlers: BoardHandlers): SVGElement {
  const transform = `translate(${target.at.x} ${target.at.y}) rotate(${(target.angle * 180) / Math.PI})`;
  const hit =
    target.kind === 'edge'
      ? s('rect', {
          attrs: {
            x: -size * 0.36,
            y: -size * 0.12,
            width: size * 0.72,
            height: size * 0.24,
            rx: size * 0.08,
            class: 'target-edge',
          },
        })
      : s('circle', {
          attrs: {
            r: target.kind === 'hex' ? size * 0.42 : size * 0.17,
            class: `target-${target.kind}`,
          },
        });

  return s('g', {
    attrs: {
      class: 'target',
      transform,
      tabindex: 0,
      role: 'button',
      'aria-label': `${target.options} option${target.options === 1 ? '' : 's'} here`,
    },
    on: {
      click: (event) => handlers.onTarget(target.locus, event as MouseEvent),
      keydown: (event) => {
        const key = (event as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
        event.preventDefault();
        handlers.onTarget(target.locus, event as unknown as MouseEvent);
      },
    },
    children: [hit],
  });
}
