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
import { assertGateApproved, assertGateApprovedForWorkItem } from './gate-check'
import { assertExternalPublishNotFrozen } from './publish-freeze'

const EXTERNAL_PUBLISH_GATE_TYPE = 'external_publish'
const DEFAULT_WORK_ITEM_TYPE = 'story'

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
  /** 명시 경로(수동 호출·테스트 호환) — 있으면 이 경로가 우선한다. */
  gateId?: string
  /** work_item 경로(story #3312 AC5) — gateId가 없을 때 이 work item의 최신
   * external_publish 게이트를 조회해 판정한다. gateId·workItemId 둘 다 없으면 즉시
   * 명시 에러(네트워크 호출 0건, draft 준비도 시작 안 함). */
  workItemId?: string
  /** 기본 'story'(threads.ts와 동형 — 오타 방지 목적일 뿐 조직 규칙 아님). */
  workItemType?: string
  content: StibeeCampaignContent
  sprintableApiUrl: string
  sprintableApiKey: string
  stibee: StibeeClientConfig
  /** 테스트 전용 — assertGateApproved(ForWorkItem)에 넘길 fetch 스파이(스티비 호출용
   * fetch와 별개). */
  gateCheckFetchImpl?: typeof fetch
}

export interface PublishStibeeCampaignResult {
  emailId: number
}

/**
 * gateId 명시 경로 또는 work_item 해석 경로(story #3312 AC5) 중 하나로 게이트 승인을
 * 확認한다 — threads.ts::assertPublishGateApproved와 동형(새 게이트 로직 발명 0,
 * gate-check.ts의 두 검증 함수를 그대로 위임).
 */
async function assertPublishGateApproved(params: PublishStibeeCampaignParams): Promise<void> {
  if (params.gateId) {
    await assertGateApproved(
      params.gateId, params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
    )
    return
  }
  if (params.workItemId) {
    await assertGateApprovedForWorkItem(
      params.workItemId, params.workItemType ?? DEFAULT_WORK_ITEM_TYPE, EXTERNAL_PUBLISH_GATE_TYPE,
      params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
    )
    return
  }
  throw new Error('publishStibeeCampaign requires either gateId or workItemId to check the external_publish gate')
}

/**
 * story 6f2034cf(2026-09-02, PO 확定) — 두 chokepoint로 정정(threads.ts §PR#29 PO AC
 * 리뷰와 동형 배치로 통일). 예전 가정("draft 준비=create→content→update는 게이트와
 * 무관하게 항상 진행, send만 chokepoint")은 스티비도 예외가 아니었다 — create/content/
 * update 전부 스티비 시스템에 실제로 남는 외부 쓰기(POST/PUT)라 "자기 시스템 내부 상태
 * 변경"이 아니다(그 draft가 실제로 스티비 계정에 생성되는 순간 이미 그 조직 밖으로
 * 나간 것 — 미승인 상태에서 이 정도의 부작용조차 없어야 한다는 게 제품 원칙3 「밖으로
 * 나가는 건 사람 승인 뒤에서만」의 정확한 요구).
 *   1) 첫 chokepoint — 함수 진입 직후, 어떤 스티비 호출(create 포함)보다도 먼저.
 *      미승인이면 이 시점에서 outbound 호출이 정확히 0건.
 *   2) 둘째 chokepoint — send 호출 바로 앞(threads.ts와 동형) — 1)과 2) 사이(create→
 *      content→update)에 승인이 철회되는 레이스를 막는 재확認.
 * gateId·workItemId 부재 체크는 그보다도 먼저다(둘 다 없으면 그 자리에서 즉시 에러,
 * 스티비 호출 0건 — 파라미터 형태 검증은 게이트 조회 자체보다 싸다).
 */
export async function publishStibeeCampaign(
  params: PublishStibeeCampaignParams,
): Promise<PublishStibeeCampaignResult> {
  // ⭐story #3366 — 함수의 가장 첫 줄. gateId/workItemId 존재 검사보다도, draft 준비
  // (create/content/update)보다도 먼저(뮤테이션 표적: 이 줄을 아래로 옮기면 fetch spy가
  // 0을 벗어나야 정상 — stibee.test.ts가 그 갈림을 pin한다).
  assertExternalPublishNotFrozen('publish_stibee_campaign')

  if (!params.gateId && !params.workItemId) {
    throw new Error('publishStibeeCampaign requires either gateId or workItemId to check the external_publish gate')
  }

  // ⭐chokepoint① — create/content/update 등 어떤 스티비 호출보다도 먼저. 미승인이면
  // 여기서 throw — outbound 정확히 0건. 이 줄을 지우거나 아래로 옮기면(뮤테이션)
  // pending/rejected 게이트로도 create가 나가야 정상 — stibee.test.ts가 그 갈림을 pin한다.
  await assertPublishGateApproved(params)

  const { id } = await stibeeCreateEmail(params.content.create, params.stibee)
  await stibeeSetContent(id, params.content.html, params.stibee)
  if (params.content.update) {
    await stibeeUpdateEmail(id, params.content.update, params.stibee)
  }

  // ⭐chokepoint② — send 호출 바로 앞의 마지막 줄(레이스 방어: ①과 이 사이에 승인이
  // 철회됐을 수 있다). 이 줄을 지우거나 위로 옮기면(뮤테이션) ①통과 후 철회된 게이트로도
  // send가 나가야 정상 — stibee.test.ts가 그 갈림을 pin한다.
  await assertPublishGateApproved(params)

  await stibeeSendEmail(id, params.stibee)
  return { emailId: id }
}
