/**
 * story #3406(2026-09-04) — instagram.ts/stibee.ts/site_git.ts가 각자 손으로 짓던 동일
 * 문구("X requires either gateId or workItemId to check the external_publish gate", 각
 * 파일에 2회씩 — 함수 진입 직후 chokepoint 앞·chokepoint 안쪽 재확認)를 한 클래스로
 * 공유한다. 순수 입력검증(네트워크 호출 자체가 없는 로컬 판정)이라 `httpStatus`는 없다.
 */
export class GateReferenceRequiredError extends Error {
  readonly code = 'GATE_REFERENCE_REQUIRED'

  constructor(public readonly functionName: string) {
    super(`${functionName} requires either gateId or workItemId to check the external_publish gate`)
    this.name = 'GateReferenceRequiredError'
  }
}
