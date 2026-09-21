/**
 * story #4111(#4109 PO 결정·#4110 BE, 2026-09-21) — 연산(Compute) 슬롯 2/2, 에이전트 쪽
 * 절반. #4110(backend PR #4486)이 만드는 `GET /api/v2/events/work-items/{work_item_type}/
 * {work_item_id}/generation-connector`(에이전트 전용·crew 판정·{provider_key,label,
 * model_config_json,credentials} 평문 1회 반환)를 실제로 부를 도구가 이 플러그인엔 없었다
 * — 1호 지름길 ②(댄이 자기 env 자격으로 Vertex 실행)의 제품 쪽 절반이 BE로 닫히고, 이
 * 파일이 에이전트 쪽 절반이다.
 *
 * 이 도구는 **응답을 해석하지 않는다**(pass-through) — 2호 실측(#4109 그라운딩)으로
 * 응답 필드가 바뀔 수 있다고 #4110이 명시하므로, 필드 가공·검증을 여기 두면 그 변경마다
 * 이 파일도 같이 고쳐야 한다. 유일한 예외는 **에러 코드 → 사람말 매핑**(story #4111 처방
 * ①) — 이건 응답 "성공 shape"이 아니라 BE가 이미 안정 문자열로 굳힌 실패 code 축이라
 * 2호 실측과 무관하게 유지된다.
 *
 * 자격(credentials) 취급 — 이 함수는 반환값에만 credentials를 싣는다. console.log/error/
 * warn 호출 자체가 이 파일에 0건(다른 커넥터 전부와 동형 — grep으로 실측 확認, 신규
 * 로깅을 추가할 거면 반드시 마스킹). generation-connector.test.ts가 console 스파이로
 * "credentials 문자열이 어떤 console.* 호출에도 안 실린다"를 직접 assert한다.
 */
import { ConnectorHttpError } from './http-error'

export interface GenerationConnectorParams {
  workItemType: string
  workItemId: string
  apiUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export interface GenerationConnectorResult {
  providerKey: string
  label: string
  modelConfigJson: Record<string, unknown>
  credentials: string
}

/**
 * BE code(#4110 실 소스 events.py 확認, 추측 0) → 사람말 1줄. 카탈로그가 아니라 이 상수
 * 자체가 정본(story #4111 처방① — "영어 병기 없음, 도구 응답은 에이전트가 읽는다").
 * story #4110 AC1/AC2 판정 순서와 1:1 대응하는 4개만 전용 문장을 갖는다 — 나머지 코드
 * (GENERATION_CONNECTOR_READ_AGENT_ONLY·GENERATION_CONNECTOR_WORK_ITEM_NOT_FOUND, 정상
 * 에이전트 호출에서는 사실상 도달하지 않는 경계 케이스)는 §AC2 "미지 code 임의 낙착
 * 금지" 원칙 그대로 — 지어낸 전용 문장 대신 FALLBACK_MESSAGE로 떨어지되 `.code`는 원본
 * 그대로 보존한다(호출부가 code로 분기할 수 있게, message만 일반화).
 */
const KNOWN_CODE_MESSAGES: Record<string, string> = {
  GENERATION_CONNECTOR_STAGE_MISMATCH: '이 작업의 연산 단계가 아니에요.',
  GENERATION_CONNECTOR_CREW_ONLY: '이 레시피 crew가 아니에요.',
  GENERATION_CONNECTOR_BINDING_NOT_FOUND: '연산 커넥터가 아직 등록/바인딩되지 않았어요.',
  GENERATION_CONNECTOR_REVOKED: '커넥터가 해지됐어요.',
}
const FALLBACK_MESSAGE = '연산 커넥터를 읽을 수 없어요.'

/** tool-error.ts::StructuredToolError 계약(code 필수·httpStatus 선택) — server.ts의
 * 공용 catch가 자동으로 {tool,code,message,http_status,detail} JSON으로 직렬화한다. */
export class GenerationConnectorAccessError extends Error {
  readonly code: string

  constructor(code: string, public readonly httpStatus: number) {
    super(KNOWN_CODE_MESSAGES[code] ?? FALLBACK_MESSAGE)
    this.name = 'GenerationConnectorAccessError'
    this.code = code
  }
}

interface GenerationConnectorErrorEnvelope {
  error?: { code?: unknown }
}

interface GenerationConnectorResponseBody {
  provider_key: string
  label: string
  model_config_json: Record<string, unknown>
  credentials: string
}

/**
 * 인증 관례 — Authorization Bearer + x-agent-api-key(gate-check.ts/evidence.ts와 동형,
 * 새 인증 경로 발명 0). org_id는 URL/헤더 어디에도 안 싣는다 — 이 엔드포인트는
 * `get_verified_org_id`가 agent API 키 자체의 org 스코프에서 해소한다(경로에 {org_id}
 * 세그먼트가 없음, #4110 실 소스 라우트 확認) — registry.ts::resolveOrgId처럼 org_id를
 * 먼저 조회해 URL에 박아 넣는 사람용 BFF 패턴과 다르다.
 */
export async function getGenerationConnector(
  params: GenerationConnectorParams,
): Promise<GenerationConnectorResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const base = params.apiUrl.replace(/\/$/, '')
  const res = await fetchImpl(
    `${base}/api/v2/events/work-items/${encodeURIComponent(params.workItemType)}/` +
      `${encodeURIComponent(params.workItemId)}/generation-connector`,
    {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'x-agent-api-key': params.apiKey,
      },
    },
  )
  if (!res.ok) {
    // BE 전역 핸들러(main.py::http_exception_handler)가 dict detail을
    // {"data":null,"error":{code,...},"meta":null}로 감싼다(story #3410과 동일 봉투,
    // channel-posts.ts::parseErrorDetail 실측 그대로) — code가 안 읽히면(파싱 실패·
    // 예상 밖 shape) code를 지어내지 않고 ConnectorHttpError(HTTP_<status>)로 폴백한다.
    let code: string | undefined
    try {
      const body = (await res.json()) as GenerationConnectorErrorEnvelope
      code = typeof body.error?.code === 'string' ? body.error.code : undefined
    } catch {
      code = undefined
    }
    if (code !== undefined) throw new GenerationConnectorAccessError(code, res.status)
    throw new ConnectorHttpError('generation connector read', res.status)
  }
  const body = (await res.json()) as GenerationConnectorResponseBody
  return {
    providerKey: body.provider_key,
    label: body.label,
    modelConfigJson: body.model_config_json,
    credentials: body.credentials,
  }
}
