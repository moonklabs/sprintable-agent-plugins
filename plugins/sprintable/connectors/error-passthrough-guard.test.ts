/**
 * story #3814(민 customer-zero 실측 2026-09-12) — channel-posts.ts·site-posts.ts의
 * `!res.ok` 제네릭 폴백 7곳이 이미 같은 파일에 있는 `parseErrorDetail(res)`를 안 쓰고
 * `throw new XxxApiError(..., undefined, res.status)`로 BE 봉투(`error.code`·
 * `error.message`)를 통째로 버리고 있었다 — 403 스코프 부족처럼 「다음 행동」이 그대로
 * 적힌 문구도 에이전트에겐 `HTTP_403·detail null`로만 보였다(온보딩 철학 위반).
 *
 * 이 가드는 그 정확한 소스 패턴(`, undefined, res.status)`)이 두 파일에 다시 나타나면
 * 잡는다 — parseErrorDetail을 거치지 않고 code를 하드코딩 undefined로 던지는 지점의
 * 재발 방지. 소스 텍스트 스캔이라 **못 보는 자리**가 있다: ①다른 변수명으로 undefined를
 * 담아 넘기는 경우(예: `const noCode = undefined; throw new X(msg, noCode, ...)`) —
 * 리터럴 "undefined" 토큰만 보므로 안 걸린다. ②이 두 파일 밖의 새 커넥터가 같은
 * 안티패턴을 처음부터 새로 쓰는 경우 — 대상 파일 목록에 없으면 안 본다. 둘 다 지금
 * 코드베이스엔 없음을 직접 확認했다(2026-09-12) — 새 커넥터가 생기면 SOURCES에 추가해야
 * 한다.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 이 배열이 "전수"의 실제 범위다 — 새 커넥터 파일이 같은 XxxApiError+parseErrorDetail
// 패턴을 쓰기 시작하면 여기 추가해야 가드가 그 파일도 본다(자동 탐지 0 — 의도적, 이
// 가드가 정적 텍스트 스캔이라 "패턴을 쓰는 파일"을 스스로 알아낼 수 없다).
const SOURCES = ['channel-posts.ts', 'site-posts.ts'] as const

const ANTI_PATTERN = /,\s*undefined,\s*res\.status\)/g

describe('story #3814 — ApiError 생성이 전부 parseErrorDetail을 거친다(재발 가드)', () => {
  for (const file of SOURCES) {
    test(`${file}에 code를 하드코딩 undefined로 던지는 자리가 없다`, () => {
      const src = readFileSync(join(__dirname, file), 'utf8')
      const matches = src.match(ANTI_PATTERN) ?? []
      expect(matches.length).toBe(0)
    })
  }

  // 뮤테이션 셀프체크(양성대조) — 가드 자신이 헛돌지 않는지. 실 소스를 손대지 않고
  // 그 안티패턴을 담은 문자열을 직접 만들어 가드 정규식이 실제로 걸리는지 확認한다.
  test('가드 정규식 자체가 안티패턴을 실제로 잡는다(공허 통과 아님)', () => {
    const reintroduced = "throw new ChannelPostApiError(`x failed: ${res.status}`, undefined, res.status)"
    const matches = reintroduced.match(ANTI_PATTERN) ?? []
    expect(matches.length).toBe(1)
  })
})
