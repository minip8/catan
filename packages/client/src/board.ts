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
 */

import type { LocusId } from '@catan/core';

import { s } from './dom.js';
import type { DockShape, HexShape, PieceShape, Scene, TargetShape, Token } from './scene.js';
import { cardStyle, SEA_FILL, seatStyle, terrainStyle } from './theme.js';

export interface BoardHandlers {
  readonly onTarget: (locus: LocusId, event: MouseEvent) => void;
}

export function boardSvg(scene: Scene, handlers: BoardHandlers): SVGElement {
  return s('svg', {
    attrs: {
      class: 'board',
      viewBox: scene.viewBox,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Game board',
    },
    children: [
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

// ── Hexes ───────────────────────────────────────────────────────────────────────────────────

function hexGroup(hex: HexShape, size: number): SVGElement {
  const style = terrainStyle(hex.terrain);
  const water = hex.class === 'sea';
  const children: SVGElement[] = [
    s('polygon', {
      attrs: {
        class: `hex hex-${hex.class}${hex.blocked ? ' hex-blocked' : ''}`,
        points: hex.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        fill: water ? SEA_FILL : style.fill,
      },
      children: [s('title', { children: [water ? 'Sea' : style.label] })],
    }),
  ];

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
  const out: SVGElement[] = dock.anchors.map((anchor) =>
    s('line', {
      attrs: {
        class: 'dock-line',
        x1: anchor.x,
        y1: anchor.y,
        x2: dock.at.x,
        y2: dock.at.y,
      },
    }),
  );
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
    children: [shapeFor(piece.kind, size, fill)],
  });
}

/** The drawn form of a piece. Unknown kinds get a disc, which is better than nothing. */
function shapeFor(kind: string, size: number, fill: string): SVGElement {
  switch (kind) {
    case 'road':
      return s('rect', {
        attrs: {
          x: -size * 0.4,
          y: -size * 0.08,
          width: size * 0.8,
          height: size * 0.16,
          rx: size * 0.05,
          fill,
          class: 'road',
        },
      });
    case 'settlement':
      return s('polygon', {
        attrs: { points: house(size * 0.3), fill, class: 'building' },
      });
    case 'city':
      return s('polygon', {
        attrs: { points: tower(size * 0.36), fill, class: 'building' },
      });
    case 'robber':
      return s('circle', { attrs: { r: size * 0.2, fill: '#26221f', class: 'robber' } });
    default:
      return s('circle', { attrs: { r: size * 0.18, fill, class: 'building' } });
  }
}

/** A gabled house, centred on the origin. */
function house(r: number): string {
  return points([
    [-r, r * 0.6],
    [-r, -r * 0.2],
    [0, -r],
    [r, -r * 0.2],
    [r, r * 0.6],
  ]);
}

/** A house with a taller wing — the city silhouette. */
function tower(r: number): string {
  return points([
    [-r, r * 0.55],
    [-r, -r * 0.25],
    [-r * 0.45, -r * 0.85],
    [0, -r * 0.25],
    [0, -r * 0.55],
    [r * 0.5, -r * 0.55],
    [r, -r * 0.05],
    [r, r * 0.55],
  ]);
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
