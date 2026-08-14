/**
 * story #2622 — pure resolution logic for reply()'s target conversation, extracted
 * from server.ts for unit testability (server.ts boots a live MCP stdio server as a
 * module-scope side effect on import, so this logic can't be exercised in place).
 *
 * Root cause this closes: reply() used to attribute every send to a single
 * process-global `latestInboundMeta` (last-write-wins across ALL inbound channels),
 * so if channel B delivered an event between the model reading channel A's message
 * and calling reply(), the reply silently went to B. Real damage (2026-08-13):
 * Kadir's 4 work reports (06:24~06:36, intended for the PO channel) were misrouted
 * to the teacher's channel this way.
 *
 * Fix: reply() can now pass back the `chat_id` it saw on the inbound <channel> tag
 * (== conversationId/thread_id) to target that exact conversation explicitly,
 * regardless of what else arrived afterward. Omitting chat_id keeps the old
 * latestInboundMeta fallback (no regression for single-channel usage).
 */

export type InboundMeta = {
  threadId: string
  replyCallbackUrl: string
  replyCallbackApiKey: string
  ts: number
}

const INBOUND_META_TTL_MS = 300_000
const INBOUND_META_PRUNE_THRESHOLD = 1000

/** _seen(중복 이벤트 감지)과 동형 청소 관례 — size 임계를 넘을 때만 순회해 TTL 지난 것 제거. */
export function pruneInboundMeta(map: Map<string, InboundMeta>, now: number = Date.now()): void {
  if (map.size <= INBOUND_META_PRUNE_THRESHOLD) return
  for (const [k, v] of map) {
    if (now - v.ts > INBOUND_META_TTL_MS) map.delete(k)
  }
}

export type ReplyTargetResult = { ok: true; meta: InboundMeta } | { ok: false; error: string }

/**
 * chat_id 지정 시: inboundMeta에서 정확 조회 — 없으면 침묵 폴백(=오배송 재발) 대신 명시
 * 에러를 반환한다(성실한 오독에서도 서야 하는 도구가, "몰랐다"로 다른 대화에 새는 것을
 * 막는다). chat_id 미지정 시: 기존 동작 그대로 latestInboundMeta 폴백(무회귀).
 */
export function resolveReplyTarget(
  inboundMeta: Map<string, InboundMeta>,
  latestInboundMeta: InboundMeta | undefined,
  chatId: string | undefined,
): ReplyTargetResult {
  if (chatId) {
    const meta = inboundMeta.get(chatId)
    if (!meta) {
      return {
        ok: false,
        error:
          `no recent inbound message found for chat_id=${chatId} (may have expired — ` +
          'entries are pruned after 300s of inactivity — or this chat_id never sent to this session)',
      }
    }
    return { ok: true, meta }
  }
  if (!latestInboundMeta) return { ok: false, error: 'no active conversation' }
  return { ok: true, meta: latestInboundMeta }
}
