// story #2583 — pins envelope.ts's render output for a fixed sample. Same sample/expected
// shape as connectors/sdk/sprintable-sse.test.ts's formatEnvelopeText pin (moonklabs/sprintable
// repo) and connectors/sdk/test_envelope_format.py (Python side) — cross-repo, so there's no
// automated guard tying them together, but the render rule (order/separators/'unknown'
// fallback) must match. See the repo-boundary note in envelope.ts.
import { test, expect } from 'bun:test'
import { formatEnvelopeText } from './envelope'

test('pinned: full envelope renders in the exact expected shape', () => {
  const out = formatEnvelopeText({
    content: '안녕하세요',
    conversationId: 'conv-abc-123',
    senderName: '송윤재',
    senderId: 'u1',
    senderType: 'human',
    eventKind: 'conversation.message_created',
    ts: '2026-08-12T10:00:00Z',
  })
  expect(out).toBe(
    '[conversation.message_created] 송윤재 (human) · conv=conv-abc-123 · ts=2026-08-12T10:00:00Z\n안녕하세요',
  )
})

test('missing fields render as "unknown", never fabricated', () => {
  const out = formatEnvelopeText({
    content: '본문만', conversationId: 'conv-known', senderName: '누군가',
    senderId: '', senderType: '', eventKind: '', ts: '',
  })
  expect(out.split('unknown').length - 1).toBe(3) // senderType/eventKind/ts만 unknown
  expect(out).toContain('conv=conv-known')
})

test('empty senderName falls back to senderId, then "unknown"', () => {
  const withId = formatEnvelopeText({
    content: 'x', conversationId: 'c', senderName: '', senderId: 'agent-42',
    senderType: '', eventKind: '', ts: '',
  })
  expect(withId.startsWith('[unknown] agent-42 (unknown)')).toBe(true)

  const withoutId = formatEnvelopeText({
    content: 'x', conversationId: 'c', senderName: '', senderId: '',
    senderType: '', eventKind: '', ts: '',
  })
  expect(withoutId.startsWith('[unknown] unknown (unknown)')).toBe(true)
})

test('misaddressing scenario blocked — sender never leaks across two renders', () => {
  const first = formatEnvelopeText({
    content: '통신점검', conversationId: 'conv-1', senderName: '페드루 올리베이라',
    senderId: 'p1', senderType: 'agent', eventKind: 'conversation.message_created',
    ts: '2026-08-12T09:00:00Z',
  })
  const second = formatEnvelopeText({
    content: '이거 다시 봐줘', conversationId: 'conv-1', senderName: '송윤재',
    senderId: 'u1', senderType: 'human', eventKind: 'conversation.message_created',
    ts: '2026-08-12T09:05:00Z',
  })
  expect(second).not.toContain('페드루 올리베이라')
  const [headerLine, bodyLine] = second.split('\n')
  expect(headerLine).toContain('송윤재')
  expect(bodyLine).toBe('이거 다시 봐줘')
})
