/**
 * story #3399(Phase1·마케팅운영, 페드루 PO 확定 2026-09-04) — publish_threads_post(에이전트
 * 직접 발행) 삭제의 대체 경로. 이 파일은 서버가 이미 갖고 있는 채널 포스트 초안·상신 API
 * (#3374, backend/app/routers/channel_posts.py)와 연결 목록 API(#3758, AC8)를 직접 부른다
 * — 새 패턴 발명 0, connectors/registry.ts의 resolveOrgId/authHeaders 관례를 그대로 재사용.
 *
 * ⚠️발행(POST .../publish)은 이 파일에 없다 — 서버가 human-only
 * (`CHANNEL_POST_PUBLISH_HUMAN_ONLY`, story f8f7cb0f)라 플러그인 레벨에서도 노출하지
 * 않는 게 이중 방어(story #3399 AC4). 에이전트가 할 수 있는 건 초안 생성/수정
 * (createOrUpdateChannelPostDraft)과 상신(submitChannelPostDraft)까지 — 승인·발행은
 * Sprintable 화면에서 사람이 한다.
 *
 * 에러는 서버가 준 detail을 가공·재작성 없이 그대로 옮긴다(site.ts/PR#38 선례 —
 * "지어내지 않는다") — 특히 CHANNEL_TEXT_TOO_LONG의 max_length/current_length는 채널마다
 * 다른 실측값이라 이 파일이 상한을 하드코딩하지 않는다.
 *
 * story #3405(2026-09-04, 페드루 PO 확定) — 모든 에러가 `ChannelPostApiError`를 상속해
 * `code`/`httpStatus`/`detail`을 싣는다(`../tool-error.ts::StructuredToolError` 계약).
 * server.ts의 공용 catch가 이 필드로 구조화 JSON을 조립하므로, 에이전트가 서버 원문
 * `code`·`detail`(holding_draft_id·max_length 등)을 그대로 파싱할 수 있다 — 예전엔
 * `err.message` 평문 한 줄로 뭉개졌다.
 *
 * ⭐진단은 지어내지 않는다(AC2) — 409/422 코드 매칭은 **알려진 리터럴만** 전용 클래스로
 * 승격하고, 매칭 안 되는(미지) code는 `ChannelPostApiError`(기반 클래스) 그대로 던진다.
 * "일단 비슷해 보이는 기존 클래스로 떨어뜨리는" 폴백은 절대 안 한다 — 오분류(예:
 * CHANNEL_POST_GATE_ALREADY_HELD를 "연결 비활성"으로 오진단)가 뭉개짐보다 나쁘다(페드루
 * 지적). 뮤테이션 표적: 이 규칙을 어기고 else 분기에서 특정 서브클래스를 던지면
 * `tool-error.test.ts`가 아니라 이 파일의 「미지 code는 특정 클래스로 안 떨어진다」
 * 테스트가 잡는다.
 */
import { resolveOrgId } from './registry'

export interface ChannelPostsClientConfig {
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

/**
 * story #3405 — 이 파일의 모든 에러가 공유하는 기반. `../tool-error.ts`가 duck-typing으로
 * 찾는 계약(`httpStatus: number` 존재)을 만족한다. **미지 code의 최종 낙착지**이기도
 * 하다 — 서버가 새 코드를 추가해도 이 클래스 그대로 code/message/detail을 보존해 던지므로
 * 플러그인이 그 코드를 몰라도 에이전트에게 원문이 살아서 간다(오분류보다 훨씬 안전).
 */
export class ChannelPostApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly httpStatus: number,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ChannelPostApiError'
  }
}

export class ChannelPostConnectionNotActiveError extends ChannelPostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'CHANNEL_CONNECTION_NOT_ACTIVE', httpStatus, detail)
    this.name = 'ChannelPostConnectionNotActiveError'
  }
}

export class ChannelPostTextTooLongError extends ChannelPostApiError {
  constructor(
    message: string, httpStatus: number,
    public readonly maxLength: number | undefined,
    public readonly currentLength: number | undefined,
    detail?: unknown,
  ) {
    super(message, 'CHANNEL_TEXT_TOO_LONG', httpStatus, detail)
    this.name = 'ChannelPostTextTooLongError'
  }
}

export class ChannelPostApproverRoleMissingError extends ChannelPostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, 'CHANNEL_POST_APPROVER_ROLE_MISSING', httpStatus, detail)
    this.name = 'ChannelPostApproverRoleMissingError'
  }
}

/** story #3404·서버가 이 코드를 신설한 뒤 이 플러그인이 처음으로 아는 전용 클래스 —
 * holding_draft_id 등을 타입 속성으로도 노출(문자열 파싱 없이 바로 쓸 수 있게), detail을
 * 통해서도 원문 그대로 보존(이중화가 아니라 편의 축약 — detail이 정본, 아래는 그 파생). */
export class ChannelPostGateAlreadyHeldError extends ChannelPostApiError {
  constructor(
    message: string, httpStatus: number,
    public readonly holdingDraftId: string | undefined,
    public readonly holdingChannel: string | undefined,
    public readonly holdingConnectionId: string | undefined,
    detail?: unknown,
  ) {
    super(message, 'CHANNEL_POST_GATE_ALREADY_HELD', httpStatus, detail)
    this.name = 'ChannelPostGateAlreadyHeldError'
  }
}

export class ChannelPostDraftNotFoundError extends ChannelPostApiError {
  constructor(message: string, httpStatus: number, detail?: unknown) {
    super(message, undefined, httpStatus, detail) // 서버가 404 detail을 평문 문자열로만 준다 — code 없음(지어내지 않는다).
    this.name = 'ChannelPostDraftNotFoundError'
  }
}

interface ParsedErrorDetail {
  code?: string
  message?: string
  /** 서버 detail이 객체였으면 그 원문 그대로(가공 0). 평문 문자열이었으면 undefined —
   * 이미 message에 담겼다. */
  detail?: Record<string, unknown>
}

async function parseErrorDetail(res: Response): Promise<ParsedErrorDetail> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') return { message: body.detail }
    if (body.detail && typeof body.detail === 'object') {
      const d = body.detail as Record<string, unknown>
      return {
        code: typeof d.code === 'string' ? d.code : undefined,
        message: typeof d.message === 'string' ? d.message : undefined,
        detail: d,
      }
    }
    return {}
  } catch {
    return {}
  }
}

export interface CreateOrUpdateChannelPostDraftParams {
  /** work_item이 이미 이 (connection_id) 조합의 초안을 갖고 있으면 서버가 새 버전을 만든다
   * (수정) — draft_id를 몰라도 되는 이유. */
  workItemId: string
  connectionId: string
  text: string
  linkUrl?: string
}

export interface ChannelPostDraftVersionResult {
  draftId: string
  versionId: string
  version: number
  authorKind: string
  bodySha256: string
  /** link_url을 줬을 때만 채워진다(없으면 null, 지어내지 않는다). */
  taggedLinkPreview: string | null
}

/**
 * POST /organizations/{org}/channel-posts/drafts(#3374) — 초안 생성/수정을 한 엔드포인트가
 * 겸한다(channel은 요청에 없다 — connection_id에서 서버가 derive, #3374 PO 정정: 클라이언트가
 * 실제와 다른 channel을 주장할 표면 자체를 없앤다).
 */
export async function createOrUpdateChannelPostDraft(
  params: CreateOrUpdateChannelPostDraftParams,
  api: ChannelPostsClientConfig,
): Promise<ChannelPostDraftVersionResult> {
  const orgId = await resolveOrgId(api)
  const fetchImpl = api.fetchImpl ?? fetch
  const res = await fetchImpl(`${apiBase(api.apiUrl)}/api/v2/organizations/${orgId}/channel-posts/drafts`, {
    method: 'POST',
    headers: authHeaders(api.apiKey),
    body: JSON.stringify({
      work_item_id: params.workItemId,
      connection_id: params.connectionId,
      text: params.text,
      link_url: params.linkUrl ?? null,
    }),
  })

  if (res.status === 409) {
    const { code, message, detail } = await parseErrorDetail(res)
    // ⭐AC2(story #3405) — 이 엔드포인트가 실제로 던지는 409는 지금 CHANNEL_CONNECTION_
    // NOT_ACTIVE 하나뿐이지만, 그 리터럴과 정확히 일치할 때만 전용 클래스로 승격한다.
    // 미지 code는 기반 클래스(ChannelPostApiError) 그대로 — "일단 이걸로" 추측 금지.
    if (code === 'CHANNEL_CONNECTION_NOT_ACTIVE') {
      throw new ChannelPostConnectionNotActiveError(message ?? 'channel connection is not active', 409, detail)
    }
    throw new ChannelPostApiError(message ?? `HTTP 409`, code, 409, detail)
  }
  if (res.status === 422) {
    const { code, message, detail } = await parseErrorDetail(res)
    if (code === 'CHANNEL_TEXT_TOO_LONG') {
      const maxLength = typeof detail?.max_length === 'number' ? (detail.max_length as number) : undefined
      const currentLength = typeof detail?.current_length === 'number' ? (detail.current_length as number) : undefined
      throw new ChannelPostTextTooLongError(message ?? 'text too long', 422, maxLength, currentLength, detail)
    }
    throw new ChannelPostApiError(message ?? `HTTP 422`, code, 422, detail)
  }
  if (!res.ok) throw new ChannelPostApiError(`channel post draft create/update failed: ${res.status}`, undefined, res.status)

  const body = (await res.json()) as {
    draft_id: string
    version_id: string
    version: number
    author_kind: string
    body_sha256: string
    tagged_link_preview: string | null
  }
  return {
    draftId: body.draft_id,
    versionId: body.version_id,
    version: body.version,
    authorKind: body.author_kind,
    bodySha256: body.body_sha256,
    taggedLinkPreview: body.tagged_link_preview,
  }
}

export interface SubmitChannelPostDraftParams {
  draftId: string
  /** 생략 시 서버가 최신 버전을 상신한다. */
  versionId?: string
}

export interface SubmitChannelPostDraftResult {
  gateId: string
  versionId: string
  contentSha256: string
  status: string
}

/**
 * POST /organizations/{org}/channel-posts/drafts/{draftId}/submit(#3374) — external_publish
 * 게이트로 상신. 서버 실측(2026-09-03): 에이전트 키도 호출 가능 — 승인·발행만 human-only,
 * 상신 자체는 actor_type 가드가 없다.
 */
export async function submitChannelPostDraft(
  params: SubmitChannelPostDraftParams,
  api: ChannelPostsClientConfig,
): Promise<SubmitChannelPostDraftResult> {
  const orgId = await resolveOrgId(api)
  const fetchImpl = api.fetchImpl ?? fetch
  const res = await fetchImpl(
    `${apiBase(api.apiUrl)}/api/v2/organizations/${orgId}/channel-posts/drafts/${params.draftId}/submit`,
    {
      method: 'POST',
      headers: authHeaders(api.apiKey),
      body: JSON.stringify({ version_id: params.versionId ?? null }),
    },
  )

  if (res.status === 404) {
    const { message, detail } = await parseErrorDetail(res)
    throw new ChannelPostDraftNotFoundError(message ?? `draft or version not found: ${params.draftId}`, 404, detail)
  }
  if (res.status === 409) {
    const { code, message, detail } = await parseErrorDetail(res)
    // ⭐AC2(story #3405) — 알려진 두 리터럴만 전용 클래스. story #3404가 신설한
    // CHANNEL_POST_GATE_ALREADY_HELD도 여기 명시 등록(예전엔 여기 없어 아래 default로
    // 떨어져 "연결 비활성"으로 오분류됐다 — story #3405의 핵심 발견). 그 외 미지 code는
    // 기반 클래스로 원문 그대로.
    if (code === 'CHANNEL_POST_APPROVER_ROLE_MISSING') {
      throw new ChannelPostApproverRoleMissingError(message ?? 'approver role missing', 409, detail)
    }
    if (code === 'CHANNEL_POST_GATE_ALREADY_HELD') {
      const holdingDraftId = typeof detail?.holding_draft_id === 'string' ? (detail.holding_draft_id as string) : undefined
      const holdingChannel = typeof detail?.holding_channel === 'string' ? (detail.holding_channel as string) : undefined
      const holdingConnectionId = typeof detail?.holding_connection_id === 'string' ? (detail.holding_connection_id as string) : undefined
      throw new ChannelPostGateAlreadyHeldError(
        message ?? 'gate already held by another draft', 409,
        holdingDraftId, holdingChannel, holdingConnectionId, detail,
      )
    }
    if (code === 'CHANNEL_CONNECTION_NOT_ACTIVE') {
      throw new ChannelPostConnectionNotActiveError(message ?? 'channel connection is not active', 409, detail)
    }
    throw new ChannelPostApiError(message ?? `HTTP 409`, code, 409, detail)
  }
  if (!res.ok) throw new ChannelPostApiError(`channel post draft submit failed: ${res.status}`, undefined, res.status)

  const body = (await res.json()) as { gate_id: string; version_id: string; content_sha256: string; status: string }
  return { gateId: body.gate_id, versionId: body.version_id, contentSha256: body.content_sha256, status: body.status }
}

export interface ChannelConnectionAgentVisible {
  id: string
  channel: string
  accountLabel: string | null
  status: string
}

/**
 * GET /organizations/{org}/channel-connections/agent-visible(#3758, story #3399 AC8) — 최소
 * 필드(id·channel·account_label·status)만. 기존 GET .../channel-connections(전체 필드)는
 * human-only라 에이전트가 connection_id를 알 방법이 그동안 전혀 없었다 — 이 함수가 그 갭을
 * 닫는다.
 */
export async function listAgentVisibleChannelConnections(
  api: ChannelPostsClientConfig,
): Promise<ChannelConnectionAgentVisible[]> {
  const orgId = await resolveOrgId(api)
  const fetchImpl = api.fetchImpl ?? fetch
  const res = await fetchImpl(
    `${apiBase(api.apiUrl)}/api/v2/organizations/${orgId}/channel-connections/agent-visible`,
    { headers: authHeaders(api.apiKey) },
  )
  if (!res.ok) throw new ChannelPostApiError(`channel connections list failed: ${res.status}`, undefined, res.status)
  const body = (await res.json()) as { id: string; channel: string; account_label: string | null; status: string }[]
  return body.map((r) => ({ id: r.id, channel: r.channel, accountLabel: r.account_label, status: r.status }))
}
