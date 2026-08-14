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

export function buildChannelNotificationMeta(params: {
  threadId?: string
  messageId: string
  user?: string
  attachments?: AttachmentMeta[]
}): ChannelNotificationMeta {
  const meta: ChannelNotificationMeta = {
    chat_id: params.threadId ?? 'sprintable',
    message_id: params.messageId,
    user: params.user ?? 'sprintable',
    ts: new Date().toISOString(),
  }
  if (params.attachments && params.attachments.length > 0) {
    meta.attachment_count = String(params.attachments.length)
    meta.attachments = JSON.stringify(params.attachments)
  }
  if (params.threadId) meta.thread_id = params.threadId
  return meta
}
