/**
 * story a98dfbea — ⭐핵심 pin(threads.test.ts·stibee.test.ts와 동형): "게이트 없이는
 * Instagram으로 단 하나의 요청도 안 나간다"를 end-to-end로 증명한다. 두 chokepoint
 * (①함수 진입 직후=media 컨테이너 생성보다도 먼저, ②media_publish 직전=레이스 방어)가
 * 각각 pin 대상 — story 6f2034cf가 이미 확立한 "모든 커넥터 공통 계약"을 이 커넥터는
 * 처음부터 그대로 따른다(스티비의 옛 결함을 재현하지 않음).
 *
 * [[Phase0·마케팅운영] 기존 발행 도구는 남아 있지만 모든 외부 요청 전에 플랫폼 이관
 * 오류로 멈춘다](entity:story:0da62f78-b244-4c7e-bac1-4b72547894f0) 동결로 도달 불가·
 * Phase 1 서버 어댑터 이관 시 계약 pin으로 참고·해제 시 skip 제거 (PO 리뷰, PR#39).
 */
import { describe, test, expect } from 'bun:test'
import { publishInstagramPost } from './instagram'
import { GateNotApprovedError, NoGateFoundError } from './gate-check'
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

function instagramConfig(fetchImpl: typeof fetch, overrides: { accessToken?: string; igUserId?: string } = {}) {
  return { accessToken: overrides.accessToken ?? 'ig-token', igUserId: overrides.igUserId ?? '17800000000000000', fetchImpl }
}

/** work_item 경로(AC5 동형) 전용 — gate-check.ts::resolveLatestGate가 기대하는 배열 응답. */
function gateCheckListSpy(status: string | null) {
  return (async () =>
    new Response(JSON.stringify(status === null ? [] : [{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]), { status: 200 })
  ) as unknown as typeof fetch
}

describe.skip('publishInstagramPost — chokepoint end-to-end (story a98dfbea) [SKIP: frozen by #3366, unreachable]', () => {
  test('gate.status=approved — 게시가 실제로 나간다(양성대조)', async () => {
    const { calls, fetchImpl } = instagramSpy()
    const result = await publishInstagramPost({
      gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg', caption: 'hello',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(result.mediaId).toBe('media-99')
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/media_publish'))).toBe(true)
  })

  test('gate.status=auto_passed — 게시가 실제로 나간다', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await publishInstagramPost({
      gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('auto_passed'),
    })
    expect(calls.some((c) => c.url.includes('/media_publish'))).toBe(true)
  })

  test('⭐gate.status=pending — Instagram으로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐gate.status=rejected — Instagram으로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('rejected'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐레이스 방어(chokepoint②) — ①통과 뒤 승인이 철회되면 컨테이너 생성은 이미 나갔어도 media_publish는 절대 안 나간다', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        // 1번째 게이트조회(①)=approved → 통과. 2번째(②, publish 직전)=rejected(철회) → 차단.
        gateCheckFetchImpl: gateCheckSequenceSpy(['approved', 'rejected']),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/media?'))).toBe(true)
    expect(calls.some((c) => c.url.includes('/media_publish'))).toBe(false)
  })

  test('컨테이너 생성은 image_url·caption을 JSON body로 싣는다(실측 계약 pin)', async () => {
    let capturedBody: unknown
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/media?')) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ id: 'container-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'media-1' }), { status: 200 })
    }) as unknown as typeof fetch

    await publishInstagramPost({
      gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg', caption: '캡션 텍스트',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(capturedBody).toEqual({ image_url: 'https://example.com/pic.jpg', caption: '캡션 텍스트' })
  })

  test('caption 없이도(선택 필드) 컨테이너 생성이 나간다 — body에 caption 키 자체가 없다', async () => {
    let capturedBody: unknown
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/media?')) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ id: 'container-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'media-1' }), { status: 200 })
    }) as unknown as typeof fetch

    await publishInstagramPost({
      gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(capturedBody).toEqual({ image_url: 'https://example.com/pic.jpg' })
  })

  test('media_publish는 creation_id를 JSON body로 싣는다', async () => {
    let publishBody: unknown
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/media?')) {
        return new Response(JSON.stringify({ id: 'container-7' }), { status: 200 })
      }
      if (url.includes('/media_publish')) {
        publishBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ id: 'media-7' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishInstagramPost({
      gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(publishBody).toEqual({ creation_id: 'container-7' })
  })

  test('access_token은 쿼리 스트링으로 실린다(Graph API 계열 실측 관례, threads.ts와 동형)', async () => {
    let capturedUrl = ''
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/media?')) {
        capturedUrl = url
        return new Response(JSON.stringify({ id: 'container-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 'media-1' }), { status: 200 })
    }) as unknown as typeof fetch

    await publishInstagramPost({
      gateId: 'gate-1', imageUrl: 'https://example.com/pic.jpg',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl, { accessToken: 'my-ig-token', igUserId: 'ig-user-1' }),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(capturedUrl).toContain('/ig-user-1/media')
    expect(capturedUrl).toContain('access_token=my-ig-token')
  })
})

describe.skip('publishInstagramPost — work_item 경로(#3312 AC5 동형, gate_id 없이 조회) [SKIP: frozen by #3366, unreachable]', () => {
  test('gateId 없이 workItemId만 줘도 approved면 게시가 나간다', async () => {
    const { calls, fetchImpl } = instagramSpy()
    const result = await publishInstagramPost({
      workItemId: 'wi-1', imageUrl: 'https://example.com/pic.jpg',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckListSpy('approved'),
    })
    expect(result.mediaId).toBe('media-99')
    expect(calls.some((c) => c.url.includes('/media_publish'))).toBe(true)
  })

  test('workItemId 경로 — pending이면 Instagram으로 단 하나의 요청도 안 나간다', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        workItemId: 'wi-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckListSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐게이트 0건(approve 단계 미발생) — NoGateFoundError, Instagram 호출 0건', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        workItemId: 'wi-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckListSpy(null),
      }),
    ).rejects.toThrow(NoGateFoundError)
    expect(calls).toHaveLength(0)
  })

  test('⭐gateId도 workItemId도 없으면 즉시 명시 에러 — 네트워크 호출 0건', async () => {
    const { calls, fetchImpl } = instagramSpy()
    await expect(
      publishInstagramPost({
        imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
      }),
    ).rejects.toThrow('requires either gateId or workItemId')
    expect(calls).toHaveLength(0)
  })

  test('gateId와 workItemId 둘 다 있으면 gateId(명시 경로)가 우선한다', async () => {
    const gateCheckFetchImpl = (async (url: string) => {
      expect(url).toContain('/api/v2/gates/gate-explicit')
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch
    const { fetchImpl } = instagramSpy()

    const result = await publishInstagramPost({
      gateId: 'gate-explicit', workItemId: 'wi-should-be-ignored', imageUrl: 'https://example.com/pic.jpg',
      sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
      instagram: instagramConfig(fetchImpl),
      gateCheckFetchImpl,
    })

    expect(result.mediaId).toBe('media-99')
  })

  test('레이스 방어 — work_item 경로도 ①과 ② 사이 철회를 잡는다(매번 새로 조회)', async () => {
    const { calls, fetchImpl } = instagramSpy()
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
      publishInstagramPost({
        workItemId: 'wi-1', imageUrl: 'https://example.com/pic.jpg',
        sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
        instagram: instagramConfig(fetchImpl),
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/media?'))).toBe(true)
    expect(calls.some((c) => c.url.includes('/media_publish'))).toBe(false)
  })
})

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
