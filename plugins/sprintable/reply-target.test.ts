/**
 * story #2622 — pins reply-target.ts's routing/pruning behavior, including the
 * exact cross-channel misdelivery scenario from the real 2026-08-13 incident
 * (Kadir's PO-channel reports leaking to the teacher's channel).
 */
import { describe, test, expect } from 'bun:test'
import { pruneInboundMeta, resolveReplyTarget, type InboundMeta } from './reply-target'

function makeMeta(threadId: string, ts: number): InboundMeta {
  return {
    threadId,
    replyCallbackUrl: `https://app.sprintable.ai/api/v2/conversations/${threadId}/messages`,
    replyCallbackApiKey: 'k',
    ts,
  }
}

describe('resolveReplyTarget (#2622)', () => {
  test('no chat_id: falls back to latestInboundMeta (legacy single-channel behavior, no regression)', () => {
    const inbound = new Map<string, InboundMeta>()
    const latest = makeMeta('chat-A', 100)
    const result = resolveReplyTarget(inbound, latest, undefined)
    expect(result).toEqual({ ok: true, meta: latest })
  })

  test('no chat_id and no latestInboundMeta ever received: explicit error, not a crash', () => {
    const inbound = new Map<string, InboundMeta>()
    const result = resolveReplyTarget(inbound, undefined, undefined)
    expect(result).toEqual({ ok: false, error: 'no active conversation' })
  })

  test('explicit chat_id targets that conversation even though a DIFFERENT channel arrived more recently', () => {
    // 실피해 재현: PO채널(A) 메시지 수신 → 모델이 reply 호출 전에 선생님채널(B) 메시지 도착
    // → latestInboundMeta는 B로 덮어써진다. chat_id="A"를 명시하면 여전히 A로 간다.
    const inbound = new Map<string, InboundMeta>()
    const metaA = makeMeta('po-channel', 100)
    const metaB = makeMeta('teacher-channel', 200)
    inbound.set('po-channel', metaA)
    inbound.set('teacher-channel', metaB)
    const latestInboundMeta = metaB // B arrived last — this is what caused the real misdelivery

    const result = resolveReplyTarget(inbound, latestInboundMeta, 'po-channel')
    expect(result).toEqual({ ok: true, meta: metaA })
    // 대조: chat_id 없이 호출했다면 실제로 B(선생님채널)로 갔을 것 — 그게 실피해였다.
    const implicitResult = resolveReplyTarget(inbound, latestInboundMeta, undefined)
    expect(implicitResult).toEqual({ ok: true, meta: metaB })
  })

  test('unknown chat_id: explicit error, not a silent fallback to latestInboundMeta', () => {
    const inbound = new Map<string, InboundMeta>()
    const latest = makeMeta('chat-A', 100)
    const result = resolveReplyTarget(inbound, latest, 'never-seen-chat-id')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('never-seen-chat-id')
  })

  test('chat_id targeting itself is unaffected by an unrelated third channel being latest', () => {
    const inbound = new Map<string, InboundMeta>()
    const metaA = makeMeta('chat-A', 100)
    inbound.set('chat-A', metaA)
    inbound.set('chat-C', makeMeta('chat-C', 300))
    const result = resolveReplyTarget(inbound, makeMeta('chat-C', 300), 'chat-A')
    expect(result).toEqual({ ok: true, meta: metaA })
  })
})

describe('pruneInboundMeta (#2622)', () => {
  test('below the size threshold: nothing is pruned even if stale', () => {
    const inbound = new Map<string, InboundMeta>()
    inbound.set('old', makeMeta('old', 0))
    pruneInboundMeta(inbound, 1_000_000)
    expect(inbound.has('old')).toBe(true)
  })

  test('above the size threshold: entries older than 300s are removed, fresh ones survive', () => {
    const inbound = new Map<string, InboundMeta>()
    const now = 1_000_000
    for (let i = 0; i < 1001; i++) {
      inbound.set(`old-${i}`, makeMeta(`old-${i}`, now - 400_000)) // stale
    }
    inbound.set('fresh', makeMeta('fresh', now - 1_000)) // recent
    pruneInboundMeta(inbound, now)
    expect(inbound.has('fresh')).toBe(true)
    expect(inbound.has('old-0')).toBe(false)
    expect(inbound.size).toBe(1)
  })

  test('re-arriving on the same chat_id refreshes ts (set() overwrites, not appends)', () => {
    const inbound = new Map<string, InboundMeta>()
    inbound.set('chat-A', makeMeta('chat-A', 100))
    inbound.set('chat-A', makeMeta('chat-A', 999)) // simulates deliver() re-writing on new inbound
    expect(inbound.size).toBe(1)
    expect(inbound.get('chat-A')?.ts).toBe(999)
  })
})
