/**
 * [SID:4026] 채널 SSE가 «키 없음 / 거절(401·403)»로 안 붙을 때 세션에 딱 1회만 «채널 연결 안 됨»을
 * 알리기 위한 순수 상태 판정. 지금은 그 실패가 stderr(로그 자리 없음)에만 남아 세션이 몇 시간 동안
 * 귀머거리인 줄 모른다(4024 실측: 재기동 뒤 빈 키 → SSE 401 → 8시간 무음). 같은 사유는 반복 금지,
 * 연결 성공(reason=null) 시 해제 → 다음 실패는 다시 1회 알림.
 */
export type FailureReason = string | null

export interface FailureNoticeDecision {
  /** 이번에 세션 알림을 낼지. */
  notify: boolean
  /** 다음 판정에 넘길 «마지막으로 알린 사유»(성공이면 null). */
  nextLast: string | null
}

export function nextFailureNotice(
  reason: FailureReason,
  lastNotified: string | null,
): FailureNoticeDecision {
  if (reason === null) return { notify: false, nextLast: null } // 연결됨 → 해제
  if (reason === lastNotified) return { notify: false, nextLast: lastNotified } // 같은 사유 반복 금지
  return { notify: true, nextLast: reason } // 새 사유 → 1회 알림
}

/** 세션에 보일 사람 문구(해요체·사유 코드만·비밀값 0). reason 예: 'no-key' · 'HTTP 401'. */
export function channelDownMessage(reason: string): string {
  return `Sprintable 채널이 연결되지 않았어요 — DM이 자동으로 들어오지 않아요 (${reason}).`
}
