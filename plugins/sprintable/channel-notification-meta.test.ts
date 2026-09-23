/**
 * story #3c7968ee — pins the exact incident: attachment_count/attachments must serialize to
 * strings, not survive as number/array (which the harness rejects with a ProtocolError that
 * drops the whole notification over STDIO — the message vanishes, not just the attachment).
 */
import { describe, test, expect } from 'bun:test'
import { buildChannelNotificationMeta, chatMessageIdOf } from './channel-notification-meta'
import { readFileSync } from 'fs'
import { join } from 'path'

function allValuesAreStrings(meta: Record<string, unknown>): boolean {
  return Object.values(meta).every(v => typeof v === 'string')
}

describe('buildChannelNotificationMeta (#3c7968ee)', () => {
  test('every meta value is a string when attachments are present (the exact incident shape)', () => {
    const meta = buildChannelNotificationMeta({
      threadId: 'conv-1',
      eventId: 'ev-1',
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
    const meta = buildChannelNotificationMeta({ threadId: 'conv-1', eventId: 'ev-1' })
    expect(allValuesAreStrings(meta)).toBe(true)
  })

  test('no attachments: attachment_count/attachments keys are absent entirely', () => {
    const meta = buildChannelNotificationMeta({ threadId: 'conv-1', eventId: 'ev-1', attachments: [] })
    expect(meta).not.toHaveProperty('attachment_count')
    expect(meta).not.toHaveProperty('attachments')
  })

  test('multiple attachments: count matches array length, all still strings', () => {
    const meta = buildChannelNotificationMeta({
      threadId: 'conv-1', eventId: 'ev-1',
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
    const meta = buildChannelNotificationMeta({ eventId: 'ev-1' })
    expect(meta.chat_id).toBe('sprintable')
    expect(meta).not.toHaveProperty('thread_id')
    expect(allValuesAreStrings(meta)).toBe(true)
  })

  test('missing user falls back to "sprintable"', () => {
    const meta = buildChannelNotificationMeta({ threadId: 'c', eventId: 'e' })
    expect(meta.user).toBe('sprintable')
  })
})

/**
 * [SID:4196] meta.message_id는 «채팅 메시지 id»만 — 게이트웨이 SSE의 event_id(이벤트 행 id, 수신자마다
 * 다름)를 그 이름으로 싣던 결함(get_chat_message NOT_FOUND, 2026-09-23 실측). 샘플은 백엔드
 * `agent_gateway._row_to_payload` 모양 그대로(event_id·event_type·source{type,id}·payload).
 */
describe('채널 meta의 message_id = 채팅 메시지 id (#4196)', () => {
  const EVENT_ID = '7ee38c6a-f7d5-47b5-a33e-fd3ee4bf4b26'
  const MSG_ID = '723a3ac2-0239-4091-a4c6-7ed895527cc6'
  const chatSample = {
    event_id: EVENT_ID,
    event_type: 'conversation.message_created',
    recipient_seq: 12,
    source: { type: 'conversation_message', id: MSG_ID },
    sender_id: 'sender-1',
    payload: { id: MSG_ID, conversation_id: 'conv-1', content: 'hi', sender: { id: 'sender-1', name: 'PO', type: 'human' } },
  }
  const storySample = {
    event_id: 'ev-story-1',
    event_type: 'preset.work.status_changed',
    recipient_seq: 13,
    source: { type: 'story', id: 'story-1' },
    payload: { id: 'story-1', work_item_type: 'story', to_status: 'done' },
  }

  test('채팅 샘플: source.id와 payload.id는 같은 채팅 메시지 id이고 event_id와는 다르다(샘플 전제)', () => {
    expect(chatSample.source.id).toBe(chatSample.payload.id)
    expect(chatSample.source.id).not.toBe(chatSample.event_id)
  })

  test('채팅 메시지 이벤트 → source.id', () => {
    expect(chatMessageIdOf(chatSample)).toBe(MSG_ID)
  })

  test('source.id가 비면 payload.id로 폴백', () => {
    expect(chatMessageIdOf({ ...chatSample, source: { type: 'conversation_message', id: '' } })).toBe(MSG_ID)
    expect(chatMessageIdOf({ ...chatSample, source: { type: 'conversation_message' } })).toBe(MSG_ID)
  })

  test('채팅이 아닌 이벤트·source 없음 → undefined(payload.id가 있어도)', () => {
    expect(chatMessageIdOf(storySample)).toBeUndefined()
    const { source: _omit, ...noSource } = chatSample
    expect(chatMessageIdOf(noSource)).toBeUndefined()
    expect(chatMessageIdOf({ ...chatSample, source: null })).toBeUndefined()
  })

  test('meta: 채팅 → message_id = 채팅 id · event_id = 이벤트 id(둘이 다름)', () => {
    const meta = buildChannelNotificationMeta({
      threadId: 'conv-1', eventId: chatSample.event_id, messageId: chatMessageIdOf(chatSample),
    })
    expect(meta.message_id).toBe(MSG_ID)
    expect(meta.event_id).toBe(EVENT_ID)
    expect(allValuesAreStrings(meta)).toBe(true)
  })

  test('meta: 채팅이 아니면 message_id 속성 자체가 없고 event_id만', () => {
    const meta = buildChannelNotificationMeta({ eventId: storySample.event_id, messageId: chatMessageIdOf(storySample) })
    expect(meta).not.toHaveProperty('message_id')
    expect(meta.event_id).toBe('ev-story-1')
    expect(allValuesAreStrings(meta)).toBe(true)
  })

  test('server.ts 배선: 중복 제거 키는 이벤트 id 그대로 · meta message_id는 chatMessageIdOf에서만', () => {
    const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8').replace(/\s+/g, ' ')
    expect(src).toContain('const eventId = (data.event_id ?? payload.id ?? evId ?? crypto.randomUUID()) as string')
    expect(src).toContain('if (_isDuplicate(eventId)) return')
    expect(src).toContain('const chatMessageId = chatMessageIdOf(data)')
    expect(src).toContain('eventId: id, messageId: meta?.message_id,')
    // 이벤트 id를 message_id 이름으로 넘기는 자리가 다시 생기면 RED.
    expect(src).not.toContain('messageId: id')
    expect(src).not.toMatch(/messageId: `channel-down-/)
  })
})
