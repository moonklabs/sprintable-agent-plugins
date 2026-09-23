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
 * [SID:4026 재오픈] 시작할 때 이미 알 수 있는 채널 상태 — initialize 응답 `instructions`에 싣는다.
 * 채널 알림은 클라이언트가 채널 수신을 등록하기 **전에** 도착하면 버려진다(Claude Code 2.1.280 실측:
 * 발송 .283 < 등록 .291, 등록 뒤 idle 20초 동안 클라이언트 요청 0 — 플러그인이 등록 시점을 알 신호가
 * 없음). instructions는 initialize 응답 안에 동기로 실려 그 경합이 구조적으로 없다(세션 시스템
 * 지시에 실리는 것 실측). 실행 중 거절(연결 뒤 401·403)은 등록 뒤 일이라 채널 알림 1회 그대로.
 */
export type StartupChannelState =
  | { kind: 'ok' }
  | { kind: 'down'; reason: string }
  | { kind: 'unknown' }

export const STARTUP_CHECK_TIMEOUT_MS = 2000

export async function checkStartupChannelState(opts: {
  apiKey: string
  apiUrl: string
  hasWebhook: boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<StartupChannelState> {
  if (opts.hasWebhook) return { kind: 'ok' } // SSE를 일부러 안 여는 구성 — «끊김»이 아니다
  if (!opts.apiKey) return { kind: 'down', reason: 'no-key' }
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const resp = await doFetch(`${opts.apiUrl}/api/v2/me`, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? STARTUP_CHECK_TIMEOUT_MS),
    })
    // 사유 문자열은 SSE 거절 사유(`HTTP ${status}`)와 같은 모양 — 게이트가 같은 사유로 보고 겹쳐 알리지 않게.
    if (resp.status === 401 || resp.status === 403) return { kind: 'down', reason: `HTTP ${resp.status}` }
    if (resp.ok) return { kind: 'ok' }
    return { kind: 'unknown' }
  } catch {
    return { kind: 'unknown' } // 시간 초과·네트워크 — «죽었다»가 아니라 «확인 못 함»
  }
}

/** instructions에 덧붙일 한 줄(정상이면 빈 문자열). */
export function startupChannelLine(state: StartupChannelState): string {
  if (state.kind === 'down') return channelDownMessage(state.reason)
  if (state.kind === 'unknown') {
    return 'Sprintable 채널 연결을 시작할 때 확인하지 못했어요 — DM이 안 들어오면 키와 네트워크를 확인해 주세요.'
  }
  return ''
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

  /**
   * [SID:4026 재오픈] 시작 시 instructions로 이미 전달한 사유 — 그 사유의 첫 실패 알림은 겹치지 않게
   * 건너뛴다(같은 사유 반복 금지 규칙에 그대로 태운다). 연결 성공(clear) 뒤 재실패는 다시 1회.
   */
  markDeliveredAtStartup(reason: string): void {
    this.lastNotified = reason
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
