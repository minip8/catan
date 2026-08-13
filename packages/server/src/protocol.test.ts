/**
 * The parser, fed the things a parser gets fed.
 *
 * The property that matters is total-ness: whatever arrives on the socket, `parseClientMessage`
 * returns a value. Anything else and one malformed frame takes a room down with it.
 */

import { describe, expect, it } from 'vitest';

import { parseClientMessage } from './protocol.js';

function parse(raw: string) {
  return parseClientMessage(raw);
}

describe('parseClientMessage', () => {
  it('reads the three messages a client can send', () => {
    expect(parse('{"t":"join","name":"Ada"}')).toEqual({
      ok: true,
      value: { t: 'join', token: null, name: 'Ada' },
    });
    expect(parse('{"t":"join","token":"abc"}')).toEqual({
      ok: true,
      value: { t: 'join', token: 'abc', name: null },
    });
    expect(parse('{"t":"sync"}')).toEqual({ ok: true, value: { t: 'sync' } });
    expect(parse('{"t":"act","action":{"type":"roll"}}')).toEqual({
      ok: true,
      value: { t: 'act', action: { type: 'roll' } },
    });
  });

  it('passes an action payload through without inspecting it', () => {
    // Which fields an action carries is the ruleset's business, and the engine's readers already
    // treat them as untrusted. A protocol that validated them would have to be updated for every
    // expansion, and would disagree with the engine the first time someone forgot.
    const parsed = parse('{"t":"act","action":{"type":"build","kind":"road","at":"0,0|1,0"}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.t !== 'act') throw new Error('expected an act');
    expect(parsed.value.action).toEqual({ type: 'build', kind: 'road', at: '0,0|1,0' });
  });

  it('refuses what it cannot understand, and never throws', () => {
    const rubbish = [
      '',
      'null',
      '[]',
      '"a string"',
      '42',
      '{',
      '{"t":"chat","text":"hello"}',
      '{"t":42}',
      '{}',
      '{"t":"act"}',
      '{"t":"act","action":null}',
      '{"t":"act","action":[]}',
      '{"t":"act","action":{}}',
      '{"t":"act","action":{"type":""}}',
      '{"t":"act","action":{"type":7}}',
      '{"t":"join","token":7}',
      '{"t":"join","name":""}',
    ];
    for (const raw of rubbish) {
      const parsed = parse(raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('badMessage');
    }
  });

  it('never lets the client name its own seat', () => {
    // There is no seat field on any client message, so a forged one is simply ignored.
    const parsed = parse('{"t":"act","action":{"type":"roll"},"seat":"p3","token":"stolen"}');
    if (!parsed.ok || parsed.value.t !== 'act') throw new Error('expected an act');
    expect(Object.keys(parsed.value)).toEqual(['t', 'action']);
  });
});
