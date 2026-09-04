/**
 * story #3292([M1·마케팅자동화] 발행 커넥터) — "발행부 chokepoint". external_publish
 * 게이트(#3689, backend d78071a6c)는 서버측에서 그 gate_type이 org posture 무관 항상
 * pending임을 강제할 뿐 — 실제 발행 직전 gate.status 확인은 그 커밋이 명시한 대로 이
 * 커넥터의 책임이다.
 *
 * 이 함수를 부르는 자리는 (승인 시 SSE로 밀리는 알림·task WORKING 복귀 같은) 트리거
 * 신호를 받은 "뒤"라도 반드시 필요하다 — 그 신호는 트리거일 뿐 신뢰 근거가 아니다
 * (defense-in-depth, PO 리뷰 확인 포인트: doc stibee-publish-connector-wiring-design-3292
 * §③). 인증 관례는 hitl_approval_hook.py의 _post_message/_poll_for_decision과 동일
 * (Authorization Bearer + x-agent-api-key 헤더, agent API키) — 신규 인증 경로 발명 0.
 *
 * story #3406(2026-09-04) — 이 파일의 에러들은 전부 `code`(구조화 계약, `../tool-error.ts`)
 * 를 갖는다. `GateNotApprovedError`·`NoGateFoundError`·`GateFilterMismatchError`는 HTTP
 * 200을 받은 뒤 응답 payload 내용으로 거부하는 **로컬 판정**이라 `httpStatus`는 없다
 * (지어내지 않는다 — 그 판정을 만든 HTTP 실패 자체가 없다). 실제 `!res.ok` 지점은
 * `../connectors/http-error.ts::ConnectorHttpError`로 통일(HTTP_<status> 코드 합성).
 */
import { ConnectorHttpError } from './http-error'

const APPROVED_GATE_STATUSES = new Set(['approved', 'auto_passed'])

/** 승인 판정 자체 — assertGateApproved와 assertGateApprovedForWorkItem이 공유한다(새 게이트
 * 로직 발명 0: 판정 규칙은 한 곳에만 있고, 두 조회 경로가 그 결과를 먹인다). */
export function isApprovedGateStatus(status: string): boolean {
  return APPROVED_GATE_STATUSES.has(status)
}

export class GateNotApprovedError extends Error {
  readonly code = 'GATE_NOT_APPROVED'

  constructor(public readonly gateStatus: string) {
    super(`external_publish gate is ${gateStatus}, not approved/auto_passed — publish blocked`)
    this.name = 'GateNotApprovedError'
  }
}

/** story #3312 AC5 — approve 단계가 아직 게이트를 만들지 않은 상태(work_item에 매칭되는
 * gate가 0건). 「게이트가 있는데 미승인」(GateNotApprovedError)과는 다른 케이스라 별도
 * 타입으로 구별한다 — 호출부가 "아직 대기" vs "승인 거부"를 다르게 다룰 수 있게. */
export class NoGateFoundError extends Error {
  readonly code = 'NO_GATE_FOUND'

  constructor(public readonly workItemId: string, public readonly gateType: string) {
    super(`no ${gateType} gate found yet for work_item_id=${workItemId} — approve stage hasn't run`)
    this.name = 'NoGateFoundError'
  }
}

export interface GateStatusResponse {
  status: string
}

/**
 * gate.status가 approved 또는 auto_passed가 아니면 throw한다 — 호출부(stibee.ts의 send
 * 직전)가 이 함수 하나만 지키면 "게이트 없이는 발송 안 나간다"가 성립한다. 이 함수를
 * 지우거나 호출을 빼먹으면(뮤테이션) pending/rejected 게이트로도 send가 나가야 정상 —
 * 그게 이 pin의 존재 이유다.
 */
export async function assertGateApproved(
  gateId: string,
  apiUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/api/v2/gates/${gateId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'x-agent-api-key': apiKey,
    },
  })
  if (!res.ok) {
    throw new ConnectorHttpError('gate lookup', res.status)
  }
  const gate = (await res.json()) as GateStatusResponse
  if (!isApprovedGateStatus(gate.status)) {
    throw new GateNotApprovedError(gate.status)
  }
}

export interface GateSummary {
  id: string
  status: string
  gateType: string
  designatedApproverId?: string | null
  workItemId: string
  workItemType: string
}

interface GateListResponseEntry {
  id: string
  status: string
  gate_type: string
  designated_approver_id?: string | null
  work_item_id: string
  work_item_type: string
}

/** story #3312 PR#30 PO 리뷰(방어 정정) — 서버가 쿼리 필터를 조용히 무시해도(story #2864가
 * 실제로 그랬던 클래스) 이 함수가 그걸 발행 승인으로 오독하면 안 된다. 응답 첫 건의
 * gate_type/work_item_id/work_item_type이 요청값과 다르면 fail-closed. */
export class GateFilterMismatchError extends Error {
  readonly code = 'GATE_FILTER_MISMATCH'

  constructor(
    public readonly requested: { workItemId: string; workItemType: string; gateType: string },
    public readonly received: { workItemId: string; workItemType: string; gateType: string },
  ) {
    super(
      'gate list response entry does not match the requested filter — requested ' +
        `work_item_id=${requested.workItemId} work_item_type=${requested.workItemType} ` +
        `gate_type=${requested.gateType}, received work_item_id=${received.workItemId} ` +
        `work_item_type=${received.workItemType} gate_type=${received.gateType} ` +
        '(defense against the server silently ignoring filters — story #2864 class of bug)',
    )
    this.name = 'GateFilterMismatchError'
  }
}

/**
 * story #3312 AC5 — gate_id 없이 "이 work item의 최신 {gateType} 게이트"를 조회한다.
 * 계약(PR#3704 «커넥터용 조회 계약», PO 확定): 새 라우트 없음, 기존
 * `GET /api/v2/gates` 필터 조합 + `limit=1`. `limit`가 있어야 백엔드가 `created_at desc`로
 * 정렬한다(gates.py list_gates, story #2864 조건부 정렬 — limit/offset 없으면 무정렬이라
 * "최신"을 보장 못 함, 그래서 이 조회는 항상 `limit=1`을 붙인다). 0건이면 approve 단계가
 * 아직 안 돈 것 — NoGateFoundError(명시, 조용한 통과 금지). org 스코프 밖 work_item_id는
 * 서버가 404(존재 비노출 관례)를 주며 이 함수는 그것도 일반 조회 실패로 그대로 throw한다.
 *
 * ⚠️PO 리뷰 정정(PR#30) — 응답 첫 건이 "요청과 같은 필터"라고 서버를 맹신하지 않는다.
 * story #2864(GET /api/v2/gates가 gate_type·limit을 침묵 무시하던 실사고 — 지금은 fix
 * 됐지만 재발 시 이 함수가 그 첫 신호원)와 같은 클래스가 다시 나면, 이 함수가 "같은
 * work item의 다른 gate_type 게이트(예: merge, approved)"를 external_publish 승인으로
 * 오독해 발행을 열어줄 수 있는 자리라 — 응답 건의 실 필드를 요청값과 대조해 다르면
 * GateFilterMismatchError로 fail-closed(조용한 통과 금지).
 */
export async function resolveLatestGate(
  workItemId: string,
  workItemType: string,
  gateType: string,
  apiUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GateSummary> {
  const url = new URL(`${apiUrl.replace(/\/$/, '')}/api/v2/gates`)
  url.searchParams.set('work_item_id', workItemId)
  url.searchParams.set('work_item_type', workItemType)
  url.searchParams.set('gate_type', gateType)
  url.searchParams.set('limit', '1') // ⚠️정렬 트리거(story #2864) — 빼면 "최신" 보장 소실.
  const res = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'x-agent-api-key': apiKey,
    },
  })
  if (!res.ok) {
    throw new ConnectorHttpError('gate list lookup', res.status)
  }
  const gates = (await res.json()) as GateListResponseEntry[]
  if (gates.length === 0) {
    throw new NoGateFoundError(workItemId, gateType)
  }
  const gate = gates[0] // limit=1 + 서버 정렬(created_at desc) — 이미 "최신 1건".

  // ⭐fail-closed 대조(PR#30 PO 리뷰) — 지우면(뮤테이션) 서버가 필터를 무시해도 발행이
  // 그대로 나가야 정상: gate-check.test.ts가 그 갈림을 pin한다.
  if (
    gate.work_item_id !== workItemId ||
    gate.work_item_type !== workItemType ||
    gate.gate_type !== gateType
  ) {
    throw new GateFilterMismatchError(
      { workItemId, workItemType, gateType },
      { workItemId: gate.work_item_id, workItemType: gate.work_item_type, gateType: gate.gate_type },
    )
  }

  return {
    id: gate.id,
    status: gate.status,
    gateType: gate.gate_type,
    designatedApproverId: gate.designated_approver_id,
    workItemId: gate.work_item_id,
    workItemType: gate.work_item_type,
  }
}

/**
 * resolveLatestGate + isApprovedGateStatus — assertGateApproved의 work_item 판 (한 번의
 * 왕복으로 끝난다: 목록 응답에 이미 status가 실려 있어 별도 `/gates/{id}` 재조회가
 * 필요없다). gateId를 몰라도 호출부(threads.ts/stibee.ts의 두 chokepoint)가 이 함수
 * 하나만 지키면 "게이트 없이는 발송 안 나간다"가 gate_id 명시 경로와 동일하게 성립한다.
 */
export async function assertGateApprovedForWorkItem(
  workItemId: string,
  workItemType: string,
  gateType: string,
  apiUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const gate = await resolveLatestGate(workItemId, workItemType, gateType, apiUrl, apiKey, fetchImpl)
  if (!isApprovedGateStatus(gate.status)) {
    throw new GateNotApprovedError(gate.status)
  }
}
