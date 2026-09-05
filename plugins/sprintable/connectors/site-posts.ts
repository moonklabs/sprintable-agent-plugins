/**
 * story #3489([Phase1·플러그인] 고객 에이전트용 발행 도구 셋, 페드루 PO 確定
 * 2026-09-05, 미르코 그라운딩 ③ 위) — site_posts(블로그 원문) 초안·상신·발행 결과
 * 읽기의 첫 플러그인 표면. 서버 계약은 backend/app/routers/site_posts.py를 직접
 * 확認(추측 0):
 *   POST .../site-posts/drafts(생성/수정 겸용, :265-273 "고객 에이전트·휴먼 공용")
 *   POST .../site-posts/drafts/{id}/submit(:462-471 "에이전트 키도 호출 가능 —
 *     게이트 생성까지만 허용, external_publish는 human-only 승인")
 *   GET  .../site-posts/drafts/{id}/publication(:684-693 "조직 멤버(휴먼·에이전트
 *     모두) 읽기 가능")
 *
 * channel-posts.ts와 같은 관례(새 패턴 발명 0) — registry.ts의 resolveOrgId/
 * authHeaders, 실서버 에러 봉투 파싱(#3410 정정 그대로, `body.error`가 정본)은
 * channel-posts.ts에서 import해 재사용(parseErrorDetail·ContentRuleViolationError
 * — CONTENT_RULE_VIOLATION shape이 channel_post/site_post 양쪽에서 완전히 동일).
 *
 * ⚠️휴먼 전용 단계(POST .../site-posts — 공개 발행 자체, site_posts.py:222-231
 * `SITE_POST_PUBLISH_HUMAN_ONLY` 가드)는 이 파일에 없다 — channel-posts.ts의 AC4와
 * 동형 이중 방어.
 *
 * 진단은 지어내지 않는다(channel-posts.ts AC2와 동형 규율) — 알려진 리터럴만 전용
 * 클래스로 승격하고, 미지 code는 기반 클래스(SitePostApiError) 그대로 던진다.
 */
import { resolveOrgId } from './registry'
import { parseErrorDetail, ContentRuleViolationError, type ParsedErrorDetail } from './channel-posts'

export interface SitePostsClientConfig {
  apiUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}`, 'x-agent-api-key': apiKey, 'Content-Type': 'application/json' }
}

function apiBase(apiUrl: string): string {
  return apiUrl.replace(/\/$/, '')
}

/** channel-posts.ts::ChannelPostApiError와 동형(공유 기반은 두지 않는다 — "ChannelPost"
 * 이름의 클래스를 site_post 코드가 던지면 오분류처럼 읽힌다는 게 이 파일이 그 클래스를
 * 상속하지 않는 이유, ContentRuleViolationError의 동일 판단과 같다). */
export class SitePostApiError extends Error {
  public readonly code: string

  constructor(
    message: string,
    code: string | undefined,
    public readonly httpStatus: number,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'SitePostApiError'
    this.code = code ?? `HTTP_${httpStatus}`
  }
}

export class SitePostConnectionNotFoundError extends SitePostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'SITE_POST_CONNECTION_NOT_FOUND', httpStatus, detail)
    this.name = 'SitePostConnectionNotFoundError'
  }
}

export class SitePostCampaignNotFoundError extends SitePostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'CAMPAIGN_NOT_FOUND', httpStatus, detail)
    this.name = 'SitePostCampaignNotFoundError'
  }
}

export class SitePostDestinationKindMismatchError extends SitePostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'SITE_POST_DESTINATION_KIND_MISMATCH', httpStatus, detail)
    this.name = 'SitePostDestinationKindMismatchError'
  }
}

export class SitePostMediaNotSupportedError extends SitePostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'MEDIA_NOT_SUPPORTED_PHASE0', httpStatus, detail)
    this.name = 'SitePostMediaNotSupportedError'
  }
}

export class SitePostDraftNotFoundError extends SitePostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    // channel-posts.ts::ChannelPostDraftNotFoundError와 동형 — 서버 404 detail은
    // 평문 문자열뿐이지만(code 없음), 이 클래스 자체가 "draft 없음"을 이미 안다.
    super(message, 'SITE_POST_DRAFT_NOT_FOUND', httpStatus, detail)
    this.name = 'SitePostDraftNotFoundError'
  }
}

export class SitePostVersionNotFoundError extends SitePostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'SITE_POST_VERSION_NOT_FOUND', httpStatus, detail)
    this.name = 'SitePostVersionNotFoundError'
  }
}

export class SitePostApproverRoleMissingError extends SitePostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'SITE_POST_APPROVER_ROLE_MISSING', httpStatus, detail)
    this.name = 'SitePostApproverRoleMissingError'
  }
}

/** site_posts.py::SitePostGateAlreadyHeldError(:493-499)와 동형 — holding_lang·
 * holding_slug는 channel_post의 holding_channel 자리를 대신한다(도메인마다 "무엇이
 * 겹치는지"의 축이 다르다 — slug/lang 조합이 site_post의 멱등 단위). */
export class SitePostGateAlreadyHeldError extends SitePostApiError {
  constructor(
    message: string, httpStatus: number,
    public readonly holdingDraftId: string | undefined,
    public readonly holdingLang: string | undefined,
    public readonly holdingSlug: string | undefined,
    detail?: unknown,
  ) {
    super(message, 'SITE_POST_GATE_ALREADY_HELD', httpStatus, detail)
    this.name = 'SitePostGateAlreadyHeldError'
  }
}

export interface CreateOrUpdateSitePostDraftParams {
  workItemId: string
  title: string
  slug: string
  lang: string
  summary: string
  bodyMd: string
  tags?: string[]
  mediaManifest?: unknown[]
  campaignId?: string
  /** 생략=캐리포워드, 명시 null=hosted_site로 해제, 값=변경(site_posts.py의
   * model_fields_set 센티널 계약과 동형 — 이 파라미터 자체를 안 주면 서버 요청 body에도
   * 키를 안 실어 캐리포워드를 그대로 보존한다, 아래 구현 참고). */
  connectionId?: string | null
}

export interface SitePostDraftVersionResult {
  draftId: string
  versionId: string
  version: number
  authorKind: string
  bodySha256: string
  violations: unknown[]
}

function throwFor4xx(res: Response, detail: ParsedErrorDetail): never {
  const { code, message, detail: rawDetail } = detail
  throw new SitePostApiError(message ?? `HTTP ${res.status}`, code, res.status, rawDetail)
}

/**
 * POST /organizations/{org}/site-posts/drafts(#3365) — 초안 생성/수정 겸용.
 */
export async function createOrUpdateSitePostDraft(
  params: CreateOrUpdateSitePostDraftParams,
  api: SitePostsClientConfig,
): Promise<SitePostDraftVersionResult> {
  const orgId = await resolveOrgId(api)
  const fetchImpl = api.fetchImpl ?? fetch
  const body: Record<string, unknown> = {
    work_item_id: params.workItemId, title: params.title, slug: params.slug, lang: params.lang,
    summary: params.summary, tags: params.tags ?? [], body_md: params.bodyMd,
    media_manifest: params.mediaManifest ?? [],
  }
  if (params.campaignId !== undefined) body.campaign_id = params.campaignId
  // connectionId===undefined(파라미터 자체를 안 줌) → body에 키 자체를 안 실어 서버의
  // model_fields_set 캐리포워드가 작동한다. null(명시 해제)/문자열(변경)은 그대로 싣는다.
  if (params.connectionId !== undefined) body.connection_id = params.connectionId

  const res = await fetchImpl(`${apiBase(api.apiUrl)}/api/v2/organizations/${orgId}/site-posts/drafts`, {
    method: 'POST', headers: authHeaders(api.apiKey), body: JSON.stringify(body),
  })

  if (res.status === 422) {
    const parsed = await parseErrorDetail(res)
    if (parsed.code === 'CONTENT_RULE_VIOLATION') {
      const rulesVersion = typeof parsed.detail?.rules_version === 'number' ? (parsed.detail.rules_version as number) : undefined
      const violations = Array.isArray(parsed.detail?.violations) ? (parsed.detail.violations as unknown[]) : []
      throw new ContentRuleViolationError(parsed.message ?? 'content rule violation', 422, rulesVersion, violations, parsed.detail)
    }
    if (parsed.code === 'CAMPAIGN_NOT_FOUND') throw new SitePostCampaignNotFoundError(parsed.message ?? 'campaign not found', 422, parsed.detail)
    if (parsed.code === 'SITE_POST_CONNECTION_NOT_FOUND') throw new SitePostConnectionNotFoundError(parsed.message ?? 'connection not found', 422, parsed.detail)
    if (parsed.code === 'SITE_POST_DESTINATION_KIND_MISMATCH') throw new SitePostDestinationKindMismatchError(parsed.message ?? 'destination kind mismatch', 422, parsed.detail)
    if (parsed.code === 'MEDIA_NOT_SUPPORTED_PHASE0') throw new SitePostMediaNotSupportedError(parsed.message ?? 'media not supported', 422, parsed.detail)
    throwFor4xx(res, parsed)
  }
  if (!res.ok) throw new SitePostApiError(`site post draft create/update failed: ${res.status}`, undefined, res.status)

  const respBody = (await res.json()) as {
    draft_id: string; version_id: string; version: number; author_kind: string; body_sha256: string; violations: unknown[]
  }
  return {
    draftId: respBody.draft_id, versionId: respBody.version_id, version: respBody.version,
    authorKind: respBody.author_kind, bodySha256: respBody.body_sha256, violations: respBody.violations,
  }
}

export interface SubmitSitePostDraftParams {
  draftId: string
  versionId?: string
}

export interface SubmitSitePostDraftResult {
  gateId: string
  versionId: string
  contentSha256: string
  status: string
}

/**
 * POST /organizations/{org}/site-posts/drafts/{draftId}/submit(#3365 S2) —
 * external_publish 게이트로 상신. site_posts.py 실측(2026-09-03): 에이전트 키도
 * 호출 가능 — 게이트 생성까지만, 승인/발행은 human-only.
 */
export async function submitSitePostDraft(
  params: SubmitSitePostDraftParams,
  api: SitePostsClientConfig,
): Promise<SubmitSitePostDraftResult> {
  const orgId = await resolveOrgId(api)
  const fetchImpl = api.fetchImpl ?? fetch
  const res = await fetchImpl(
    `${apiBase(api.apiUrl)}/api/v2/organizations/${orgId}/site-posts/drafts/${params.draftId}/submit`,
    { method: 'POST', headers: authHeaders(api.apiKey), body: JSON.stringify({ version_id: params.versionId ?? null }) },
  )

  if (res.status === 404) {
    // site_posts.py는 draft-not-found·version-not-found를 둘 다 평문 문자열 404로
    // 던진다(SitePostDraftNotFoundError/SitePostVersionNotFoundError, 서로 구별되는
    // code가 없다) — 이 함수도 그 사실 그대로, DraftNotFound로 합쳐서 던지지 않고
    // 서버 메시지를 그대로 보존한다(어느 쪽인지는 message 본문이 말해준다).
    const { message, detail } = await parseErrorDetail(res)
    throw new SitePostDraftNotFoundError(message ?? `draft or version not found: ${params.draftId}`, 404, detail)
  }
  if (res.status === 409) {
    const { code, message, detail } = await parseErrorDetail(res)
    if (code === 'SITE_POST_APPROVER_ROLE_MISSING') {
      throw new SitePostApproverRoleMissingError(message ?? 'approver role missing', 409, detail)
    }
    if (code === 'SITE_POST_GATE_ALREADY_HELD') {
      const holdingDraftId = typeof detail?.holding_draft_id === 'string' ? (detail.holding_draft_id as string) : undefined
      const holdingLang = typeof detail?.holding_lang === 'string' ? (detail.holding_lang as string) : undefined
      const holdingSlug = typeof detail?.holding_slug === 'string' ? (detail.holding_slug as string) : undefined
      throw new SitePostGateAlreadyHeldError(
        message ?? 'gate already held by another draft', 409, holdingDraftId, holdingLang, holdingSlug, detail,
      )
    }
    throw new SitePostApiError(message ?? 'HTTP 409', code, 409, detail)
  }
  if (res.status === 422) {
    const parsed = await parseErrorDetail(res)
    if (parsed.code === 'CONTENT_RULE_VIOLATION') {
      const rulesVersion = typeof parsed.detail?.rules_version === 'number' ? (parsed.detail.rules_version as number) : undefined
      const violations = Array.isArray(parsed.detail?.violations) ? (parsed.detail.violations as unknown[]) : []
      throw new ContentRuleViolationError(parsed.message ?? 'content rule violation', 422, rulesVersion, violations, parsed.detail)
    }
    throwFor4xx(res, parsed)
  }
  if (!res.ok) throw new SitePostApiError(`site post draft submit failed: ${res.status}`, undefined, res.status)

  const body = (await res.json()) as { gate_id: string; version_id: string; content_sha256: string; status: string }
  return { gateId: body.gate_id, versionId: body.version_id, contentSha256: body.content_sha256, status: body.status }
}

/**
 * GET /organizations/{org}/site-posts/drafts/{draftId}/publication(#3386/#3476) —
 * 발행 결과 읽기. channel-posts.ts::getChannelPostPublication과 동일 판단 — 응답을
 * 재가공하지 않고 그대로 돌려준다(destination·channel_publication·command가 중첩
 * 객체라 exhaustive 재타이핑은 그 자체로 드리프트 위험, "얇은 미러" 정신에 더 맞다).
 */
export async function getSitePostPublication(
  params: { draftId: string },
  api: SitePostsClientConfig,
): Promise<Record<string, unknown>> {
  const orgId = await resolveOrgId(api)
  const fetchImpl = api.fetchImpl ?? fetch
  const res = await fetchImpl(
    `${apiBase(api.apiUrl)}/api/v2/organizations/${orgId}/site-posts/drafts/${params.draftId}/publication`,
    { headers: authHeaders(api.apiKey) },
  )
  if (res.status === 404) {
    const { message, detail } = await parseErrorDetail(res)
    throw new SitePostDraftNotFoundError(message ?? `draft not found: ${params.draftId}`, 404, detail)
  }
  if (!res.ok) throw new SitePostApiError(`site post publication read failed: ${res.status}`, undefined, res.status)
  return (await res.json()) as Record<string, unknown>
}
