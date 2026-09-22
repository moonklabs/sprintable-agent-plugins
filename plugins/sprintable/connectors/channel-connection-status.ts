/**
 * story #4134(#4132 REST의 얇은 소비처, 2026-09-22) — 발행(published) 단계를 맡은 crew
 * 에이전트가 발행 前에 자기 바인딩된 채널 연결이 살아 있는지(needs_reauth)를 도구 한 번
 * 으로 안다. `GET .../events/work-items/{type}/{id}/channel-connection`(#4132, 판정
 * 순서 공용 헬퍼 `_resolve_crew_scoped_recipe_binding`)을 그대로 pass-through한다.
 *
 * generation-connector.ts와 같은 사상 — 이 도구는 **응답을 해석하지 않는다**(pass-
 * through). 유일한 예외는 **에러 코드 → 사람말 매핑**(BE가 이미 안정 문자열로 굳힌
 * 실패 code 축) — 응답 6필드 자체엔 자격/토큰이 없어(#4132 AC1) generation-connector류
 * 자격 로그 격리는 이 파일엔 해당 없다(비밀 없음).
 */
import { ConnectorHttpError } from './http-error'

export interface ChannelConnectionStatusParams {
  workItemType: string
  workItemId: string
  apiUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export interface ChannelConnectionStatusResult {
  connectionId: string
  provider: string
  status: string
  needsReauth: boolean
  lastVerifiedAt: string | null
  displayName: string | null
}

/**
 * BE code(#4132 실 소스 events.py 확認, 추측 0) → 사람말 1줄. generation-connector.ts와
 * 동형 원칙(story #4111 처방① 그대로 재사용 — 새 규칙 발명 0): 판정 순서 1~6단계
 * (`_resolve_crew_scoped_recipe_binding`)와 1:1 대응하는 코드만 전용 문장을 갖는다.
 * READ_AGENT_ONLY/WORK_ITEM_NOT_FOUND(정상 에이전트 호출에서는 사실상 도달하지 않는
 * 경계 케이스)는 지어낸 전용 문장 대신 FALLBACK_MESSAGE로 떨어지되 `.code`는 원본
 * 그대로 보존한다.
 */
const KNOWN_CODE_MESSAGES: Record<string, string> = {
  CHANNEL_CONNECTION_STAGE_MISMATCH: '이 작업의 발행 단계가 아니에요.',
  CHANNEL_CONNECTION_CREW_ONLY: '이 레시피 crew가 아니에요.',
  CHANNEL_CONNECTION_BINDING_NOT_FOUND: '채널 연결이 아직 등록/바인딩되지 않았어요.',
}
const FALLBACK_MESSAGE = '채널 연결 상태를 읽을 수 없어요.'

/** tool-error.ts::StructuredToolError 계약(code 필수·httpStatus 선택) — server.ts의
 * 공용 catch가 자동으로 {tool,code,message,http_status,detail} JSON으로 직렬화한다. */
export class ChannelConnectionStatusAccessError extends Error {
  readonly code: string

  constructor(code: string, public readonly httpStatus: number) {
    super(KNOWN_CODE_MESSAGES[code] ?? FALLBACK_MESSAGE)
    this.name = 'ChannelConnectionStatusAccessError'
    this.code = code
  }
}

interface ChannelConnectionStatusErrorEnvelope {
  error?: { code?: unknown }
}

interface ChannelConnectionStatusResponseBody {
  connection_id: string
  provider: string
  status: string
  needs_reauth: boolean
  last_verified_at: string | null
  display_name: string | null
}

/**
 * 인증 관례 — Authorization Bearer + x-agent-api-key(generation-connector.ts와 동형,
 * 새 인증 경로 발명 0). org_id는 URL/헤더 어디에도 안 싣는다 — #4132도 `get_verified_
 * org_id`가 agent API 키 자체의 org 스코프에서 해소한다(경로에 {org_id} 세그먼트 없음,
 * events.py 실 소스 라우트 확認).
 */
export async function getMyChannelConnectionStatus(
  params: ChannelConnectionStatusParams,
): Promise<ChannelConnectionStatusResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const base = params.apiUrl.replace(/\/$/, '')
  const res = await fetchImpl(
    `${base}/api/v2/events/work-items/${encodeURIComponent(params.workItemType)}/` +
      `${encodeURIComponent(params.workItemId)}/channel-connection`,
    {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'x-agent-api-key': params.apiKey,
      },
    },
  )
  if (!res.ok) {
    // BE 전역 핸들러(main.py::http_exception_handler)가 dict detail을
    // {"data":null,"error":{code,...},"meta":null}로 감싼다(generation-connector.ts와
    // 동일 봉투 확認 그대로 재사용) — code가 안 읽히면(파싱 실패·예상 밖 shape) code를
    // 지어내지 않고 ConnectorHttpError(HTTP_<status>)로 폴백한다.
    let code: string | undefined
    try {
      const body = (await res.json()) as ChannelConnectionStatusErrorEnvelope
      code = typeof body.error?.code === 'string' ? body.error.code : undefined
    } catch {
      code = undefined
    }
    if (code !== undefined) throw new ChannelConnectionStatusAccessError(code, res.status)
    throw new ConnectorHttpError('channel connection status read', res.status)
  }
  const body = (await res.json()) as ChannelConnectionStatusResponseBody
  return {
    connectionId: body.connection_id,
    provider: body.provider,
    status: body.status,
    needsReauth: body.needs_reauth,
    lastVerifiedAt: body.last_verified_at,
    displayName: body.display_name,
  }
}
