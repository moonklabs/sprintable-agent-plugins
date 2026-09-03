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

export class ChannelPostConnectionNotActiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelPostConnectionNotActiveError'
  }
}

export class ChannelPostTextTooLongError extends Error {
  constructor(message: string, public readonly maxLength?: number, public readonly currentLength?: number) {
    super(message)
    this.name = 'ChannelPostTextTooLongError'
  }
}

export class ChannelPostApproverRoleMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelPostApproverRoleMissingError'
  }
}

export class ChannelPostDraftNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelPostDraftNotFoundError'
  }
}

async function parseErrorDetail(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') return { message: body.detail }
    if (body.detail && typeof body.detail === 'object') {
      const d = body.detail as Record<string, unknown>
      return { code: typeof d.code === 'string' ? d.code : undefined, message: typeof d.message === 'string' ? d.message : undefined }
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
    const { message } = await parseErrorDetail(res)
    throw new ChannelPostConnectionNotActiveError(message ?? 'channel connection is not active')
  }
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { detail?: { message?: string; max_length?: number; current_length?: number } }
    throw new ChannelPostTextTooLongError(
      body.detail?.message ?? 'text too long', body.detail?.max_length, body.detail?.current_length,
    )
  }
  if (!res.ok) throw new Error(`channel post draft create/update failed: ${res.status}`)

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
    const { message } = await parseErrorDetail(res)
    throw new ChannelPostDraftNotFoundError(message ?? `draft or version not found: ${params.draftId}`)
  }
  if (res.status === 409) {
    const { code, message } = await parseErrorDetail(res)
    if (code === 'CHANNEL_POST_APPROVER_ROLE_MISSING') {
      throw new ChannelPostApproverRoleMissingError(message ?? 'approver role missing')
    }
    throw new ChannelPostConnectionNotActiveError(message ?? 'channel connection is not active')
  }
  if (!res.ok) throw new Error(`channel post draft submit failed: ${res.status}`)

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
  if (!res.ok) throw new Error(`channel connections list failed: ${res.status}`)
  const body = (await res.json()) as { id: string; channel: string; account_label: string | null; status: string }[]
  return body.map((r) => ({ id: r.id, channel: r.channel, accountLabel: r.account_label, status: r.status }))
}
