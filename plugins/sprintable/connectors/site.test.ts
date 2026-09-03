/**
 * story 4213f6c4 — ⭐핵심 pin(threads.test.ts·site_git.test.ts와 동형): "게이트 없이는
 * site-posts API로 단 하나의 요청도 안 나간다"(org_id 해소용 /auth/me GET도 포함)를
 * end-to-end로 증명한다. 이 커넥터는 왕복 1번뿐이라 chokepoint도 1개 — story 6f2034cf
 * "공통 계약"의 2-chokepoint 요구는 다중 왕복 사이 레이스 방어가 목적인데, 여긴 그
 * "사이"가 존재하지 않는다(PO 확定, site.ts 상단 주석 참고).
 */
import { describe, test, expect } from 'bun:test'
import { publishSitePost, SitePostGateForbiddenError, SitePostInvalidInputError } from './site'
import { GateNotApprovedError, NoGateFoundError } from './gate-check'

/** site-posts API + /auth/me(org 해소) 쪽 fetch 스파이 — 실제로 나간 (method, url) 쌍을
 * 전부 기록한다. */
function siteApiSpy() {
  const calls: { method: string; url: string }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url })
    if (method === 'GET' && url.includes('/auth/me')) {
      return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
    }
    if (method === 'POST' && url.includes('/site-posts')) {
      return new Response(
        JSON.stringify({ id: 'post-1', slug: 'hello-world', title: '제목', lang: 'ko', published_at: '2026-09-03T00:00:00Z', gate_id: 'gate-1' }),
        { status: 201 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function gateCheckSpy(status: string) {
  return (async () => new Response(JSON.stringify({ status }), { status: 200 })) as unknown as typeof fetch
}

function gateCheckListSpy(status: string | null) {
  return (async () =>
    new Response(JSON.stringify(status === null ? [] : [{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]), { status: 200 })
  ) as unknown as typeof fetch
}

function siteConfig(overrides: Partial<{ siteBaseUrl: string }> = {}) {
  return { siteBaseUrl: overrides.siteBaseUrl ?? 'https://sprintable.ai' }
}

const BASE_PARAMS = {
  title: '제목', body: '본문 markdown', slug: 'hello-world', lang: 'ko', summary: '요약',
  workItemId: 'wi-1',
  sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
  site: siteConfig(),
}

describe('publishSitePost(site.ts) — chokepoint end-to-end (story 4213f6c4)', () => {
  test('gate.status=approved — POST가 실제로 나가고 url을 계산해 반환한다(양성대조)', async () => {
    const { calls, fetchImpl } = siteApiSpy()
    const result = await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1', fetchImpl,
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(result).toEqual({ id: 'post-1', slug: 'hello-world', publishedAt: '2026-09-03T00:00:00Z', url: 'https://sprintable.ai/ko/blog/hello-world' })
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/site-posts'))).toBe(true)
  })

  test('gate.status=auto_passed — POST가 실제로 나간다', async () => {
    const { calls, fetchImpl } = siteApiSpy()
    await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1', fetchImpl,
      gateCheckFetchImpl: gateCheckSpy('auto_passed'),
    })
    expect(calls.some((c) => c.method === 'POST')).toBe(true)
  })

  test('⭐gate.status=pending — site-posts API로도 /auth/me로도 단 하나의 요청도 안 나간다(핵심 pin)', async () => {
    const { calls, fetchImpl } = siteApiSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1', fetchImpl,
        gateCheckFetchImpl: gateCheckSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐gate.status=rejected — 단 하나의 요청도 안 나간다', async () => {
    const { calls, fetchImpl } = siteApiSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1', fetchImpl,
        gateCheckFetchImpl: gateCheckSpy('rejected'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('POST body — work_item_id·gate_id·title·slug·lang·summary·tags·body_md가 실측 계약대로 실린다', async () => {
    let postBody: Record<string, unknown> | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      if (method === 'POST' && url.includes('/site-posts')) {
        postBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ id: 'post-1', slug: 'hello-world', title: '제목', lang: 'ko', published_at: '2026-09-03T00:00:00Z', gate_id: 'gate-1' }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1', tags: ['a', 'b'], fetchImpl,
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(postBody).toEqual({
      work_item_id: 'wi-1', gate_id: 'gate-1', title: '제목', slug: 'hello-world', lang: 'ko',
      summary: '요약', tags: ['a', 'b'], body_md: '본문 markdown',
    })
  })

  test('gateId 없으면 POST body에 gate_id 키 자체가 없다(work_item_id만)', async () => {
    let postBody: Record<string, unknown> | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      if (method === 'POST' && url.includes('/site-posts')) {
        postBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ id: 'post-1', slug: 'hello-world', title: '제목', lang: 'ko', published_at: '2026-09-03T00:00:00Z', gate_id: 'gate-wi-1' }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishSitePost({
      ...BASE_PARAMS, fetchImpl,
      gateCheckFetchImpl: gateCheckListSpy('approved'),
    })

    expect(postBody && 'gate_id' in postBody).toBe(false)
    expect(postBody?.work_item_id).toBe('wi-1')
  })

  test('tags 생략 시 POST body에 tags: [](빈 배열, undefined 아님)', async () => {
    let postBody: Record<string, unknown> | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      if (method === 'POST' && url.includes('/site-posts')) {
        postBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ id: 'post-1', slug: 'hello-world', title: '제목', lang: 'ko', published_at: '2026-09-03T00:00:00Z', gate_id: 'gate-1' }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishSitePost({ ...BASE_PARAMS, gateId: 'gate-1', fetchImpl, gateCheckFetchImpl: gateCheckSpy('approved') })

    expect(postBody?.tags).toEqual([])
  })

  test('⭐서버 403(ExternalPublishGateNotApprovedError) — detail 문자열을 재가공 없이 그대로 던진다', async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      if (method === 'POST' && url.includes('/site-posts')) {
        return new Response(JSON.stringify({ detail: 'external_publish 게이트가 승인되지 않았습니다(gate_id=gate-1, status=rejected)' }), { status: 403 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    // 클라이언트 사전 확認은 통과(approved)시켜 서버 왕복까지 실제로 가게 한다 — 서버가
    // "최종 판정"이라는 계약(레이스: 클라이언트 확認 이후 승인이 철회된 경우와 동형)을
    // 이 테스트가 pin한다.
    await expect(
      publishSitePost({ ...BASE_PARAMS, gateId: 'gate-1', fetchImpl, gateCheckFetchImpl: gateCheckSpy('approved') }),
    ).rejects.toThrow('external_publish 게이트가 승인되지 않았습니다(gate_id=gate-1, status=rejected)')
  })

  test('서버 403을 SitePostGateForbiddenError 타입으로 구별할 수 있다', async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      if (method === 'POST' && url.includes('/site-posts')) {
        return new Response(JSON.stringify({ detail: '이 work item에 승인된 external_publish 게이트가 없습니다' }), { status: 403 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishSitePost({ ...BASE_PARAMS, gateId: 'gate-1', fetchImpl, gateCheckFetchImpl: gateCheckSpy('approved') }),
    ).rejects.toThrow(SitePostGateForbiddenError)
  })

  test('서버 422(InvalidSitePostInputError) — detail을 SitePostInvalidInputError로 그대로 던진다', async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      if (method === 'POST' && url.includes('/site-posts')) {
        return new Response(JSON.stringify({ detail: "slug 형식이 올바르지 않습니다: 'Bad Slug'" }), { status: 422 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishSitePost({ ...BASE_PARAMS, gateId: 'gate-1', fetchImpl, gateCheckFetchImpl: gateCheckSpy('approved') }),
    ).rejects.toThrow(SitePostInvalidInputError)
  })
})

describe('publishSitePost(site.ts) — work_item 경로(gateId 없음, #3312 AC5 동형 클라이언트 사전확認)', () => {
  test('gateId 없이 workItemId만으로도 approved면 POST가 나간다', async () => {
    const { calls, fetchImpl } = siteApiSpy()
    const result = await publishSitePost({
      ...BASE_PARAMS, fetchImpl,
      gateCheckFetchImpl: gateCheckListSpy('approved'),
    })
    expect(result.id).toBe('post-1')
    expect(calls.some((c) => c.method === 'POST')).toBe(true)
  })

  test('workItemId 경로 — pending이면 단 하나의 요청도 안 나간다', async () => {
    const { calls, fetchImpl } = siteApiSpy()
    await expect(
      publishSitePost({ ...BASE_PARAMS, fetchImpl, gateCheckFetchImpl: gateCheckListSpy('pending') }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐게이트 0건 — NoGateFoundError, API 호출 0건', async () => {
    const { calls, fetchImpl } = siteApiSpy()
    await expect(
      publishSitePost({ ...BASE_PARAMS, fetchImpl, gateCheckFetchImpl: gateCheckListSpy(null) }),
    ).rejects.toThrow(NoGateFoundError)
    expect(calls).toHaveLength(0)
  })

  test('gateId와 workItemId 둘 다 있으면 gateId(명시 경로)가 클라이언트 사전확認에 우선한다', async () => {
    const gateCheckFetchImpl = (async (url: string) => {
      expect(url).toContain('/api/v2/gates/gate-explicit')
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch
    const { fetchImpl } = siteApiSpy()

    const result = await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-explicit', fetchImpl, gateCheckFetchImpl,
    })
    expect(result.id).toBe('post-1')
  })
})
