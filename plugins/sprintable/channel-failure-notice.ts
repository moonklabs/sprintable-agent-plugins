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

/**
 * [SID:4026·PO 조건1] 초기화 전 알림은 클라이언트에 버려질 수 있어(내보냄 ≠ 주입) 초기화 뒤로
 * 큐잉했다가 한 번에 내보낸다. 핵심: **markInitialized가 한 번도 안 불리면 큐가 영영 안 나가는**
 * 조용한 실패(이 카드가 없애려는 바로 그 모양)를 막아야 한다 — 호출부는 gate 만든 «직후»에도
 * 이미 초기화됐는지 확認해 markInitialized를 한 번 더 부른다(멱등). emit은 콜백 주입(순수 테스트).
 */
export class ChannelNoticeGate {
  private initialized = false
  private pending: string[] = []
  private lastNotified: string | null = null
  constructor(private readonly emit: (reason: string) => void) {}

  /** 실패 알림 요청 — 같은 사유 반복 금지·초기화 전이면 큐잉. */
  notice(reason: string): void {
    const d = nextFailureNotice(reason, this.lastNotified)
    this.lastNotified = d.nextLast
    if (!d.notify) return
    if (this.initialized) this.emit(reason)
    else this.pending.push(reason)
  }

  /** 연결 성공 — 사유 상태 해제(다음 실패는 다시 1회). */
  clear(): void {
    this.lastNotified = nextFailureNotice(null, this.lastNotified).nextLast
  }

  /** 클라이언트 초기화 완료 — 큐 flush(멱등: 두 번째부터 no-op). */
  markInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    const queued = this.pending
    this.pending = []
    for (const reason of queued) this.emit(reason)
  }

  /** 테스트용: 초기화 상태. */
  get isInitialized(): boolean {
    return this.initialized
  }
}
