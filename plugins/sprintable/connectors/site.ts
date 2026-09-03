/**
 * story 4213f6c4(2026-09-03, PO 확定 — 선생님 «글 1편=커밋 1건은 구조적으로 틀림» 지적,
 * #3360 §4) — `site_git`(GitHub Contents API 커밋)을 대체하는 기본 채널. 발행이 서버
 * chokepoint(story #3360)로 옮겨갔다 — 이 커넥터는 그 API를 부르는 얇은 층일 뿐, GitHub
 * PAT도 저장소 좌표도 필요 없다(requiresEnv 0).
 *
 * 실물 계약(backend/app/routers/site_posts.py·services/site_posts.py 직접 확認, 추정 0):
 *   POST /api/v2/organizations/{org_id}/site-posts
 *   body: {work_item_id(필수 UUID), gate_id(선택), title, slug, lang, summary(필수),
 *          tags[], body_md}
 *   201: {id, slug, title, lang, published_at, gate_id} — url은 응답에 없다(site_git과
 *   동형으로 이 파일이 site_base_url+/{lang}/blog/{slug}로 직접 계산한다).
 *   403(ExternalPublishGateNotApprovedError): detail 문자열 자체에 이미 "gate_id=…,
 *   status=…"가 박혀 있다("external_publish 게이트가 승인되지 않았습니다(gate_id=…,
 *   status=…)" 또는 게이트 자체가 없으면 "이 work item에 승인된 external_publish 게이트가
 *   없습니다") — 이 파일은 그 문자열을 그대로 실어 throw한다(가공·재작성 0).
 *   422(InvalidSitePostInputError): slug/lang 형식(서버가 이미 검증 — 이 파일은 클라이언트
 *   쪽 재검증을 안 한다, site_git의 GitHub-경로-조작 위험과 달리 여긴 DB 값일 뿐이라
 *   traversal 클래스 위험이 없다).
 *
 * work_item_id는 서버 요청 바디에서 **항상 필수**(site_git 등 다른 커넥터의 "gateId
 * 또는 workItemId 둘 중 하나" 패턴과 다르다) — gate_id는 그 위에 얹는 선택적 명시 검증일
 * 뿐이다. 클라이언트 쪽 사전 게이트 확認(gate-check.ts)은 그대로 유지한다(PO 지시) —
 * 서버가 최종 판정하지만, 미승인 상태에서 API 호출 자체를 아끼는 fail-fast.
 */
import { assertGateApproved, assertGateApprovedForWorkItem } from './gate-check'

const EXTERNAL_PUBLISH_GATE_TYPE = 'external_publish'
const DEFAULT_WORK_ITEM_TYPE = 'story'

export interface SiteClientConfig {
  /** 공개 사이트의 base URL(예 `https://sprintable.ai`) — 응답의 예상 공개 URL 계산용
   * (site_git.ts와 동형, 서버 응답엔 url이 없다). */
  siteBaseUrl: string
}

export interface PublishSitePostParams {
  /** 서버 요청 바디에서 필수(선택 아님 — site_git 등 다른 커넥터와 다른 계약). */
  workItemId: string
  /** 명시하면 서버가 그 게이트 자체를 검증(work_item/타입 일치 포함), 없으면 서버가
   * 이 work item의 최신 external_publish 게이트를 찾는다. 클라이언트 사전 확認에도
   * 동일 우선순위로 쓰인다. */
  gateId?: string
  /** 기본 'story' — 클라이언트 사전 게이트 확認(gate-check.ts)에만 쓰인다(서버 요청
   * 바디엔 work_item_type 필드 자체가 없다, 실측). */
  workItemType?: string
  title: string
  /** 순수 markdown 본문 — 요청 바디의 body_md로 실린다. */
  body: string
  slug: string
  lang: string
  /** 서버가 필수로 받는다(site_git과 달리 선택 아님, 실측: min_length=1). */
  summary: string
  tags?: string[]
  sprintableApiUrl: string
  sprintableApiKey: string
  site: SiteClientConfig
  /** 테스트 전용 — assertGateApproved(ForWorkItem)에 넘길 fetch 스파이(site-posts API
   * 호출용 fetch와 별개). */
  gateCheckFetchImpl?: typeof fetch
  /** 테스트 전용 — site-posts POST 호출에 쓸 fetch 스파이. */
  fetchImpl?: typeof fetch
}

export interface PublishSitePostResult {
  id: string
  slug: string
  publishedAt: string
  /** siteBaseUrl + `/{lang}/blog/{slug}` — site_git.ts와 동형 계산(서버 응답엔 없다). */
  url: string
}

export class SitePostGateForbiddenError extends Error {
  constructor(detail: string) {
    // 서버 detail 문자열 자체에 이미 gate_id·status가 박혀 있다 — 재가공하지 않는다
    // (PO AC: "미승인 → 서버 403이 도구 에러 문구에 gate_id·status와 함께 실린다").
    super(detail)
    this.name = 'SitePostGateForbiddenError'
  }
}

export class SitePostInvalidInputError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'SitePostInvalidInputError'
  }
}

async function assertPublishGateApproved(params: PublishSitePostParams): Promise<void> {
  if (params.gateId) {
    await assertGateApproved(
      params.gateId, params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
    )
    return
  }
  await assertGateApprovedForWorkItem(
    params.workItemId, params.workItemType ?? DEFAULT_WORK_ITEM_TYPE, EXTERNAL_PUBLISH_GATE_TYPE,
    params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
  )
}

interface SitePostApiResponse {
  id: string
  slug: string
  title: string
  lang: string
  published_at: string
  gate_id: string
}

/**
 * 단일 chokepoint — 함수 진입 직후, API POST 호출보다 먼저(어떤 site-posts 호출도 미승인
 * 상태에선 0건). 다른 커넥터들의 "2 chokepoint"(create+publish 등 2회 왕복 사이 레이스
 * 방어)와 다르다 — 여긴 왕복이 1번뿐이라 그 사이에 낄 두 번째 호출 자체가 없다(서버가
 * 그 순간 자신의 판정으로 최종 승인 여부를 다시 잰다 — 클라이언트 쪽 재확認은 무의미한
 * 반복일 뿐, PO 지시 "서버가 최종 판정"). 지우면(뮤테이션) pending/rejected 게이트로도
 * POST가 나가야 정상 — site.test.ts가 그 갈림을 pin한다.
 */
export async function publishSitePost(
  params: PublishSitePostParams,
): Promise<PublishSitePostResult> {
  await assertPublishGateApproved(params)

  const fetchImpl = params.fetchImpl ?? fetch
  const url = `${params.sprintableApiUrl.replace(/\/$/, '')}/api/v2/organizations/${await resolveOrgIdFor(params)}/site-posts`
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.sprintableApiKey}`,
      'x-agent-api-key': params.sprintableApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      work_item_id: params.workItemId,
      ...(params.gateId ? { gate_id: params.gateId } : {}),
      title: params.title,
      slug: params.slug,
      lang: params.lang,
      summary: params.summary,
      tags: params.tags ?? [],
      body_md: params.body,
    }),
  })

  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new SitePostGateForbiddenError(body.detail ?? 'external_publish gate not approved')
  }
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new SitePostInvalidInputError(body.detail ?? 'invalid site post input')
  }
  if (!res.ok) throw new Error(`site post publish failed: ${res.status}`)

  const entry = (await res.json()) as SitePostApiResponse
  return {
    id: entry.id,
    slug: entry.slug,
    publishedAt: entry.published_at,
    url: `${params.site.siteBaseUrl.replace(/\/$/, '')}/${entry.lang}/blog/${entry.slug}`,
  }
}

/** org_id는 URL 경로에 필요한데 이 커넥터는 자기 org_id를 모른다 — registry.ts::
 * resolveOrgId()(GET /api/v2/auth/me, 캐싱 0)를 그대로 재사용한다(새 org 해소 로직
 * 발명 0). 순환 import를 피하려 이 함수 안에서 지연 import한다(connectors/registry.ts가
 * connector-schema.ts를 참조하지만 site.ts는 그 반대 방향 의존이 없다 — 안전). */
async function resolveOrgIdFor(params: PublishSitePostParams): Promise<string> {
  const { resolveOrgId } = await import('./registry')
  return resolveOrgId({
    apiUrl: params.sprintableApiUrl, apiKey: params.sprintableApiKey, fetchImpl: params.fetchImpl,
  })
}
