/**
 * story #3311 — ⭐핵심 pin(PO AC 리뷰 정정, PR#29 코멘트): "게이트 없이는 Meta로 단
 * 하나의 요청도 안 나간다"를 end-to-end로 증명한다. 스티비(#3292)와 달리 컨테이너
 * 생성(POST .../threads)은 Meta 쪽 실제 쓰기 요청이라 draft 준비 취급이 아니다 — 두
 * chokepoint(①함수 진입 직후=한도조회보다도 먼저, ②publish 직전=레이스 방어)가 각각
 * pin 대상이다.
 */
import { describe, test, expect } from 'bun:test'
import {
  publishThreadsPost,
  threadsGetInsights,
  threadsGetPublishingLimit,
  ThreadsRateLimitExceededError,
  ThreadsTextTooLongError,
} from './threads'
import { GateNotApprovedError } from './gate-check'

const OK_LIMIT = { data: [{ quota_usage: 10, config: { quota_total: 250 } }] }

/** Threads 쪽 fetch 스파이 — 실제로 나간 (method, url) 쌍을 전부 기록한다. */
function threadsSpy(limitBody: unknown = OK_LIMIT) {
  const calls: { method: string; url: string }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url })
    if (url.includes('/threads_publishing_limit')) {
      return new Response(JSON.stringify(limitBody), { status: 200 })
    }
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/threads?') || url.endsWith('/threads')) {
      return new Response(JSON.stringify({ id: 'creation-42' }), { status: 200 })
    }
    if (url.includes('/threads_publish')) {
      return new Response(JSON.stringify({ id: 'post-99' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function gateCheckSpy(status: string) {
  return (async () => new Response(JSON.stringify({ status }), { status: 200 })) as unknown as typeof fetch
}

/** 레이스 방어 테스트 전용 — 호출마다 순서대로 다른 status를 준다(소진되면 마지막 값 반복). */
function gateCheckSequenceSpy(statuses: string[]) {
  let i = 0
  return (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)]
    i += 1
    return new Response(JSON.stringify({ status }), { status: 200 })
  }) as unknown as typeof fetch
}

function threadsConfig(fetchImpl: typeof fetch, overrides: { accessToken?: string; userId?: string } = {}) {
  return { accessToken: overrides.accessToken ?? 'threads-token', userId: overrides.userId ?? '17841400000000000', fetchImpl }
}

describe('publishThreadsPost — chokepoint end-to-end (#3311)', () => {
  test('gate.status=approved — 게시가 실제로 나간다(양성대조)', async () => {
    const { calls, fetchImpl } = threadsSpy()
    const result = await publishThreadsPost({
      gateId: 'gate-1', text: 'hello threads',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: threadsConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(result.postId).toBe('post-99')
    const publishCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/threads_publish?'))
    expect(publishCalls).toHaveLength(1)
  })

  test('gate.status=auto_passed — 게시가 실제로 나간다', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await publishThreadsPost({
      gateId: 'gate-1', text: 'hello threads',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: threadsConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('auto_passed'),
    })
    expect(calls.filter((c) => c.url.includes('/threads_publish?'))).toHaveLength(1)
  })

  test('⭐gate.status=pending — Meta로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        gateId: 'gate-1', text: 'hello threads',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    // 한도조회(GET)도, 컨테이너 생성(POST)도 — 전부 0건. 미승인 상태에서 Meta 쪽으로
    // 나가는 outbound가 정확히 0이라는 게 PO AC 리뷰가 요구한 것(레거시: 컨테이너 생성이
    // "draft 준비"로 취급돼 먼저 나가던 결함).
    expect(calls).toHaveLength(0)
  })

  test('⭐gate.status=rejected — Meta로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        gateId: 'gate-1', text: 'hello threads',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('rejected'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐레이스 방어(chokepoint②) — ①통과 뒤 승인이 철회되면 한도조회·컨테이너 생성은 이미 나갔어도 publish는 절대 안 나간다', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        gateId: 'gate-1', text: 'hello threads',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        // 1번째 게이트조회(①)=approved → 통과. 2번째(②, publish 직전)=rejected(철회) → 차단.
        gateCheckFetchImpl: gateCheckSequenceSpy(['approved', 'rejected']),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.url.includes('/threads_publishing_limit'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/threads?'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/threads_publish?'))).toBe(false)
  })

  test('컨테이너 생성은 media_type=TEXT·text를 JSON body로 싣는다(실측 계약 pin)', async () => {
    let capturedBody: unknown
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/threads?')) {
        capturedBody = init?.body
        return new Response(JSON.stringify({ id: 'creation-1' }), { status: 200 })
      }
      if (url.includes('/threads_publishing_limit')) return new Response(JSON.stringify(OK_LIMIT), { status: 200 })
      return new Response(JSON.stringify({ id: 'post-1' }), { status: 200 })
    }) as unknown as typeof fetch

    await publishThreadsPost({
      gateId: 'gate-1', text: 'pin me',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: threadsConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(JSON.parse(capturedBody as string)).toEqual({ media_type: 'TEXT', text: 'pin me' })
  })

  test('게시(threads_publish)는 creation_id를 JSON body로 싣는다', async () => {
    let capturedBody: unknown
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/threads?')) {
        return new Response(JSON.stringify({ id: 'creation-abc' }), { status: 200 })
      }
      if (url.includes('/threads_publishing_limit')) return new Response(JSON.stringify(OK_LIMIT), { status: 200 })
      if (url.includes('/threads_publish')) {
        capturedBody = init?.body
        return new Response(JSON.stringify({ id: 'post-1' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishThreadsPost({
      gateId: 'gate-1', text: 'pin me too',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: threadsConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(JSON.parse(capturedBody as string)).toEqual({ creation_id: 'creation-abc' })
  })

  test('text≤500자 검증 — 501자면 명시 에러(4xx급), 네트워크 호출 0건(AC6)', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        gateId: 'gate-1', text: 'a'.repeat(501),
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ThreadsTextTooLongError)
    expect(calls).toHaveLength(0)
  })

  test('text=정확히 500자는 통과한다(경계값)', async () => {
    const { fetchImpl } = threadsSpy()
    const result = await publishThreadsPost({
      gateId: 'gate-1', text: 'a'.repeat(500),
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: threadsConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(result.postId).toBe('post-99')
  })

  test('⭐AC4 — 250/24h 한도 초과 시 명시 에러, 컨테이너 생성/게시 호출 0건', async () => {
    const { calls, fetchImpl } = threadsSpy({ data: [{ quota_usage: 250, config: { quota_total: 250 } }] })
    await expect(
      publishThreadsPost({
        gateId: 'gate-1', text: 'over limit',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ThreadsRateLimitExceededError)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  test('AC9 — 다른 org 자격증명(userId·accessToken)으로도 동형으로 동작한다(조직 상수 0 증명)', async () => {
    const orgA = threadsSpy()
    const orgB = threadsSpy()

    const resultA = await publishThreadsPost({
      gateId: 'gate-org-a', text: 'org a post',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'key-a',
      threads: threadsConfig(orgA.fetchImpl, { accessToken: 'org-a-token', userId: 'org-a-user-id' }),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    const resultB = await publishThreadsPost({
      gateId: 'gate-org-b', text: 'org b post',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'key-b',
      threads: threadsConfig(orgB.fetchImpl, { accessToken: 'org-b-token', userId: 'org-b-user-id' }),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(resultA.postId).toBe('post-99')
    expect(resultB.postId).toBe('post-99')
    expect(orgA.calls.some((c) => c.url.includes('org-a-user-id'))).toBe(true)
    expect(orgB.calls.some((c) => c.url.includes('org-b-user-id'))).toBe(true)
    // 서로의 계정으로는 절대 안 나간다 — org 상수가 코드에 없다는 직접 증거.
    expect(orgA.calls.some((c) => c.url.includes('org-b-user-id'))).toBe(false)
    expect(orgB.calls.some((c) => c.url.includes('org-a-user-id'))).toBe(false)
  })
})

describe('threadsGetPublishingLimit (#3311 AC4)', () => {
  test('quota_usage/quota_total을 파싱해 반환한다', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ quota_usage: 3, config: { quota_total: 250 } }] }), { status: 200 })
    ) as unknown as typeof fetch
    const result = await threadsGetPublishingLimit({ accessToken: 't', userId: 'u', fetchImpl })
    expect(result).toEqual({ quotaUsage: 3, quotaTotal: 250 })
  })

  test('non-2xx는 명시 에러(조용한 통과 금지)', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    await expect(threadsGetPublishingLimit({ accessToken: 't', userId: 'u', fetchImpl })).rejects.toThrow(
      'threads publishing limit lookup failed: 500',
    )
  })
})

describe('threadsGetInsights (#3311 AC5 — M3 measure 대비, 이번엔 함수+테스트만)', () => {
  test('views/likes/replies/reposts/quotes를 파싱해 반환한다', async () => {
    let capturedUrl = ''
    const fetchImpl = (async (url: string) => {
      capturedUrl = url
      return new Response(
        JSON.stringify({
          data: [
            { name: 'views', values: [{ value: 100 }] },
            { name: 'likes', values: [{ value: 10 }] },
            { name: 'replies', values: [{ value: 2 }] },
            { name: 'reposts', values: [{ value: 1 }] },
            { name: 'quotes', values: [{ value: 0 }] },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await threadsGetInsights('media-1', { accessToken: 't', userId: 'u', fetchImpl })
    expect(result).toEqual({ views: 100, likes: 10, replies: 2, reposts: 1, quotes: 0 })
    expect(capturedUrl).toContain('/media-1/insights')
    expect(decodeURIComponent(capturedUrl)).toContain('metric=views,likes,replies,reposts,quotes')
  })

  test('non-2xx는 명시 에러', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    await expect(threadsGetInsights('media-1', { accessToken: 't', userId: 'u', fetchImpl })).rejects.toThrow(
      'threads insights lookup failed: 404',
    )
  })
})
