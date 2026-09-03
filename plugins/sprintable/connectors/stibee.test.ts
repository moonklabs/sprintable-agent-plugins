/**
 * story #3292 + 6f2034cf — 두 chokepoint 로직 자체(assertGateApproved/
 * assertGateApprovedForWorkItem 위임)는 gate-check.test.ts가 커버한다.
 *
 * story #3366(Phase0·마케팅운영) 이후: publishStibeeCampaign은 함수 진입 즉시(draft 준비
 * create/content/update보다도 먼저) EXTERNAL_PUBLISH_MOVED_TO_PLATFORM으로 얼어붙는다 —
 * "게이트 승인 시 send가 실제로 나간다"류 end-to-end 시나리오는 이제 프로덕션에서
 * 도달 불가능한 코드 경로다(서버 어댑터가 나중에 선별 재사용할 로직으로만 남는다, PO
 * 지시 — 도구 자체는 안 지운다).
 */
import { describe, test, expect } from 'bun:test'
import { publishStibeeCampaign, type StibeeCampaignContent } from './stibee'
import { ExternalPublishMovedToPlatformError } from './publish-freeze'

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

describe('publishStibeeCampaign — frozen (story #3366 Phase0 external-publish freeze)', () => {
  test('⭐AC1/AC2 — 승인된 gate여도 즉시 EXTERNAL_PUBLISH_MOVED_TO_PLATFORM, 스티비·게이트 조회 outbound 0건(draft 준비도 시작 안 함)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    let gateCheckCalled = false
    const gateCheckFetchImpl = (async () => {
      gateCheckCalled = true
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
    expect(gateCheckCalled).toBe(false)
  })

  test('⭐AC3 — work_item 경로(#3312 AC5)로 줘도 동결은 그대로, outbound 0건', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        workItemId: 'wi-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('gate_id도 work_item도 없어도 동결 에러가 먼저다("requires either..." 에러보다 우선)', async () => {
    const { calls, fetchImpl } = stibeeSpy()
    await expect(
      publishStibeeCampaign({
        content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('에러 메시지에 도구명(publish_stibee_campaign)이 실린다', async () => {
    const { fetchImpl } = stibeeSpy()
    try {
      await publishStibeeCampaign({
        gateId: 'gate-1', content: CONTENT,
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        stibee: { accessToken: 'stibee-token', fetchImpl },
        gateCheckFetchImpl: gateCheckSpy('approved'),
      })
      throw new Error('unreachable — publishStibeeCampaign must be frozen')
    } catch (err) {
      expect((err as Error).message).toContain('publish_stibee_campaign')
    }
  })
})
