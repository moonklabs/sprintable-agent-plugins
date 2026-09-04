/**
 * story #3405(2026-09-04, 페드루 PO 확定) — MCP 도구 dispatch 공용 catch(server.ts)가
 * 던져진 에러를 최종적으로 어떻게 문자열화하는지 한 곳에 모은다. 이전엔 `err.message`만
 * 뽑아 평문 한 줄로 내보냈다 — 커넥터가 타입으로 붙여 둔 `code`/구조화 `detail`(예:
 * CHANNEL_TEXT_TOO_LONG의 max_length/current_length, CHANNEL_POST_GATE_ALREADY_HELD의
 * holding_draft_id)이 전부 버려졌다("온보딩 철학=최저 지능 에이전트가 다음 행동을 알 수
 * 있어야"를 위반하는 자리 — 페드루 지적, 디디 그라운딩으로 확認).
 *
 * `server.ts`는 이 파일을 import해 이 함수 하나만 쓴다 — 도구 이름별 분기·문자열 조립을
 * server.ts 안에 다시 두지 않는다(모든 도구가 같은 규약을 따르게).
 */

/**
 * 구조화 에러 계약 — 어떤 커넥터든 이 셋(code는 선택, message·httpStatus는 필수)을
 * Error 인스턴스에 얹으면 이 파일이 그것을 구조화 JSON으로 직렬화한다. 새 커넥터를
 * structured 응답에 편입시키고 싶으면 이 인터페이스만 만족하면 되고, server.ts를 고칠
 * 필요는 없다(코드-대-클래스 매핑은 각 커넥터 파일의 몫, 여기선 duck-typing으로만 판별).
 */
export interface StructuredToolError {
  /** 서버가 준 안정 문자열(예: CHANNEL_TEXT_TOO_LONG). 서버가 code를 안 주는 응답
   * (예: 404의 평문 detail)이면 undefined — "지어내지 않는다". */
  code?: string
  message: string
  httpStatus: number
  /** 서버 detail 원문(코드/메시지 포함 전체) — 가공 없이 그대로. */
  detail?: unknown
}

function isStructuredToolError(err: unknown): err is Error & StructuredToolError {
  return (
    err instanceof Error &&
    typeof (err as Partial<StructuredToolError>).httpStatus === 'number'
  )
}

export interface ToolCallResult {
  content: { type: 'text'; text: string }[]
  isError: true
}

/**
 * server.ts의 CallToolRequestSchema 핸들러 바깥쪽(공용) catch가 부르는 유일한 자리.
 * 구조화 에러(StructuredToolError 계약을 만족하는 커넥터, 지금은 channel-posts.ts)는
 * `{tool, code, message, http_status, detail}` JSON으로 직렬화한다 — code가 없으면
 * null(지어내지 않는다). 그 계약을 안 따르는 나머지 커넥터(stibee/instagram/site_git 등,
 * 아직 구조화 안 됨 — story #3405 범위 밖, 별도 스토리로 기록)·`throw new Error(...)` 같은
 * 일반 에러는 예전과 같은 평문 한 줄로 그대로 남는다(회귀 0).
 */
export function formatToolError(toolName: string, err: unknown): ToolCallResult {
  if (isStructuredToolError(err)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          tool: toolName,
          code: err.code ?? null,
          message: err.message,
          http_status: err.httpStatus,
          detail: err.detail ?? null,
        }),
      }],
      isError: true,
    }
  }
  return {
    content: [{ type: 'text', text: `${toolName}: ${err instanceof Error ? err.message : err}` }],
    isError: true,
  }
}
