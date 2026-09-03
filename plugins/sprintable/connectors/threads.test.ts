/**
 * story #3399(2026-09-04, 페드루 PO 확定) — 이 파일에 있던 `publishThreadsPost`(에이전트
 * 직접 발행, 컨테이너 생성→게시 2-콜) 전용 테스트 3벌(양성대조·gate 미승인 chokepoint·
 * work_item 경로·동결 pin, 총 20여 건)은 그 함수 자체가 threads.ts에서 삭제되면서 함께
 * 지웠다. 삭제 배경은 story #3366(PR#39, 먼저 동결)→#3399(그 위에서 실 삭제, PR 본문에
 * #3366 링크) — 대체 경로는 connectors/channel-posts.ts::createOrUpdateChannelPostDraft/
 * submitChannelPostDraft(그쪽 테스트 파일이 새 chokepoint를 pin). 아래는 여전히 이
 * 파일에 남아 있는 순수 읽기·측정 함수(발행 아님)만의 테스트다.
 */
import { describe, test, expect } from 'bun:test'
import {
  threadsGetInsights,
  threadsGetPublishingLimit,
  getThreadsInsightsAndRecordEvidence,
} from './threads'

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
