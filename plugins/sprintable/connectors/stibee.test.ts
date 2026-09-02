/**
 * story #3292 + 6f2034cf(2026-09-02, 두 chokepoint로 정정) — ⭐핵심 pin(PO AC): "게이트
 * 없이는 스티비로 단 하나의 요청도 안 나간다"를 end-to-end로 증명한다. gate.status가
 * pending/rejected면 create(POST /v2/emails)조차 나가지 않는다 — create/content/update가
 * "draft 준비=게이트 무관 항상 진행"이던 예전 가정은 스티비 계정에 실제로 남는 외부
 * 쓰기라 틀렸다(threads.ts §PR#29 PO AC 리뷰와 동형 배치로 통일, story 6f2034cf).
 */
import { describe, test, expect } from 'bun:test'
import { publishStibeeCampaign, type StibeeCampaignContent } from './stibee'
import { GateNotApprovedError, NoGateFoundError } from './gate-check'

const CONTENT: StibeeCampaignContent = {
  create: { listId: 1, senderEmail: 'a@b.com', senderName: 'Sprintable', subject: 'hi' },
  html: '<html><body>hello</body></html>',
}

/** 스티비 쪽 fetch 스파이 — 실제로 나간 (method, url) 쌍을 전부 기록한다. */
function stibeeSpy() {
  const calls: { method: string; url: string }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url })
    if (init?.method === 'POST' && url.endsWith('/emails')) {
      return new Response(JSON.stringify({ id: 42 }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function gateCheckSpy(status: string) {
  return (async () => new Response(JSON.stringify({ status }), { status: 200 })) as unknown as typeof fetch
}

/** 레이스 방어 테스트 전용 — 호출마다 순서대로 다른 status를 준다(소진되면 마지막 값
 * 반복) — threads.test.ts::gateCheckSequenceSpy와 동형. */
function gateCheckSequenceSpy(statuses: string[]) {
  let i = 0
  return (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)]
    i += 1
    return new Response(JSON.stringify({ status }), { status: 200 })
  }) as unknown as typeof fetch
}

/** work_item 경로(AC5) 전용 — gate-check.ts::resolveLatestGate가 기대하는 배열 응답. */
function gateCheckListSpy(status: string | null) {
  return (async () =>
    new Response(JSON.stringify(status === null ? [] : [{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]), { status: 200 })
  ) as unknown as typeof fetch
}

describe('publishStibeeCampaign — chokepoint end-to-end (#3292)', () => {
  test('gate.status=approved — send이 실제로 나간다(양성대조)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    const result = await publishStibeeCampaign({
      gateId: 'gate-1', content: CONTENT,
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      stibee: { accessToken: 'stibee-token', fetchImpl },
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(result.emailId).toBe(42)
    const sendCalls = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/42/send'))
    expect(sendCalls).toHaveLength(1)
  })

  test('gate.status=auto_passed — send이 실제로 나간다', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await publishStibeeCampaign({
      gateId: 'gate-1', content: CONTENT,
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      stibee: { accessToken: 'stibee-token', fetchImpl },
      gateCheckFetchImpl: gateCheckSpy('auto_passed'),
    })
    expect(calls.filter((c) => c.url.endsWith('/42/send'))).toHaveLength(1)
  })

  test('⭐gate.status=pending — 스티비로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    // create(POST /v2/emails)도 — 전부 0건. 미승인 상태에서 스티비 쪽으로 나가는
    // outbound가 정확히 0이라는 게 story 6f2034cf가 요구한 것(레거시: create가 "draft
    // 준비"로 취급돼 게이트 확認보다 먼저 나가던 결함 — PO 지시로 정정).
    expect(calls).toHaveLength(0)
  })

  test('⭐gate.status=rejected — 스티비로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckSpy('rejected'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐레이스 방어(chokepoint②) — ①통과 뒤 승인이 철회되면 create/content는 이미 나갔어도 send는 절대 안 나간다', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        // 1번째 게이트조회(①)=approved → 통과. 2번째(②, send 직전)=rejected(철회) → 차단.
        gateCheckFetchImpl: gateCheckSequenceSpy(['approved', 'rejected']),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/emails'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/42/content'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/send'))).toBe(false)
  })

  test('gate.status=approved — create→content→send 전부 정상 시퀀스로 나간다(chokepoint① 통과 확認)', async () => {
    // story 6f2034cf 정정 후에도 승인 상태의 정상 경로는 무회귀임을 pin.
    const { calls, fetchImpl } = stibeeSpy()
    await publishStibeeCampaign({
      gateId: 'gate-1', content: CONTENT,
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      stibee: { accessToken: 'stibee-token', fetchImpl },
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/emails'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/42/content'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/send'))).toBe(true)
  })

  test('본문 콘텐츠 호출은 text/html raw body이지 JSON이 아니다(실측 정정 — 이전 PUT 추정과 다름)', async () => {
    let capturedBody: unknown
    let capturedHeaders: HeadersInit | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/emails')) {
        return new Response(JSON.stringify({ id: 7 }), { status: 200 })
      }
      if (init?.method === 'POST' && url.endsWith('/7/content')) {
        capturedBody = init.body
        capturedHeaders = init.headers
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishStibeeCampaign({
      gateId: 'gate-1', content: CONTENT,
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      stibee: { accessToken: 'stibee-token', fetchImpl },
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(capturedBody).toBe(CONTENT.html) // raw HTML, JSON.stringify 안 됨
    expect(capturedHeaders).toMatchObject({ 'Content-Type': 'text/html' })
  })

  test('send 호출은 body 없이 AccessToken 헤더만 싣는다(실측 그대로)', async () => {
    let sendInit: RequestInit | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/emails')) {
        return new Response(JSON.stringify({ id: 9 }), { status: 200 })
      }
      if (init?.method === 'POST' && url.endsWith('/9/send')) {
        sendInit = init
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishStibeeCampaign({
      gateId: 'gate-1', content: CONTENT,
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      stibee: { accessToken: 'my-stibee-token', fetchImpl },
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(sendInit?.body).toBeUndefined()
    expect(sendInit?.headers).toMatchObject({ AccessToken: 'my-stibee-token' })
  })
})

describe('publishStibeeCampaign — work_item 경로(#3312 AC5, gate_id 없이 조회)', () => {
  test('gateId 없이 workItemId만 줘도 approved면 send가 나간다', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    const result = await publishStibeeCampaign({
      workItemId: 'wi-1', content: CONTENT,
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      stibee: { accessToken: 'stibee-token', fetchImpl },
      gateCheckFetchImpl: gateCheckListSpy('approved'),
    })
    expect(result.emailId).toBe(42)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/42/send'))).toHaveLength(1)
  })

  test('workItemId 경로 — pending이면 스티비로 단 하나의 요청도 안 나간다', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        workItemId: 'wi-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckListSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('레이스 방어 — work_item 경로도 ①과 ② 사이 철회를 잡는다(매번 새로 조회)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    let call = 0
    const gateCheckFetchImpl = (async () => {
      call += 1
      const status = call === 1 ? 'approved' : 'rejected'
      return new Response(
        JSON.stringify([{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    await expect(
      publishStibeeCampaign({
        workItemId: 'wi-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/emails'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/send'))).toBe(false)
  })

  test('⭐게이트 0건(approve 단계 미발생) — NoGateFoundError, send 0건', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        workItemId: 'wi-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckListSpy(null),
      }),
    ).rejects.toThrow(NoGateFoundError)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/send'))).toHaveLength(0)
  })

  test('⭐gateId도 workItemId도 없으면 즉시 명시 에러 — draft 준비도 시작 안 함(호출 0건)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
      }),
    ).rejects.toThrow('requires either gateId or workItemId')
    expect(calls).toHaveLength(0)
  })

  test('gateId와 workItemId 둘 다 있으면 gateId(명시 경로)가 우선한다', async () => {
    const gateCheckFetchImpl = (async (url: string) => {
      expect(url).toContain('/api/v2/gates/gate-explicit')
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch
    const { fetchImpl } = stibeeSpy()

    const result = await publishStibeeCampaign({
      gateId: 'gate-explicit', workItemId: 'wi-should-be-ignored', content: CONTENT,
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      stibee: { accessToken: 'stibee-token', fetchImpl },
      gateCheckFetchImpl,
    })

    expect(result.emailId).toBe(42)
  })
})
