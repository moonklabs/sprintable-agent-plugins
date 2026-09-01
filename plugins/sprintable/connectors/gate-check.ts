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
 */

const APPROVED_GATE_STATUSES = new Set(['approved', 'auto_passed'])

export class GateNotApprovedError extends Error {
  constructor(public readonly gateStatus: string) {
    super(`external_publish gate is ${gateStatus}, not approved/auto_passed — publish blocked`)
    this.name = 'GateNotApprovedError'
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
    throw new Error(`gate lookup failed: ${res.status}`)
  }
  const gate = (await res.json()) as GateStatusResponse
  if (!APPROVED_GATE_STATUSES.has(gate.status)) {
    throw new GateNotApprovedError(gate.status)
  }
}
