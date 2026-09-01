/**
 * story #3292([M1·마케팅자동화] 발행 커넥터, 첫 채널=스티비) — doc
 * stibee-publish-connector-wiring-design-3292 그대로 구현. 4개 엔드포인트(전부
 * developers.stibee.com 실 레퍼런스 페이지로 직접 확인, 추정 아님):
 *
 *   1. POST /v2/emails             — 생성(draft) → {id}
 *   2. POST /v2/emails/{id}/content — 본문(Content-Type: text/html, raw HTML body)
 *   3. PUT  /v2/emails/{id}        — 메타(선택 — subject/발신자/타겟팅을 create 이후 바꿀 때만)
 *   4. POST /v2/emails/{id}/send   — 발송(body 없음) ← chokepoint가 이 호출 직전
 *
 * ⚠️전부 "일반 이메일"만 대상(자동 이메일 미지원) — content/PUT은 draft 상태에서만 동작.
 * ⚠️M1 스코프 — 실계정 실발행은 M3(별도 사람 승인). 이 모듈 자체는 축 무관하게 항상
 * chokepoint를 강제한다(dry-run 여부는 호출부/환경 문제, 이 모듈이 판단하지 않는다).
 */
import { assertGateApproved } from './gate-check'

const STIBEE_BASE = 'https://api.stibee.com/v2'

export interface CreateEmailRequest {
  listId: number
  senderEmail: string
  senderName: string
  subject: string
  groupIds?: number[]
  segmentIds?: number[]
}

export interface UpdateEmailRequest {
  subject?: string
  senderEmail?: string
  senderName?: string
  listId?: number
  groupIds?: number[]
  segmentIds?: number[]
  abRatio?: number
  subjectA?: string
  subjectB?: string
  senderNameA?: string
  senderNameB?: string
  subType?: number
}

export interface StibeeCampaignContent {
  create: CreateEmailRequest
  html: string
  update?: UpdateEmailRequest
}

export interface StibeeClientConfig {
  accessToken: string
  fetchImpl?: typeof fetch
}

function stibeeHeaders(accessToken: string, contentType?: string): HeadersInit {
  const headers: Record<string, string> = { AccessToken: accessToken }
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

async function stibeeCreateEmail(
  body: CreateEmailRequest, config: StibeeClientConfig,
): Promise<{ id: number }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(`${STIBEE_BASE}/emails`, {
    method: 'POST',
    headers: stibeeHeaders(config.accessToken, 'application/json'),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`stibee create email failed: ${res.status}`)
  return (await res.json()) as { id: number }
}

async function stibeeSetContent(
  emailId: number, html: string, config: StibeeClientConfig,
): Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch
  // ⚠️text/html — JSON 래핑 아님(developers.stibee.com 실측, 이전 초안의 PUT 추정을 정정).
  const res = await fetchImpl(`${STIBEE_BASE}/emails/${emailId}/content`, {
    method: 'POST',
    headers: stibeeHeaders(config.accessToken, 'text/html'),
    body: html,
  })
  if (!res.ok) throw new Error(`stibee set content failed: ${res.status}`)
}

async function stibeeUpdateEmail(
  emailId: number, body: UpdateEmailRequest, config: StibeeClientConfig,
): Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(`${STIBEE_BASE}/emails/${emailId}`, {
    method: 'PUT',
    headers: stibeeHeaders(config.accessToken, 'application/json'),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`stibee update email failed: ${res.status}`)
}

async function stibeeSendEmail(emailId: number, config: StibeeClientConfig): Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(`${STIBEE_BASE}/emails/${emailId}/send`, {
    method: 'POST',
    headers: stibeeHeaders(config.accessToken),
  })
  if (!res.ok) throw new Error(`stibee send failed: ${res.status}`)
}

export interface PublishStibeeCampaignParams {
  gateId: string
  content: StibeeCampaignContent
  sprintableApiUrl: string
  sprintableApiKey: string
  stibee: StibeeClientConfig
  /** 테스트 전용 — assertGateApproved에 넘길 fetch 스파이(스티비 호출용 fetch와 별개). */
  gateCheckFetchImpl?: typeof fetch
}

export interface PublishStibeeCampaignResult {
  emailId: number
}

/**
 * draft 준비(create→content→update)는 게이트 승인과 무관하게 항상 진행된다 — "밖으로
 * 나가는" 마지막 한 걸음(send)만 chokepoint 대상이다(doc §③). assertGateApproved가
 * 여기서 throw하면 send는 절대 호출되지 않는다 — 이 함수가 이 스토리의 핵심 계약.
 */
export async function publishStibeeCampaign(
  params: PublishStibeeCampaignParams,
): Promise<PublishStibeeCampaignResult> {
  const { id } = await stibeeCreateEmail(params.content.create, params.stibee)
  await stibeeSetContent(id, params.content.html, params.stibee)
  if (params.content.update) {
    await stibeeUpdateEmail(id, params.content.update, params.stibee)
  }

  // ⭐chokepoint — send 호출 바로 앞의 마지막 줄(doc §③, PO 리뷰 확인 포인트). 이 줄을
  // 지우거나 위로 옮기면(뮤테이션) pending/rejected 게이트로도 send가 나가야 정상 —
  // stibee.test.ts가 그 갈림을 pin한다.
  await assertGateApproved(
    params.gateId, params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
  )

  await stibeeSendEmail(id, params.stibee)
  return { emailId: id }
}
