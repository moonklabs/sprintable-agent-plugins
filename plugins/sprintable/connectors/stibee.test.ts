/**
 * story #3292 — ⭐핵심 pin(PO AC): "게이트 없이는 발송 안 나간다"를 end-to-end로 증명한다.
 * create→content→(chokepoint)→send 전 사이클에서, gate.status가 pending/rejected면
 * POST /v2/emails/{id}/send가 **한 번도 호출되지 않아야** 한다 — draft 준비(create/
 * content/update)는 게이트와 무관하게 진행되지만, 밖으로 나가는 마지막 한 걸음만 막힌다.
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

  test('⭐gate.status=pending — send이 단 한 번도 호출되지 않는다(핵심 pin)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/send'))).toHaveLength(0)
  })

  test('⭐gate.status=rejected — send이 단 한 번도 호출되지 않는다(핵심 pin)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckSpy('rejected'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/send'))).toHaveLength(0)
  })

  test('gate가 pending이어도 draft 준비(create→content)는 이미 진행된다 — chokepoint는 send 전용', async () => {
    // doc §③: "create/content/PUT(①~③)는 draft 준비 단계라 chokepoint 대상 아님" — 이걸
    // 실측한다(과도한 차단이 아님을 pin — draft 자체를 막는 건 이 스토리의 요구가 아니다).
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/emails'))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/42/content'))).toBe(true)
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

  test('workItemId 경로 — pending이면 send는 0회(draft 준비는 진행)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        workItemId: 'wi-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckListSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/send'))).toHaveLength(0)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/emails'))).toBe(true)
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
