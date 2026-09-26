/**
 * The scene, as SVG.
 *
 * Mechanical by design: every position, angle and label was decided in `scene.ts`, so this file
 * only chooses shapes. The one judgement it makes is the drawing order — water, beach, land,
 * harbours, tokens, roads, buildings, then live targets on top — because a target the player cannot see is
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
import { glyph } from './icons.js';
import type { DockShape, HexShape, PieceShape, Scene, TargetShape, Token } from './scene.js';
import { cardStyle, SAND_FILL, SEA_FILL, seatStyle, terrainStyle } from './theme.js';

export interface BoardHandlers {
  readonly onTarget: (locus: LocusId, event: MouseEvent) => void;
}

export function boardSvg(scene: Scene, handlers: BoardHandlers): SVGElement {
  const land = scene.hexes.filter((hex) => hex.class !== 'sea');
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
      // The page is the ocean. The island's edge is two strokes of every land tile's outline laid
      // under the tiles — pale shallows, then the sand — so the coast has a beach and a lighter
      // band of water round it, and the tiles get a sandy seam, with no geometry of their own.
      s('g', {
        attrs: { class: 'shore' },
        children: [
          ...land.map((hex) =>
            s('polygon', { attrs: { class: 'shore-shallows', points: outlineOf(hex) } }),
          ),
          ...land.map((hex) =>
            s('polygon', {
              attrs: { class: 'shore-sand', points: outlineOf(hex), fill: SAND_FILL },
            }),
          ),
        ],
      }),
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
 * The pieces of paint the board reuses. Ids are prefixed `b-` because they land in the
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
      // Pieces stand taller than anything printed on the board, so they cast a longer shadow.
      s('filter', {
        attrs: { id: 'b-stand', x: '-50%', y: '-50%', width: '200%', height: '200%' },
        children: [
          s('feDropShadow', {
            attrs: {
              dx: 0,
              dy: 2.6,
              stdDeviation: 1.8,
              'flood-color': '#000000',
              'flood-opacity': 0.6,
            },
          }),
        ],
      }),
      // One lift, shared by tokens and harbour badges.
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

function outlineOf(hex: HexShape): string {
  return hex.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/**
 * Where a terrain's glyph stands, as fractions of the hex size: one emblem above the token, sized
 * to stay inside the tile's narrowing top (a pointy hex is only half as wide there), flanked by
 * two small tufts, the way a printed tile carries one picture rather than a pattern.
 */
const ART_SLOTS: readonly (readonly [number, number, number])[] = [[0, -0.4, 1.1]];
const TUFTS: readonly (readonly [number, number])[] = [
  [-0.5, -0.12],
  [0.52, 0.05],
];

function hexGroup(hex: HexShape, size: number): SVGElement {
  const style = terrainStyle(hex.terrain);
  const water = hex.class === 'sea';
  const outline = outlineOf(hex);
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

  // Grain, art, then bevel, over the same outline. Land only: the sea is meant to look flat and
  // wet. None carries the `hex` class — `app.test.ts` counts one `.hex` per hex group — and all
  // are transparent to the pointer so the tile's own tooltip and hit area survive underneath.
  if (!water) {
    children.push(
      s('polygon', { attrs: { class: 'hex-grain', points: outline, fill: 'url(#b-grain)' } }),
    );
    const art = hex.terrain === null ? null : terrainArt(hex, size);
    if (art !== null) children.push(art);
    children.push(
      s('polygon', { attrs: { class: 'hex-sheen', points: outline, fill: 'url(#b-sheen)' } }),
    );
    // A terrain nobody has drawn still says what it is.
    if (art === null && hex.terrain !== null) {
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
  }

  hex.tokens.forEach((token, index) => {
    // Spread multiple tokens along the hex's width. The base game never has more than one, but a
    // Traders & Barbarians lake carries four and would otherwise stack them on one spot.
    const spread = hex.tokens.length === 1 ? 0 : (index - (hex.tokens.length - 1) / 2) * size * 0.6;
    // Below the middle, under the terrain's emblem.
    children.push(tokenGroup(hex.center.x + spread, hex.center.y + size * 0.16, size, token));
  });

  // The robber itself is a piece and is drawn in the pieces layer; `blocked` only dims the hex,
  // so a hex is never told twice that production has stopped there.
  return s('g', { attrs: { class: 'hex-group' }, children });
}

/** The terrain's glyph, repeated round the token. `null` when the terrain has no glyph. */
function terrainArt(hex: HexShape, size: number): SVGElement | null {
  const terrain = hex.terrain;
  if (terrain === null || glyph(terrain) === null) return null;
  const unit = size / 24;
  const at = (dx: number, dy: number): string =>
    `${(hex.center.x + dx * size).toFixed(1)} ${(hex.center.y + dy * size).toFixed(1)}`;
  return s('g', {
    attrs: { class: 'hex-art' },
    children: [
      ...TUFTS.map(([dx, dy]) =>
        s('path', {
          attrs: {
            class: 'hex-tuft',
            transform: `translate(${at(dx, dy)})`,
            d: 'M -5 3 Q -4 -2 -6 -5 M -1 3 Q 0 -3 -1 -7 M 3 3 Q 3 -2 5 -5',
          },
        }),
      ),
      ...ART_SLOTS.map(([dx, dy, scale]) =>
        s('g', {
          attrs: {
            transform: `translate(${at(dx, dy)}) scale(${(unit * scale * 0.72).toFixed(3)})`,
          },
          children: glyph(terrain) ?? [],
        }),
      ),
    ],
  });
}

/** A printed number tile: a rounded cream square, the number, and its odds as dots beneath. */
function tokenGroup(x: number, y: number, size: number, token: Token): SVGElement {
  const half = size * 0.3;
  const pips = Array.from({ length: token.pips }, (_, i) => {
    const spacing = half * 0.26;
    const offset = (i - (token.pips - 1) / 2) * spacing;
    return s('circle', {
      attrs: { cx: x + offset, cy: y + half * 0.62, r: half * 0.085, class: 'pip' },
    });
  });
  return s('g', {
    attrs: { class: `token${token.hot ? ' token-hot' : ''}` },
    children: [
      s('rect', {
        attrs: {
          x: x - half,
          y: y - half,
          width: half * 2,
          height: half * 2,
          rx: half * 0.3,
          class: 'token-face',
        },
      }),
      s('text', {
        attrs: { x, y: y + half * 0.3, 'text-anchor': 'middle', class: 'token-value' },
        children: [token.value],
      }),
      ...pips,
    ],
  });
}

// ── Harbours ────────────────────────────────────────────────────────────────────────────────

function dockGroup(dock: DockShape, size: number): SVGElement[] {
  // Each mooring is a jetty: a dark stringer under a run of pale planks, drawn as one dashed
  // stroke so the boards run crosswise however the jetty is angled.
  const out: SVGElement[] = dock.anchors.flatMap((anchor) => {
    const ends = { x1: anchor.x, y1: anchor.y, x2: dock.at.x, y2: dock.at.y };
    return [
      s('line', { attrs: { class: 'dock-pier', ...ends } }),
      s('line', { attrs: { class: 'dock-line', ...ends } }),
    ];
  });

  // The harbour is a ship: a hull, a mast, and a sail carrying the trade — the resource's glyph
  // over its ratio, or a question mark for a harbour that takes any card.
  const style = dock.kind === null ? null : cardStyle(dock.kind);
  const name = style === null ? 'any' : style.label;
  const art = dock.kind === null ? null : glyph(dock.kind);
  const k = (size / 60) * 1.35;
  const { x, y } = dock.at;
  const p = (pairs: readonly (readonly [number, number])[]): string =>
    pairs.map(([px, py]) => `${(x + px * k).toFixed(1)},${(y + py * k).toFixed(1)}`).join(' ');

  out.push(
    s('g', {
      attrs: { class: 'dock' },
      children: [
        s('title', { children: [`${dock.label} harbour — ${name}`] }),
        s('line', {
          attrs: { class: 'dock-mast', x1: x, y1: y - 22 * k, x2: x, y2: y + 12 * k },
        }),
        s('polygon', {
          attrs: {
            class: 'dock-flag',
            points: p([
              [0, -22],
              [10, -20],
              [0, -18],
            ]),
          },
        }),
        s('path', {
          attrs: {
            class: 'dock-hull',
            d: `M ${p([[-17, 10]])} L ${p([[17, 10]])} Q ${p([[15, 20]])} ${p([[8, 21]])} L ${p([[-8, 21]])} Q ${p([[-15, 20]])} ${p([[-17, 10]])} Z`,
          },
        }),
        s('rect', {
          attrs: {
            class: 'dock-face',
            x: x - 13 * k,
            y: y - 18 * k,
            width: 26 * k,
            height: 27 * k,
            rx: 5 * k,
          },
        }),
        art === null
          ? s('text', {
              attrs: { x, y: y - 3 * k, 'text-anchor': 'middle', class: 'dock-kind' },
              children: [dock.kind === null ? '?' : name.charAt(0)],
            })
          : s('g', {
              attrs: {
                class: 'dock-art',
                transform: `translate(${x.toFixed(1)} ${(y - 8 * k).toFixed(1)}) scale(${(0.62 * k).toFixed(3)})`,
              },
              children: art,
            }),
        s('text', {
          attrs: { x, y: y + 6.5 * k, 'text-anchor': 'middle', class: 'dock-ratio' },
          children: [dock.label],
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

  const shapes = shapeFor(piece.kind, size, fill);
  // A pale halo traced round the silhouette, under it. Bright terrain swallowed a bare outline —
  // a red house on hills, a white one on a field — and a halo separates any colour from any tile.
  const halo = shapes[0]?.cloneNode(false) as SVGElement | undefined;
  halo?.setAttribute('class', 'halo');

  return s('g', {
    attrs: { class: `piece piece-${piece.kind}`, id: `piece-${piece.id}`, transform },
    children: halo === undefined ? shapes : [halo, ...shapes],
  });
}

/**
 * A piece on its own, as an inline icon for the buy menu — the same silhouette, halo and shading
 * the board draws, so the tile a player clicks looks like the thing they will get.
 */
export function pieceIcon(kind: string, fill: string, className: string): SVGElement {
  const size = 60;
  const shapes = shapeFor(kind, size, fill);
  const halo = shapes[0]?.cloneNode(false) as SVGElement | undefined;
  halo?.setAttribute('class', 'halo');
  // Roads lie along an edge; in a tile they read better on the diagonal.
  const tilt = kind === 'road' ? 'rotate(-35)' : '';
  return s('svg', {
    attrs: { class: `piece ${className}`, viewBox: '-30 -30 60 60', 'aria-hidden': 'true' },
    children: [
      s('g', {
        attrs: { transform: tilt },
        children: halo === undefined ? shapes : [halo, ...shapes],
      }),
    ],
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
      return settlement(size * 0.34, fill);
    case 'city':
      return city(size * 0.42, fill);
    case 'robber':
      return robber(size * 0.22);
    default:
      return [s('circle', { attrs: { r: size * 0.18, fill, class: 'building' } })];
  }
}

/** A plank with the light catching its upper edge. Slim, so it reads as a road and not a wall. */
function road(r: number, fill: string): SVGElement[] {
  const thickness = r * 0.28;
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
