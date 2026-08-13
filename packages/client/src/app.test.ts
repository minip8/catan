// @vitest-environment jsdom

/**
 * The client, played.
 *
 * Everything else in this package is tested as data; this file is the one that actually mounts the
 * app, clicks the board and reads the DOM back. It exists because the failures it catches are the
 * ones data tests cannot see — a panel that throws on an empty hand, a listener attached to an
 * element that gets replaced on the next render, a seat switch that shows the wrong player's cards.
 *
 * The last of those is the important one. A hot-seat client is the first place redaction can leak,
 * because every seat's view is one click away from every other, so the test below plays the
 * opening and then checks that switching seats really does change what is on the screen.
 */

import { describe, expect, it } from 'vitest';

import { App } from './app.js';

function mount(seed = 11, players = 4): { app: App; root: HTMLElement } {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app');
  if (root === null) throw new Error('mount: no root');
  const app = new App(root, { seed, players });
  app.render();
  return { app, root };
}

function click(el: Element | null | undefined): void {
  if (el === null || el === undefined) throw new Error('click: no such element');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/** The first button whose label contains `label`. */
function button(root: HTMLElement, label: string): HTMLElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label));
}

function texts(root: HTMLElement, selector: string): readonly string[] {
  return [...root.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

/**
 * Add one card of `kind` to row `row` of the draft form.
 *
 * Re-queried on every call: each edit re-renders the panel, so a node held from before the last
 * click is detached and its handler closes over a stale draft.
 */
function bump(root: HTMLElement, row: number, kind: string): void {
  const rows = [...root.querySelectorAll('.stepper-row')];
  const stepper = [...(rows[row]?.querySelectorAll('.stepper') ?? [])].find(
    (el) => el.querySelector('.stepper-name')?.textContent === kind,
  );
  const buttons = stepper?.querySelectorAll('.step');
  click(buttons?.[buttons.length - 1]);
}

/** Click through the opening placements, taking whatever spot is offered first. */
function playOpening(root: HTMLElement, placements = 16): void {
  for (let i = 0; i < placements; i++) {
    const target = root.querySelector('.target');
    if (target === null) return;
    click(target);
  }
}

describe('App', () => {
  it('draws the dealt board', () => {
    const { root } = mount();

    expect(root.querySelectorAll('.hex').length).toBe(root.querySelectorAll('.hex-group').length);
    expect(root.querySelectorAll('.hex-land').length).toBe(19);
    expect(root.querySelectorAll('.token').length).toBe(18);
    expect(root.querySelectorAll('.dock').length).toBe(9);
    expect(root.querySelectorAll('.piece-robber').length).toBe(1);
    expect(root.querySelector('.status')?.textContent).toBe('Opening placement — Red');
  });

  it('offers the opening settlement as spots on the board, and builds one when clicked', () => {
    const { root } = mount();
    expect(root.querySelectorAll('.target').length).toBeGreaterThan(20);
    expect(root.querySelectorAll('.piece-settlement').length).toBe(0);

    click(root.querySelector('.target'));

    expect(root.querySelectorAll('.piece-settlement').length).toBe(1);
    // A settlement is down, so the same step now wants the road that touches it.
    expect(root.querySelector('.status')?.textContent).toBe('Opening placement — Red');
    expect(root.querySelectorAll('.target').length).toBeLessThan(4);
    expect(texts(root, '.log-line').join(' ')).toContain('Red builds a Settlement');
  });

  it('plays the whole opening and arrives at the first roll', () => {
    const { root } = mount();
    playOpening(root);

    expect(root.querySelectorAll('.piece-settlement').length).toBe(8);
    expect(root.querySelectorAll('.piece-road').length).toBe(8);
    expect(root.querySelector('.status')?.textContent).toBe('Roll the dice — Red');

    const roll = button(root, 'Roll the dice');
    expect(roll).toBeDefined();
    click(roll);
    expect(texts(root, '.log-line').join(' ')).toContain('Red rolled');
  });

  it('follows the hot seat, and shows each seat only its own hand', () => {
    const { root } = mount();
    playOpening(root);

    // The opening grants starting resources, so every seat holds cards by now.
    const red = texts(root, '.card-chip').join(' ');
    expect(red).not.toBe('');

    click(button(root, 'Blue'));
    expect(root.querySelector('.status')?.textContent).toBe('Roll the dice — Red');
    const blue = texts(root, '.card-chip').join(' ');
    expect(blue).not.toBe(red);
    // Blue is not the one being waited on, so there is nothing for them to do.
    expect(root.querySelector('.panel')?.textContent).toContain('Waiting for Red');

    click(button(root, 'Spectator'));
    expect(root.textContent).toContain('Spectators hold no cards');
  });

  it('shows a development card to its owner and not to the table', () => {
    // Seed 8's opening leaves the first player able to afford a card on turn one, which is what
    // this test needs and what most seeds do not give.
    const { root } = mount(8);
    playOpening(root);
    click(button(root, 'Roll the dice'));

    const buy = button(root, 'Buy a development card');
    expect(buy).toBeDefined();
    click(buy);

    const owner = texts(root, '.dev').join(' ');
    expect(owner).not.toContain('Hidden');

    click(button(root, 'Spectator'));
    expect(texts(root, '.dev')).toEqual([]);
  });

  it('composes the one action the engine cannot enumerate', () => {
    const { root } = mount();
    playOpening(root);
    click(button(root, 'Roll the dice'));

    // A trade offer is any bundle for any bundle, so the engine offers the *shape* and the client
    // builds the action. This is the only path in the app that does that.
    click(button(root, 'Compose'));
    expect(root.querySelectorAll('.stepper-row')).toHaveLength(2);
    expect(root.textContent).toContain('You give');
    expect(root.textContent).toContain('You want');

    // The give side clamps to what the player actually holds, so asking for one of everything
    // yields one of each card they have.
    for (const kind of ['Brick', 'Lumber', 'Ore', 'Grain', 'Wool']) bump(root, 0, kind);
    bump(root, 1, 'Brick');
    expect(root.querySelector('.draft-head')?.textContent).not.toContain('nothing');

    click(button(root, 'Offer'));
    expect(root.querySelector('.status')?.textContent).toContain('Trade offer');
    expect(texts(root, '.log-line').join(' ')).toContain('Red offers');
  });

  it('keeps the board clickable across re-renders', () => {
    const { root } = mount();
    click(root.querySelector('.target'));
    const before = root.querySelectorAll('.piece').length;

    // The whole tree is replaced on every render, so a listener bound to a stale node would make
    // the second click do nothing at all.
    click(root.querySelector('.target'));
    expect(root.querySelectorAll('.piece').length).toBe(before + 1);
  });

  it('says nothing about rules it was not offered', () => {
    const { root } = mount();
    // Before anyone has placed, there is no roll, no build and no trade on offer — the engine
    // said so, and the client invents nothing.
    expect(button(root, 'Roll the dice')).toBeUndefined();
    expect(button(root, 'End turn')).toBeUndefined();
    expect(button(root, 'Offer')).toBeUndefined();
  });
});
