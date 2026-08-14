/**
 * story #3c7968ee — pins the exact incident: attachment_count/attachments must serialize to
 * strings, not survive as number/array (which the harness rejects with a ProtocolError that
 * drops the whole notification over STDIO — the message vanishes, not just the attachment).
 */
import { describe, test, expect } from 'bun:test'
import { buildChannelNotificationMeta } from './channel-notification-meta'

function allValuesAreStrings(meta: Record<string, unknown>): boolean {
  return Object.values(meta).every(v => typeof v === 'string')
}

describe('buildChannelNotificationMeta (#3c7968ee)', () => {
  test('every meta value is a string when attachments are present (the exact incident shape)', () => {
    const meta = buildChannelNotificationMeta({
      threadId: 'conv-1',
      messageId: 'msg-1',
      user: 'someone',
      attachments: [{ name: 'image.png', type: 'image/png', size: 70 }],
    })
    expect(allValuesAreStrings(meta)).toBe(true)
    expect(meta.attachment_count).toBe('1')
    expect(typeof meta.attachments).toBe('string')
    expect(JSON.parse(meta.attachments)).toEqual([{ name: 'image.png', type: 'image/png', size: 70 }])
  })

  test('every meta value is a string with no attachments too (baseline invariant)', () => {
    const meta = buildChannelNotificationMeta({ threadId: 'conv-1', messageId: 'msg-1' })
    expect(allValuesAreStrings(meta)).toBe(true)
  })

  test('no attachments: attachment_count/attachments keys are absent entirely', () => {
    const meta = buildChannelNotificationMeta({ threadId: 'conv-1', messageId: 'msg-1', attachments: [] })
    expect(meta).not.toHaveProperty('attachment_count')
    expect(meta).not.toHaveProperty('attachments')
  })

  test('multiple attachments: count matches array length, all still strings', () => {
    const meta = buildChannelNotificationMeta({
      threadId: 'conv-1', messageId: 'msg-1',
      attachments: [
        { name: 'a.png', type: 'image/png', size: 1 },
        { name: 'b.pdf', type: 'application/pdf', size: 2 },
      ],
    })
    expect(meta.attachment_count).toBe('2')
    expect(allValuesAreStrings(meta)).toBe(true)
    expect(JSON.parse(meta.attachments)).toHaveLength(2)
  })

  test('missing threadId falls back to "sprintable" for both chat_id and no thread_id key', () => {
    const meta = buildChannelNotificationMeta({ messageId: 'msg-1' })
    expect(meta.chat_id).toBe('sprintable')
    expect(meta).not.toHaveProperty('thread_id')
    expect(allValuesAreStrings(meta)).toBe(true)
  })

  test('missing user falls back to "sprintable"', () => {
    const meta = buildChannelNotificationMeta({ threadId: 'c', messageId: 'm' })
    expect(meta.user).toBe('sprintable')
  })
})
