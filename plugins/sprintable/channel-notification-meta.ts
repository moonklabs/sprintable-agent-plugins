/**
 * story #3c7968ee(2026-08-14, PO 라이브 실측) — `notifications/claude/channel`의 `meta`는
 * 하니스가 **값 전부 문자열**로 검증한다(채널 태그 attribute로 그대로 렌더되는 자리 —
 * `<channel chat_id="..." attachment_count="...">`, XML attribute는 string이어야 함). story
 * #2649가 `attachment_count`(number)·`attachments`(array)를 그대로 실어 ProtocolError로
 * STDIO 알림 자체가 드롭됐다 — "첨부 있는 그 메시지만" 통째로 유실되는 역설(드롭 방지
 * fix가 드롭을 만들었다). 이 함수가 그 직렬화를 전담해 타입 위반이 다시 새지 않게 한다.
 *
 * server.ts는 mcp.connect()를 모듈 스코프 부수효과로 실행해 직접 테스트 불가라 여기로 추출
 * (reply-target.ts/attachment-meta.ts와 같은 이유).
 */
import type { AttachmentMeta } from './attachment-meta'

export type ChannelNotificationMeta = Record<string, string>

/**
 * [SID:4196] 채팅 메시지 이벤트면 그 «채팅 메시지 id»를, 아니면 undefined.
 * 게이트웨이 SSE의 최상위 `event_id`는 이벤트 행 id(수신자마다 다름)라 `get_chat_message`로 조회하면
 * NOT_FOUND다(2026-09-23 실측). 채팅 메시지 이벤트(`source.type == "conversation_message"`)는 엔티티
 * 참조 `source.id`가 정본이고, 없으면 `payload.id`(`_msg_payload`의 msg.id)로 폴백한다. 채팅이 아닌
 * 이벤트는 message_id라는 이름으로 실을 값이 없다 — 이벤트 id를 그 이름으로 싣는 것이 이 결함이었다.
 */
export function chatMessageIdOf(data: Record<string, unknown>): string | undefined {
  const source = data.source
  if (typeof source !== 'object' || source === null) return undefined
  const s = source as Record<string, unknown>
  if (s.type !== 'conversation_message') return undefined
  const nonEmpty = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const payload = data.payload
  const payloadId =
    typeof payload === 'object' && payload !== null ? nonEmpty((payload as Record<string, unknown>).id) : undefined
  return nonEmpty(s.id) ?? payloadId
}

export function buildChannelNotificationMeta(params: {
  threadId?: string
  /** 이벤트 id(중복 제거 키와 같은 값) — 모든 알림에 `event_id`로 싣는다. */
  eventId: string
  /** 채팅 메시지 id — 채팅 메시지 이벤트일 때만. 없으면 `message_id` 속성 자체를 안 싣는다. */
  messageId?: string
  user?: string
  attachments?: AttachmentMeta[]
}): ChannelNotificationMeta {
  const meta: ChannelNotificationMeta = {
    chat_id: params.threadId ?? 'sprintable',
    user: params.user ?? 'sprintable',
    ts: new Date().toISOString(),
    event_id: params.eventId,
  }
  if (params.messageId) meta.message_id = params.messageId
  if (params.attachments && params.attachments.length > 0) {
    meta.attachment_count = String(params.attachments.length)
    meta.attachments = JSON.stringify(params.attachments)
  }
  if (params.threadId) meta.thread_id = params.threadId
  return meta
}
