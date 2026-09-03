/**
 * story #3399(2026-09-04, 페드루 PO 확定) — publish_threads_post(에이전트 직접 발행) 삭제의
 * 대체 도구. 서버 계약은 backend/app/routers/channel_posts.py(#3374)를 직접 확認(추측 0):
 * POST .../channel-posts/drafts(생성/수정 겸용) · POST .../drafts/{id}/submit ·
 * GET .../channel-connections/agent-visible(#3758, AC8). 발행(POST .../publish)은 이
 * 커넥터에 없다 — 그 자체가 AC4(발행 미노출)의 정적 증거.
 */
import { describe, test, expect } from 'bun:test'
import {
  createOrUpdateChannelPostDraft,
  submitChannelPostDraft,
  listAgentVisibleChannelConnections,
  ChannelPostConnectionNotActiveError,
  ChannelPostTextTooLongError,
  ChannelPostApproverRoleMissingError,
  ChannelPostDraftNotFoundError,
} from './channel-posts'

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

describe('createOrUpdateChannelPostDraft (story #3399 AC2, server #3374)', () => {
  test('org_id를 resolveOrgId로 얻어 정확한 경로로 POST하고, 서버 응답을 그대로 매핑한다', async () => {
    const { calls, fetchImpl } = meAndEndpointSpy('org-1', (url, init) => {
      expect(url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/channel-posts/drafts')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(init?.body as string)
      expect(body).toEqual({
        work_item_id: 'wi-1', connection_id: 'conn-1', text: 'hello', link_url: null,
      })
      return new Response(
        JSON.stringify({
          draft_id: 'draft-1', version_id: 'ver-1', version: 1, author_kind: 'agent',
          body_sha256: 'sha', tagged_link_preview: null,
        }),
        { status: 201 },
      )
    })

    const result = await createOrUpdateChannelPostDraft(
      { workItemId: 'wi-1', connectionId: 'conn-1', text: 'hello' },
      { ...API, fetchImpl },
    )
    expect(result).toEqual({
      draftId: 'draft-1', versionId: 'ver-1', version: 1, authorKind: 'agent',
      bodySha256: 'sha', taggedLinkPreview: null,
    })
    expect(calls.some((c) => c.url.includes('/auth/me'))).toBe(true)
  })

  test('link_url을 주면 body에 실리고, 응답의 tagged_link_preview를 그대로 돌려준다', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', (_url, init) => {
      const body = JSON.parse(init?.body as string)
      expect(body.link_url).toBe('https://example.com/x')
      return new Response(
        JSON.stringify({
          draft_id: 'draft-1', version_id: 'ver-2', version: 2, author_kind: 'agent',
          body_sha256: 'sha2', tagged_link_preview: 'https://sprint.able/l/draft-1',
        }),
        { status: 201 },
      )
    })
    const result = await createOrUpdateChannelPostDraft(
      { workItemId: 'wi-1', connectionId: 'conn-1', text: 'hello', linkUrl: 'https://example.com/x' },
      { ...API, fetchImpl },
    )
    expect(result.taggedLinkPreview).toBe('https://sprint.able/l/draft-1')
  })

  test('⭐409 CHANNEL_CONNECTION_NOT_ACTIVE는 그대로 옮긴다(가공·재작성 0)', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(
        JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_NOT_ACTIVE', message: '연결이 비활성입니다' } }),
        { status: 409 },
      ),
    )
    await expect(
      createOrUpdateChannelPostDraft({ workItemId: 'wi-1', connectionId: 'conn-1', text: 'hi' }, { ...API, fetchImpl }),
    ).rejects.toThrow(ChannelPostConnectionNotActiveError)
  })

  test('⭐422 CHANNEL_TEXT_TOO_LONG — max_length/current_length를 지어내지 않고 서버 값 그대로 싣는다', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(
        JSON.stringify({
          detail: { code: 'CHANNEL_TEXT_TOO_LONG', message: '너무 깁니다', max_length: 500, current_length: 640 },
        }),
        { status: 422 },
      ),
    )
    try {
      await createOrUpdateChannelPostDraft(
        { workItemId: 'wi-1', connectionId: 'conn-1', text: 'x'.repeat(640) }, { ...API, fetchImpl },
      )
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelPostTextTooLongError)
      expect((err as ChannelPostTextTooLongError).maxLength).toBe(500)
      expect((err as ChannelPostTextTooLongError).currentLength).toBe(640)
    }
  })

  test('그 외 non-2xx는 명시 에러(조용한 통과 금지)', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () => new Response('{}', { status: 500 }))
    await expect(
      createOrUpdateChannelPostDraft({ workItemId: 'wi-1', connectionId: 'conn-1', text: 'hi' }, { ...API, fetchImpl }),
    ).rejects.toThrow('channel post draft create/update failed: 500')
  })
})

describe('submitChannelPostDraft (story #3399 AC3, server #3374)', () => {
  test('version_id 생략 시 null로 보내고(서버가 최신 버전 해석), 응답을 그대로 매핑한다', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', (url, init) => {
      expect(url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/channel-posts/drafts/draft-1/submit')
      expect(JSON.parse(init?.body as string)).toEqual({ version_id: null })
      return new Response(
        JSON.stringify({ gate_id: 'gate-1', version_id: 'ver-1', content_sha256: 'sha', status: 'pending' }),
        { status: 200 },
      )
    })
    const result = await submitChannelPostDraft({ draftId: 'draft-1' }, { ...API, fetchImpl })
    expect(result).toEqual({ gateId: 'gate-1', versionId: 'ver-1', contentSha256: 'sha', status: 'pending' })
  })

  test('version_id를 명시하면 body에 그대로 실린다', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', (_url, init) => {
      expect(JSON.parse(init?.body as string)).toEqual({ version_id: 'ver-9' })
      return new Response(
        JSON.stringify({ gate_id: 'gate-1', version_id: 'ver-9', content_sha256: 'sha', status: 'pending' }),
        { status: 200 },
      )
    })
    await submitChannelPostDraft({ draftId: 'draft-1', versionId: 'ver-9' }, { ...API, fetchImpl })
  })

  test('⭐404는 ChannelPostDraftNotFoundError로 구별된다', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(JSON.stringify({ detail: 'draft를 찾을 수 없습니다: draft-x' }), { status: 404 }),
    )
    await expect(
      submitChannelPostDraft({ draftId: 'draft-x' }, { ...API, fetchImpl }),
    ).rejects.toThrow(ChannelPostDraftNotFoundError)
  })

  test('⭐409 CHANNEL_POST_APPROVER_ROLE_MISSING은 ChannelPostApproverRoleMissingError로 구별된다(다른 409와 분기)', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(
        JSON.stringify({ detail: { code: 'CHANNEL_POST_APPROVER_ROLE_MISSING', message: '승인자 역할이 없습니다' } }),
        { status: 409 },
      ),
    )
    await expect(
      submitChannelPostDraft({ draftId: 'draft-1' }, { ...API, fetchImpl }),
    ).rejects.toThrow(ChannelPostApproverRoleMissingError)
  })

  test('409 CHANNEL_CONNECTION_NOT_ACTIVE(다른 code)는 ChannelPostConnectionNotActiveError로 떨어진다', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () =>
      new Response(
        JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_NOT_ACTIVE', message: '연결이 비활성입니다' } }),
        { status: 409 },
      ),
    )
    await expect(
      submitChannelPostDraft({ draftId: 'draft-1' }, { ...API, fetchImpl }),
    ).rejects.toThrow(ChannelPostConnectionNotActiveError)
  })
})

describe('listAgentVisibleChannelConnections (story #3399 AC8/AC9, server #3758)', () => {
  test('agent-visible 경로로 GET하고 필드를 camelCase로 매핑한다', async () => {
    const { calls, fetchImpl } = meAndEndpointSpy('org-1', (url) => {
      expect(url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/channel-connections/agent-visible')
      return new Response(
        JSON.stringify([{ id: 'conn-1', channel: 'threads', account_label: '@sprintable_ai', status: 'active' }]),
        { status: 200 },
      )
    })
    const result = await listAgentVisibleChannelConnections({ ...API, fetchImpl })
    expect(result).toEqual([{ id: 'conn-1', channel: 'threads', accountLabel: '@sprintable_ai', status: 'active' }])
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/agent-visible'))).toBe(true)
  })

  test('non-2xx는 명시 에러', async () => {
    const { fetchImpl } = meAndEndpointSpy('org-1', () => new Response('{}', { status: 403 }))
    await expect(listAgentVisibleChannelConnections({ ...API, fetchImpl })).rejects.toThrow(
      'channel connections list failed: 403',
    )
  })
})

describe('AC4 — 발행(publish) 경로가 이 커넥터에 존재하지 않는다(정적 증거)', () => {
  test('이 파일이 export하는 함수 중 publish라는 이름을 가진 것이 없다', async () => {
    const mod = await import('./channel-posts')
    const exportNames = Object.keys(mod)
    expect(exportNames.some((n) => /publish/i.test(n))).toBe(false)
  })
})
