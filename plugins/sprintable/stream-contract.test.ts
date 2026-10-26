// story 4788 (INFRA-DIET ③) — the plugin declares what it acts on, and does not ack what it drops.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { INJECTABLE_EVENT_TYPES } from './inject-allowlist'
import { ACCEPT_EVENTS_HEADER, acceptEventsHeaderValue, advanceLastEventId } from './stream-contract'

describe('the declaration', () => {
  test('is the allow-list, sorted, one header', () => {
    const value = acceptEventsHeaderValue()
    expect(value.split(', ')).toEqual([...INJECTABLE_EVENT_TYPES].sort())
    expect(value).toBe(acceptEventsHeaderValue()) // the same bytes on every connect
    expect(ACCEPT_EVENTS_HEADER).toBe('X-Sprintable-Accept-Events')
  })
  test('every type in it is one the server accepts as a token (letters, digits, _ . : -)', () => {
    for (const t of acceptEventsHeaderValue().split(', ')) expect(/^[A-Za-z0-9_.:-]{1,64}$/.test(t)).toBe(true)
  })
  test('at most the 32 the server reads', () => {
    expect(INJECTABLE_EVENT_TYPES.size).toBeLessThanOrEqual(32)
  })
})

describe('the wiring in server.ts (a source pin — the stream loop is a script, not a function)', () => {
  const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  test('the stream request carries the declaration', () => {
    expect(src).toContain('headers[ACCEPT_EVENTS_HEADER] = acceptEventsHeaderValue()')
  })
  test('an event the plugin does not act on is still dropped without an ack (the ack is cumulative per agent — see stream-contract.ts) but moves Last-Event-ID past it', () => {
    const open = 'if (!isInjectableEventType(data, payload)) {'
    expect(src).toContain(open)
    const at = src.indexOf(open)
    const block = src.slice(at, src.indexOf('\n  }\n', at) + 5)
    expect(block).toContain('_lastEventId = advanceLastEventId(_lastEventId, evId)')
    expect(block).toContain('return')
    expect(block).not.toContain('_sendAck')
    // and the move comes before the return of the block, not after a path that can leave early
    expect(block.indexOf('advanceLastEventId')).toBeLessThan(block.lastIndexOf('return'))
  })
  test('the connect sends it as Last-Event-ID', () => {
    expect(src).toContain("if (_lastEventId) headers['Last-Event-ID'] = _lastEventId")
  })
})

describe('Last-Event-ID moves past an event the plugin drops (AC3)', () => {
  test('forward only', () => {
    expect(advanceLastEventId('', '10')).toBe('10')
    expect(advanceLastEventId('10', '25')).toBe('25')
    expect(advanceLastEventId('25', '10')).toBe('25') // never back
    expect(advanceLastEventId('25', '25')).toBe('25')
  })
  test('compares numbers, not strings', () => {
    expect(advanceLastEventId('9', '10')).toBe('10')
    expect(advanceLastEventId('100', '99')).toBe('100')
  })
  test('an id it cannot read changes nothing', () => {
    for (const bad of ['', 'abc', '0', '-3', 'NaN', 'Infinity']) expect(advanceLastEventId('7', bad)).toBe('7')
    expect(advanceLastEventId('', '')).toBe('')
    for (const bad of ['0', '-3', 'abc']) expect(advanceLastEventId('', bad)).toBe('') // (nothing seen yet: still nothing)
  })
  test('a reconnect after a tail of dropped events asks only for what is after it', () => {
    // 120 dropped events (seq 6..125) after the last one acted on (5): the cursor ends at 125, so the server resumes after it
    let cursor = '5'
    for (let seq = 6; seq <= 125; seq++) cursor = advanceLastEventId(cursor, String(seq))
    expect(cursor).toBe('125')
  })
})
