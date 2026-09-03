/**
 * story #3366([Phase0·마케팅운영] 기존 발행 도구는 남아 있지만 모든 외부 요청 전에
 * 플랫폼 이관 오류로 멈춘다) — 블루프린트 v3(선생님 승인 2026-09-03) §PO-2 걸린 자리
 * 1·8: 「고객의 에이전트가 해야할 일과 제품이 해야할 일을 혼동해서는 안 되는」 경계에
 * 따라, 외부로 나가는 발행은 이제 전부 Sprintable 서버(플랫폼)의 몫이다 — 에이전트
 * 세션에 남아 있는 직접 발행 도구가 그 경계를 우회하는 통로가 되면 안 된다.
 *
 * 이 파일은 도구를 지우지 않는다(범위 밖 — 서버 어댑터가 threads.ts/stibee.ts/
 * site_git.ts/instagram.ts의 로직을 나중에 선별 재사용한다, PO 지시). 대신 각 발행
 * 함수의 "실행"만 credential 조회·게이트 조회·외부 HTTP보다 먼저 멈춘다 — 이 함수
 * 자체는 fetch를 전혀 하지 않으므로, 호출부가 이 함수를 정말 첫 줄에 두기만 하면
 * outbound는 구조적으로 항상 0건이다.
 *
 * 이중 chokepoint(defense-in-depth, 이 저장소의 기존 관례 그대로):
 *   ① server.ts — MCP 도구 이름이 `publish_`로 시작하면 switch 진입 전에 즉시 던진다.
 *      이름 접두 기반이라 이 파일에 등록되지 않은 미래의 다른 publish_* 도구도 자동으로
 *      덮는다(AC4 — 개별 도구를 열거하지 않는다).
 *   ② 각 커넥터의 publish 함수(threads.ts::publishThreadsPost 등) 자체의 첫 줄 — server.ts
 *      dispatch를 거치지 않고 커넥터 함수를 직접 부르는 경로(단위 테스트·향후 다른
 *      호출부)에도 동일하게 적용되게.
 */
export const EXTERNAL_PUBLISH_MOVED_TO_PLATFORM = 'EXTERNAL_PUBLISH_MOVED_TO_PLATFORM'

/** 비재시도 오류(AC1) — retryable:false로 명시해 재시도 루프가 이 에러를 재시도 대상으로
 * 오인하지 않게 한다. 메시지에는 다음 행동(AC5)을 항상 포함한다. */
export class ExternalPublishMovedToPlatformError extends Error {
  readonly code = EXTERNAL_PUBLISH_MOVED_TO_PLATFORM
  readonly retryable = false

  constructor(public readonly toolName: string) {
    super(
      `${toolName} is frozen (${EXTERNAL_PUBLISH_MOVED_TO_PLATFORM}) — direct external publish ` +
        'has moved to the platform server. Submit the draft, then approve and publish it from ' +
        'the Sprintable screen — Sprintable 화면에서 상신·승인·발행해야 한다.',
    )
    this.name = 'ExternalPublishMovedToPlatformError'
  }
}

/**
 * 호출부 계약: credential 조회·게이트 조회·외부 HTTP 요청 등 어떤 부수효과보다도 먼저
 * 부른다. 승인된 gate id나 유효한 외부 token을 받아도 예외 없이 던진다(AC3) — 이
 * 함수는 입력을 전혀 보지 않는다(toolName은 오직 에러 메시지 표시용).
 */
export function assertExternalPublishNotFrozen(toolName: string): never {
  throw new ExternalPublishMovedToPlatformError(toolName)
}
