/**
 * story #3489 — site_posts 커넥터 pin. 서버 계약은 backend/app/routers/site_posts.py를
 * 직접 확認(추측 0). channel-posts.test.ts와 동형 harness(meAndEndpointSpy).
 */
import { describe, test, expect } from 'bun:test'
import {
  createOrUpdateSitePostDraft,
  submitSitePostDraft,
  getSitePostPublication,
  SitePostApiError,
  SitePostConnectionNotFoundError,
  SitePostCampaignNotFoundError,
  SitePostDestinationKindMismatchError,
  SitePostMediaNotSupportedError,
  SitePostDraftNotFoundError,
  SitePostApproverRoleMissingError,
  SitePostGateAlreadyHeldError,
} from './site-posts'
import { ContentRuleViolationError } from './channel-posts'

function meAndEndpointSpy(orgId: string, endpointHandler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/api/v2/auth/me')) {
      return new Response(JSON.stringify({ org_id: orgId }), { status: 200 })
    }
    return endpointHandler(url, init)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const API = { apiUrl: 'https://app.sprintable.ai', apiKey: 'k' }
const BASE_PARAMS = { workItemId: 'wi-1', title: 'T', slug: 's', lang: 'ko', summary: 'S', bodyMd: 'B' }

describe('createOrUpdateSitePostDraft (story #3489, server site_posts.py:265-273)', () => {
  test('필수 필드+기본값(tags=[]·media_manifest=[])으로 POST, 응답을 그대로 매핑한다', async () => {
    const { calls, fetchImpl } = meAndEndpointSpy('org-1', (url, init) => {
      expect(url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/site-posts/drafts')
      expect(JSON.parse(init?.body as string)).toEqual({
        work_item_id: 'wi-1', title: 'T', slug: 's', lang: 'ko', summary: 'S', tags: [], body_md: 'B', media_manifest: [],
      })
      return new Response(
        JSON.stringify({ draft_id: 'd1', version_id: 'v1', version: 1, author_kind: 'agent', body_sha256: 'sha', violations: [] }),
        { status: 201 },
      )
    })
    const result = await createOrUpdateSitePostDraft(BASE_PARAMS, { ...API, fetchImpl })
    expect(result).toEqual({ draftId: 'd1', versionId: 'v1', version: 1, authorKind: 'agent', bodySha256: 'sha', violations: [] })
    expect(calls.some((c) => c.url.includes('/auth/me'))).toBe(true)
  })

  test('connectionId 생략 시 body에 connection_id 키 자체가 없다(캐리포워드 센티널 보존)', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', (_url, init) => {
      expect(JSON.parse(init?.body as string)).not.toHaveProperty('connection_id')
      return new Response(JSON.stringify({ draft_id: 'd', version_id: 'v', version: 1, author_kind: 'agent', body_sha256: 's', violations: [] }), { status: 201 })
    })
    await createOrUpdateSitePostDraft(BASE_PARAMS, { ...API, fetchImpl })
  })

  test('connectionId=null(명시 해제)이면 body에 null로 실린다(생략과 구별)', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', (_url, init) => {
      expect(JSON.parse(init?.body as string).connection_id).toBeNull()
      return new Response(JSON.stringify({ draft_id: 'd', version_id: 'v', version: 1, author_kind: 'agent', body_sha256: 's', violations: [] }), { status: 201 })
    })
    await createOrUpdateSitePostDraft({ ...BASE_PARAMS, connectionId: null }, { ...API, fetchImpl })
  })

  test('⭐422 CONTENT_RULE_VIOLATION — violations[]를 그대로 싣는다(channel_post와 shape 공유)', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(
        JSON.stringify({
          data: null,
          error: { code: 'CONTENT_RULE_VIOLATION', rules_version: 2, violations: [{ code: 'utm_missing', field: 'body_md', settings_path: '/organization/content-rules' }] },
          meta: null,
        }),
        { status: 422 },
      ),
    )
    try {
      await createOrUpdateSitePostDraft(BASE_PARAMS, { ...API, fetchImpl })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(ContentRuleViolationError)
      expect((err as ContentRuleViolationError).rulesVersion).toBe(2)
      expect((err as ContentRuleViolationError).violations).toHaveLength(1)
    }
  })

  test.each([
    ['CAMPAIGN_NOT_FOUND', SitePostCampaignNotFoundError],
    ['SITE_POST_CONNECTION_NOT_FOUND', SitePostConnectionNotFoundError],
    ['SITE_POST_DESTINATION_KIND_MISMATCH', SitePostDestinationKindMismatchError],
    ['MEDIA_NOT_SUPPORTED_PHASE0', SitePostMediaNotSupportedError],
  ])('⭐422 %s는 전용 클래스로 승격된다', async (code, ErrorClass) => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(JSON.stringify({ data: null, error: { code, message: 'x' }, meta: null }), { status: 422 }),
    )
    await expect(createOrUpdateSitePostDraft(BASE_PARAMS, { ...API, fetchImpl })).rejects.toBeInstanceOf(ErrorClass)
  })

  test('미지 422 code는 기반 클래스로(추측 금지)', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(JSON.stringify({ data: null, error: { code: 'BRAND_NEW_CODE', message: 'x' }, meta: null }), { status: 422 }),
    )
    try {
      await createOrUpdateSitePostDraft(BASE_PARAMS, { ...API, fetchImpl })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(SitePostApiError)
      expect(err).not.toBeInstanceOf(SitePostCampaignNotFoundError)
      expect((err as SitePostApiError).code).toBe('BRAND_NEW_CODE')
    }
  })
})

describe('submitSitePostDraft (story #3489, server site_posts.py:462-471)', () => {
  test('version_id 생략 시 null로 보내고 응답을 그대로 매핑한다', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', (url, init) => {
      expect(url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/site-posts/drafts/d1/submit')
      expect(JSON.parse(init?.body as string)).toEqual({ version_id: null })
      return new Response(JSON.stringify({ gate_id: 'g1', version_id: 'v1', content_sha256: 'sha', status: 'pending' }), { status: 200 })
    })
    const result = await submitSitePostDraft({ draftId: 'd1' }, { ...API, fetchImpl })
    expect(result).toEqual({ gateId: 'g1', versionId: 'v1', contentSha256: 'sha', status: 'pending' })
  })

  test('⭐404 — SitePostDraftNotFoundError, 서버 원문 메시지 보존', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(JSON.stringify({ data: null, error: { message: 'draft not found: d1' }, meta: null }), { status: 404 }),
    )
    await expect(submitSitePostDraft({ draftId: 'd1' }, { ...API, fetchImpl })).rejects.toBeInstanceOf(SitePostDraftNotFoundError)
  })

  test('⭐409 SITE_POST_APPROVER_ROLE_MISSING', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(JSON.stringify({ data: null, error: { code: 'SITE_POST_APPROVER_ROLE_MISSING', message: 'x' }, meta: null }), { status: 409 }),
    )
    await expect(submitSitePostDraft({ draftId: 'd1' }, { ...API, fetchImpl })).rejects.toBeInstanceOf(SitePostApproverRoleMissingError)
  })

  test('⭐409 SITE_POST_GATE_ALREADY_HELD — holding_draft_id/holding_lang/holding_slug를 타입 속성으로도 노출', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(
        JSON.stringify({
          data: null,
          error: { code: 'SITE_POST_GATE_ALREADY_HELD', message: 'x', holding_draft_id: 'd-other', holding_lang: 'en', holding_slug: 'other-slug' },
          meta: null,
        }),
        { status: 409 },
      ),
    )
    try {
      await submitSitePostDraft({ draftId: 'd1' }, { ...API, fetchImpl })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(SitePostGateAlreadyHeldError)
      const e = err as SitePostGateAlreadyHeldError
      expect(e.holdingDraftId).toBe('d-other')
      expect(e.holdingLang).toBe('en')
      expect(e.holdingSlug).toBe('other-slug')
    }
  })

  test('⭐422 CONTENT_RULE_VIOLATION', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(
        JSON.stringify({ data: null, error: { code: 'CONTENT_RULE_VIOLATION', rules_version: 1, violations: [] }, meta: null }),
        { status: 422 },
      ),
    )
    await expect(submitSitePostDraft({ draftId: 'd1' }, { ...API, fetchImpl })).rejects.toBeInstanceOf(ContentRuleViolationError)
  })

  test('미지 409 code는 기반 클래스로', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(JSON.stringify({ data: null, error: { code: 'SOME_FUTURE_CODE', message: 'x' }, meta: null }), { status: 409 }),
    )
    try {
      await submitSitePostDraft({ draftId: 'd1' }, { ...API, fetchImpl })
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(SitePostApiError)
      expect(err).not.toBeInstanceOf(SitePostApproverRoleMissingError)
      expect(err).not.toBeInstanceOf(SitePostGateAlreadyHeldError)
    }
  })
})

describe('getSitePostPublication (story #3489, server site_posts.py:684-693)', () => {
  test('publication을 GET하고 응답을 재가공 없이 그대로 돌려준다(destination·channel_publication·command 포함)', async () => {
    const raw = {
      published_at: null, url: null, published_by_member_id: null, published_body_sha256: null,
      destination: 'wordpress',
      channel_publication: { status: 'published', external_id: 'e1', permalink: 'https://x/p', published_at: '2026-09-05T00:00:00Z', unpublished_at: null, last_error: null },
      command: null,
    }
    const { calls, fetchImpl } = meAndEndpointSpy('org-1', (url) => {
      expect(url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/site-posts/drafts/d1/publication')
      return new Response(JSON.stringify(raw), { status: 200 })
    })
    const result = await getSitePostPublication({ draftId: 'd1' }, { ...API, fetchImpl })
    expect(result).toEqual(raw)
    expect(calls.some((c) => c.method === 'GET')).toBe(true)
  })

  test('⭐404 — SitePostDraftNotFoundError', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(JSON.stringify({ data: null, error: { message: 'not found' }, meta: null }), { status: 404 }),
    )
    await expect(getSitePostPublication({ draftId: 'd1' }, { ...API, fetchImpl })).rejects.toBeInstanceOf(SitePostDraftNotFoundError)
  })
})
