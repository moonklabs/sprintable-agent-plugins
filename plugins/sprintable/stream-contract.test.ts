// story 4788 (INFRA-DIET ③) — the plugin declares what it acts on, and does not ack what it drops.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { INJECTABLE_EVENT_TYPES } from './inject-allowlist'
import { ACCEPT_EVENTS_HEADER, acceptEventsHeaderValue } from './stream-contract'

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
  test('an event the plugin does not act on is still dropped without an ack (the ack is cumulative per agent — see stream-contract.ts)', () => {
    // the one-line form: a block here (where an ack could be added) would not match this exact line
    expect(src).toContain('  if (!isInjectableEventType(data, payload)) return\n')
    const at = src.indexOf('if (!isInjectableEventType(data, payload)) return')
    expect(src.slice(at, at + 400)).not.toContain('_sendAck')
  })
})
