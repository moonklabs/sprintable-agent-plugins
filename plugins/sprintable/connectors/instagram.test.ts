/**
 * story a98dfbea — 두 chokepoint 로직 자체(assertGateApproved/assertGateApprovedForWorkItem
 * 위임)는 gate-check.test.ts가 커버한다.
 *
 * story #3366(Phase0·마케팅운영, PO 보정 — publish_* 3종 외 발견된 도구도 동결 대상)
 * 이후: publishInstagramPost는 함수 진입 즉시 EXTERNAL_PUBLISH_MOVED_TO_PLATFORM으로
 * 얼어붙는다 — "게이트 승인 시 게시가 실제로 나간다"류 end-to-end 시나리오는 이제
 * 프로덕션에서 도달 불가능한 코드 경로다(서버 어댑터가 나중에 선별 재사용할 로직으로만
 * 남는다, PO 지시 — 도구 자체는 안 지운다).
 */
import { describe, test, expect } from 'bun:test'
import { publishInstagramPost } from './instagram'
import { ExternalPublishMovedToPlatformError } from './publish-freeze'

/** Instagram 쪽 fetch 스파이 — 실제로 나간 (method, url) 쌍을 전부 기록한다. */
function instagramSpy() {
  const calls: { method: string; url: string }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url })
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/media?')) {
      return new Response(JSON.stringify({ id: 'container-42' }), { status: 200 })
    }
    if (url.includes('/media_publish')) {
      return new Response(JSON.stringify({ id: 'media-99' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function gateCheckSpy(status: string) {
  return (async () => new Response(JSON.stringify({ status }), { status: 200 })) as unknown as typeof fetch
}

function instagramConfig(fetchImpl: typeof fetch, overrides: { accessToken?: string; igUserId?: string } = {}) {
  return { accessToken: overrides.accessToken ?? 'ig-token', igUserId: overrides.igUserId ?? '17800000000000000', fetchImpl }
}

describe('publishInstagramPost — frozen (story #3366 Phase0 external-publish freeze)', () => {
  test('⭐AC1/AC2 — 승인된 gate여도 즉시 EXTERNAL_PUBLISH_MOVED_TO_PLATFORM, Instagram·게이트 조회 outbound 0건', async () => {
    const { calls, fetchImpl } = instagramSpy()
    let gateCheckCalled = false
    const gateCheckFetchImpl = (async () => {
      gateCheckCalled = true
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishInstagramPost({
        gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg', caption: 'hello',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
    expect(gateCheckCalled).toBe(false)
  })

  test('⭐AC3 — work_item 경로(#3312 AC5 동형)로 줘도 동결은 그대로, outbound 0건', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        workItemId: 'wi-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('gate_id도 work_item도 없어도 동결 에러가 먼저다("requires either..." 에러보다 우선)', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('에러 메시지에 도구명(publish_instagram_post)이 실린다', async () => {
    const { fetchImpl } = instagramSpy()
    try {
      await publishInstagramPost({
        gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      })
      throw new Error('unreachable — publishInstagramPost must be frozen')
    } catch (err) {
      expect((err as Error).message).toContain('publish_instagram_post')
    }
  })
})
