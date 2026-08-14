/**
 * story #2646(디디 그라운딩, 2026-08-14) — this plugin's `_onEvent()` never read
 * `payload.attachments` at all: the backend's `_msg_payload()` (moonklabs/sprintable,
 * app/routers/conversations.py) already carries {url, name, content_type, size,
 * asset_id, width, height} on every SSE event for a message with attachments, but
 * this plugin dropped it unconditionally, and `deliver()` was always called with
 * `file=undefined`. Worse: a message with attachments but no text content was
 * treated as "nothing visible" and the whole event was silently ack'd and dropped
 * — an attachment-only message vanished completely.
 *
 * This module only surfaces DISCOVERY metadata (name/type/size, matching the
 * Discord channel plugin's attachment_count/attachments convention already known
 * to models using this session) — not a download path. `url` is intentionally
 * dropped here: fetching the actual bytes requires a signed URL, and no
 * agent-callable signing path exists anywhere in the system right now (the
 * Next.js `/api/attachments/sign` route is browser-session-gated only — see
 * story f953720d, filed separately, backend/FE scope). Building a download tool
 * on top of that would always fail — surfacing the raw GCS object path here would
 * just be unusable noise (and a minor path-exposure smell), so it stays out until
 * that gap closes.
 */
export type AttachmentMeta = {
  name: string
  type: string
  size: number
}

/**
 * SSE payload.attachments(신뢰 안 하는 JSON)를 채널 태그 표시용 최소 메타로 정제.
 * 배열이 아니거나 항목이 object가 아니면 스킵, 필드 누락/타입 불일치는 안전한 기본값 —
 * 서버가 형태를 보장하지 않아도(레거시 첨부·부분 필드) 죽지 않는다.
 */
export function sanitizeAttachments(raw: unknown): AttachmentMeta[] {
  if (!Array.isArray(raw)) return []
  const out: AttachmentMeta[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const a = item as Record<string, unknown>
    out.push({
      name: typeof a.name === 'string' && a.name ? a.name : 'attachment',
      type: typeof a.content_type === 'string' && a.content_type ? a.content_type : 'application/octet-stream',
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0,
    })
  }
  return out
}

/** content가 비어도(첨부만 있는 메시지) 완전 빈 본문으로 보이지 않게 하는 표시용 문구. */
export function attachmentPlaceholderText(attachments: AttachmentMeta[]): string {
  return `(${attachments.length} attachment${attachments.length === 1 ? '' : 's'})`
}
