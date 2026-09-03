/**
 * story #3311 — ⭐핵심 pin(PO AC 리뷰 정정, PR#29 코멘트): "게이트 없이는 Meta로 단
 * 하나의 요청도 안 나간다"를 end-to-end로 증명한다. 스티비(#3292)와 달리 컨테이너
 * 생성(POST .../threads)은 Meta 쪽 실제 쓰기 요청이라 draft 준비 취급이 아니다 — 두
 * chokepoint(①함수 진입 직후=한도조회보다도 먼저, ②publish 직전=레이스 방어)가 각각
 * pin 대상이다.
 *
 * [[Phase0·마케팅운영] 기존 발행 도구는 남아 있지만 모든 외부 요청 전에 플랫폼 이관
 * 오류로 멈춘다](entity:story:0da62f78-b244-4c7e-bac1-4b72547894f0) 동결로 도달 불가·
 * Phase 1 서버 어댑터 이관 시 계약 pin으로 참고·해제 시 skip 제거 (PO 리뷰, PR#39).
 */
import { describe, test, expect } from 'bun:test'
import {
  publishThreadsPost,
  threadsGetInsights,
  threadsGetPublishingLimit,
  getThreadsInsightsAndRecordEvidence,
  ThreadsRateLimitExceededError,
  ThreadsTextTooLongError,
} from './threads'
import { GateNotApprovedError, NoGateFoundError } from './gate-check'
import { ExternalPublishMovedToPlatformError } from './publish-freeze'

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

/** work_item 경로(AC5) 전용 — gate-check.ts::resolveLatestGate가 기대하는 배열 응답. */
function gateCheckListSpy(status: string | null) {
  return (async () =>
    new Response(JSON.stringify(status === null ? [] : [{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]), { status: 200 })
  ) as unknown as typeof fetch
}

describe.skip('publishThreadsPost — chokepoint end-to-end (#3311) [SKIP: frozen by #3366, unreachable]', () => {
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

describe.skip('publishThreadsPost — work_item 경로(#3312 AC5, gate_id 없이 조회) [SKIP: frozen by #3366, unreachable]', () => {
  test('gateId 없이 workItemId만 줘도 approved면 게시가 나간다', async () => {
    const { calls, fetchImpl } = threadsSpy()
    const result = await publishThreadsPost({
      workItemId: 'wi-1', text: 'hello via work item',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: threadsConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckListSpy('approved'),
    })
    expect(result.postId).toBe('post-99')
    expect(calls.filter((c) => c.url.includes('/threads_publish?'))).toHaveLength(1)
  })

  test('workItemId 경로 — pending이면 Meta로 단 하나의 요청도 안 나간다', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        workItemId: 'wi-1', text: 'hello via work item',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckListSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐게이트 0건(approve 단계 미발생) — NoGateFoundError, Meta 호출 0건', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        workItemId: 'wi-1', text: 'hello via work item',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckListSpy(null),
      }),
    ).rejects.toThrow(NoGateFoundError)
    expect(calls).toHaveLength(0)
  })

  test('gateId와 workItemId 둘 다 있으면 gateId(명시 경로)가 우선한다', async () => {
    let gateCheckCalls = 0
    const gateCheckFetchImpl = (async (url: string) => {
      gateCheckCalls += 1
      // 명시 경로(assertGateApproved)는 /gates/{id} 단건 GET — 배열이 아닌 단일 객체 응답을
      // 기대한다. work_item 경로였다면 이 스파이가 배열이 아닌 값을 못 파싱해 에러가 났을 것.
      expect(url).toContain('/api/v2/gates/gate-explicit')
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch
    const { fetchImpl } = threadsSpy()

    const result = await publishThreadsPost({
      gateId: 'gate-explicit', workItemId: 'wi-should-be-ignored', text: 'explicit wins',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: threadsConfig(fetchImpl),
      gateCheckFetchImpl,
    })

    expect(result.postId).toBe('post-99')
    expect(gateCheckCalls).toBe(2) // 두 chokepoint 각각 1회
  })

  test('⭐gateId도 workItemId도 없으면 즉시 명시 에러 — 네트워크 호출 0건', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        text: 'no gate reference at all',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
      }),
    ).rejects.toThrow('requires either gateId or workItemId')
    expect(calls).toHaveLength(0)
  })

  test('레이스 방어 — work_item 경로도 ①과 ② 사이 철회를 잡는다(매번 새로 조회)', async () => {
    const { calls, fetchImpl } = threadsSpy()
    let call = 0
    const gateCheckFetchImpl = (async () => {
      call += 1
      const status = call === 1 ? 'approved' : 'rejected'
      return new Response(JSON.stringify([{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishThreadsPost({
        workItemId: 'wi-1', text: 'hello via work item',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.url.includes('/threads_publishing_limit'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/threads?'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/threads_publish?'))).toBe(false)
  })
})

describe('publishThreadsPost — frozen (story #3366 Phase0 external-publish freeze)', () => {
  test('⭐AC1/AC2 — 승인된 gate여도 즉시 EXTERNAL_PUBLISH_MOVED_TO_PLATFORM, Threads·게이트 조회 outbound 0건', async () => {
    const { calls, fetchImpl } = threadsSpy()
    let gateCheckCalled = false
    const gateCheckFetchImpl = (async () => {
      gateCheckCalled = true
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishThreadsPost({
        gateId: 'gate-1', text: 'hello threads',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
    expect(gateCheckCalled).toBe(false)
  })

  test('⭐AC3 — work_item 경로(#3312 AC5)로 줘도 동결은 그대로, outbound 0건', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        workItemId: 'wi-1', text: 'hello via work item',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('gate_id도 work_item도 없어도 동결 에러가 먼저다("requires either..." 에러보다 우선)', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        text: 'no gate reference at all',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('501자 초과 text 같은 입력 검증보다도 동결이 먼저 걸린다', async () => {
    const { calls, fetchImpl } = threadsSpy()
    await expect(
      publishThreadsPost({
        gateId: 'gate-1', text: 'a'.repeat(501),
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('에러 메시지에 도구명(publish_threads_post)이 실린다', async () => {
    const { fetchImpl } = threadsSpy()
    try {
      await publishThreadsPost({
        gateId: 'gate-1', text: 'hello',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: threadsConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      })
      throw new Error('unreachable — publishThreadsPost must be frozen')
    } catch (err) {
      expect((err as Error).message).toContain('publish_threads_post')
    }
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

describe('getThreadsInsightsAndRecordEvidence (#3321 — measure 단계 도구, insights+evidence 원자 호출)', () => {
  const OK_INSIGHTS = {
    data: [
      { name: 'views', values: [{ value: 100 }] },
      { name: 'likes', values: [{ value: 10 }] },
      { name: 'replies', values: [{ value: 2 }] },
      { name: 'reposts', values: [{ value: 1 }] },
      { name: 'quotes', values: [{ value: 0 }] },
    ],
  }

  function insightsSpy(body: unknown = OK_INSIGHTS, status = 200) {
    const calls: { url: string }[] = []
    const fetchImpl = (async (url: string) => {
      calls.push({ url })
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  function evidenceSpy(status = 201, body: unknown = { id: 'evidence-1' }) {
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body })
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  test('⭐AC1 — 성공 경로: insights 1콜+evidence 1콜, 응답에 5지표+evidenceRecorded:true+evidenceId', async () => {
    const insights = insightsSpy()
    const evidence = evidenceSpy()

    const result = await getThreadsInsightsAndRecordEvidence({
      postId: 'post-1', workItemId: 'wi-1',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: { accessToken: 't', userId: 'u', fetchImpl: insights.fetchImpl },
      evidenceFetchImpl: evidence.fetchImpl,
    })

    expect(result).toMatchObject({ views: 100, likes: 10, replies: 2, reposts: 1, quotes: 0, evidenceRecorded: true, evidenceId: 'evidence-1' })
    expect(insights.calls).toHaveLength(1)
    expect(evidence.calls).toHaveLength(1)
  })

  test('evidence 기록 body가 work_item_id/type=metric/ref=postId/지표 note를 정확히 싣는다', async () => {
    const insights = insightsSpy()
    const evidence = evidenceSpy()

    await getThreadsInsightsAndRecordEvidence({
      postId: 'post-42', workItemId: 'wi-9', workItemType: 'task',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: { accessToken: 't', userId: 'u', fetchImpl: insights.fetchImpl },
      evidenceFetchImpl: evidence.fetchImpl,
    })

    const body = JSON.parse(evidence.calls[0].body as string)
    expect(body.work_item_id).toBe('wi-9')
    expect(body.work_item_type).toBe('task')
    expect(body.type).toBe('metric')
    expect(body.ref).toBe('post-42')
    const note = JSON.parse(body.note)
    expect(note).toMatchObject({ views: 100, likes: 10, replies: 2, reposts: 1, quotes: 0 })
    expect(typeof note.measured_at).toBe('string')
    expect(() => new Date(note.measured_at).toISOString()).not.toThrow()
  })

  test('⭐AC2 — insights 실패 → throw, evidence 호출 0건(원자성: 잴 것 없으면 기록도 없다)', async () => {
    const insights = insightsSpy({}, 500)
    const evidence = evidenceSpy()

    await expect(
      getThreadsInsightsAndRecordEvidence({
        postId: 'post-1', workItemId: 'wi-1',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: { accessToken: 't', userId: 'u', fetchImpl: insights.fetchImpl },
        evidenceFetchImpl: evidence.fetchImpl,
      }),
    ).rejects.toThrow('threads insights lookup failed: 500')
    expect(evidence.calls).toHaveLength(0)
  })

  test('⭐PO 리뷰 못박음① — evidence 기록 실패해도 지표는 반환·evidenceRecorded:false+evidenceError 명시(조용한 성공 금지)', async () => {
    const insights = insightsSpy()
    const evidence = evidenceSpy(500)

    const result = await getThreadsInsightsAndRecordEvidence({
      postId: 'post-1', workItemId: 'wi-1',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: { accessToken: 't', userId: 'u', fetchImpl: insights.fetchImpl },
      evidenceFetchImpl: evidence.fetchImpl,
    })

    expect(result).toMatchObject({ views: 100, likes: 10, replies: 2, reposts: 1, quotes: 0, evidenceRecorded: false })
    expect(result.evidenceError).toContain('500')
    expect(result.evidenceId).toBeUndefined()
    expect(evidence.calls).toHaveLength(1) // 시도는 정확히 1번 — 재시도 정책 0
  })

  test('⭐AC4 — workItemId 없으면 즉시 명시 에러, 네트워크 호출 0건', async () => {
    const insights = insightsSpy()
    const evidence = evidenceSpy()

    await expect(
      getThreadsInsightsAndRecordEvidence({
        postId: 'post-1', workItemId: '',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        threads: { accessToken: 't', userId: 'u', fetchImpl: insights.fetchImpl },
        evidenceFetchImpl: evidence.fetchImpl,
      }),
    ).rejects.toThrow('requires workItemId')
    expect(insights.calls).toHaveLength(0)
    expect(evidence.calls).toHaveLength(0)
  })

  test('AC3 — 응답 스키마에 verdict/success류 필드가 없다(순수 지표+기록상태만)', async () => {
    const insights = insightsSpy()
    const evidence = evidenceSpy()

    const result = await getThreadsInsightsAndRecordEvidence({
      postId: 'post-1', workItemId: 'wi-1',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      threads: { accessToken: 't', userId: 'u', fetchImpl: insights.fetchImpl },
      evidenceFetchImpl: evidence.fetchImpl,
    })

    const keys = Object.keys(result)
    for (const forbidden of ['verdict', 'success', 'passed', 'ok', 'goalMet']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
