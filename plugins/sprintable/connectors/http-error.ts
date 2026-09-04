/**
 * story #3406(2026-09-04, 페드루 PO 확定) — channel-posts.ts 밖의 나머지 커넥터
 * (gate-check·registry·threads·instagram·stibee·site_git·evidence)가 `!res.ok`마다
 * 각자 `new Error(\`... failed: ${res.status}\`)`를 손으로 짓던 걸 한 곳으로 모은다.
 * 서버가 code를 안 주는 순수 HTTP 실패라도(이 커넥터들은 전부 code를 파싱하지 않는
 * 단순 상태 체크뿐 — 그라운딩 표 참고) `HTTP_<status>`로 안정 code를 합성한다 —
 * "지어냄"이 아니라 "실제로 관측한 status를 코드로 표현"이다(`httpStatus` 자체는 항상
 * 실측값 그대로). `../tool-error.ts::StructuredToolError` 계약(code 필수)을 이 클래스
 * 하나로 8개 커넥터 파일이 공유 — 손으로 8번 짓지 않는다(드리프트 원천 차단, story
 * #3405의 ChannelPostApiError와 동일 사상이나 그쪽은 서버가 code를 주는 도메인이라
 * 별개 클래스로 남겨 둔다).
 */
export class ConnectorHttpError extends Error {
  readonly code: string

  constructor(action: string, public readonly httpStatus: number) {
    super(`${action} failed: ${httpStatus}`)
    this.name = 'ConnectorHttpError'
    this.code = `HTTP_${httpStatus}`
  }
}
