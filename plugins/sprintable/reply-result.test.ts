/** story #4430 — pins the `reply` tool result: `sent` alone unless the send answer says a block withheld the message. */
import { describe, test, expect } from 'bun:test'
import { replyResultText } from './reply-result'

describe('replyResultText (#4430)', () => {
  test('nothing withheld: exactly `sent`, the same as before', () => {
    expect(replyResultText({ data: { id: 'm1' } })).toBe('sent')
    expect(replyResultText({})).toBe('sent')
    expect(replyResultText(null)).toBe('sent')
    expect(replyResultText('not json')).toBe('sent')
  })

  test('1:1 blocked: `sent` then the 1:1 line', () => {
    const answer = { data: { id: 'm1' }, delivery: { withheld_count: 1, reason: 'recipient_blocked_sender', conversation_type: 'dm' } }
    expect(replyResultText(answer)).toBe('sent\nnot delivered: the recipient has blocked this sender')
  })

  test('group, two blocked: `sent` then the count line (never who)', () => {
    const answer = { data: { id: 'm1' }, delivery: { withheld_count: 2, reason: 'recipient_blocked_sender', conversation_type: 'group' } }
    expect(replyResultText(answer)).toBe('sent\nnot delivered to 2 recipient(s): they have blocked this sender')
  })

  test('no conversation type: the group line, true for any count', () => {
    const answer = { delivery: { withheld_count: 1, reason: 'recipient_blocked_sender' } }
    expect(replyResultText(answer)).toBe('sent\nnot delivered to 1 recipient(s): they have blocked this sender')
  })

  test('the first line is always `sent` on its own', () => {
    for (const d of [undefined, { withheld_count: 1, conversation_type: 'dm' }, { withheld_count: 3 }]) {
      expect(replyResultText({ delivery: d }).split('\n')[0]).toBe('sent')
    }
  })

  test('a count that is not a positive integer is treated as nothing withheld', () => {
    for (const n of [0, -1, 1.5, '2', null]) {
      expect(replyResultText({ delivery: { withheld_count: n, conversation_type: 'dm' } })).toBe('sent')
    }
  })
})
