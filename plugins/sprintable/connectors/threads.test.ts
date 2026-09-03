/**
 * story #3311 — 두 chokepoint(①함수 진입 직후=한도조회보다도 먼저, ②publish 직전=
 * 레이스 방어) 로직 자체는 gate-check.ts::assertGateApproved/assertGateApprovedForWorkItem
 * 위임이라 gate-check.test.ts가 커버한다.
 *
 * story #3366(Phase0·마케팅운영) 이후: publishThreadsPost는 함수 진입 즉시(어떤
 * chokepoint보다도 먼저) EXTERNAL_PUBLISH_MOVED_TO_PLATFORM으로 얼어붙는다 — 예전에
 * 이 파일이 pin하던 "게이트 승인 시 게시가 실제로 나간다"·"work_item 경로 조회" 같은
 * end-to-end 시나리오는 이제 프로덕션에서 도달 불가능한 코드 경로가 됐다(서버 어댑터가
 * 나중에 선별 재사용할 로직으로만 남는다, PO 지시 — 도구 자체는 안 지운다). 아래
 * 'frozen' describe가 그 대체 pin이다. threadsGetPublishingLimit·threadsGetInsights·
 * getThreadsInsightsAndRecordEvidence는 동결 대상이 아니므로(읽기·측정 도구) 원래 커버리지
 * 그대로 유지한다.
 */
import { describe, test, expect } from 'bun:test'
import {
  publishThreadsPost,
  threadsGetInsights,
  threadsGetPublishingLimit,
  getThreadsInsightsAndRecordEvidence,
} from './threads'
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

function threadsConfig(fetchImpl: typeof fetch, overrides: { accessToken?: string; userId?: string } = {}) {
  return { accessToken: overrides.accessToken ?? 'threads-token', userId: overrides.userId ?? '17841400000000000', fetchImpl }
}

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

describe('threadsGetPublishingLimit (#3311 AC4) — 동결 대상 아님(읽기 도구)', () => {
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

describe('threadsGetInsights (#3311 AC5 — M3 measure 대비) — 동결 대상 아님(읽기 도구)', () => {
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

describe('getThreadsInsightsAndRecordEvidence (#3321 — measure 단계 도구) — 동결 대상 아님(측정 도구)', () => {
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
