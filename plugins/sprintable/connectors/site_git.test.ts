/**
 * story a32c9f1a — 두 chokepoint 로직 자체(assertGateApproved/assertGateApprovedForWorkItem
 * 위임)는 gate-check.test.ts가 커버한다.
 *
 * story #3366(Phase0·마케팅운영) 이후: publishSitePost는 함수 진입 즉시(slug/lang 경로
 * 조작 방어보다도 먼저) EXTERNAL_PUBLISH_MOVED_TO_PLATFORM으로 얼어붙는다 — "게이트
 * 승인 시 커밋이 실제로 나간다"류 end-to-end 시나리오는 이제 프로덕션에서 도달 불가능한
 * 코드 경로다(서버 어댑터가 나중에 선별 재사용할 로직으로만 남는다, PO 지시 — 도구
 * 자체는 안 지운다). slug/lang 경로 조작 방어(assertSlugAndLangShape)는 재사용 가치가
 * 있는 순수 검증 로직이라 export해 publishSitePost를 거치지 않고 직접 단위 테스트한다
 * (아래 별도 describe).
 */
import { describe, test, expect } from 'bun:test'
import { publishSitePost, buildSitePostFile, assertSlugAndLangShape, SlugOrLangInvalidError } from './site_git'
import { ExternalPublishMovedToPlatformError } from './publish-freeze'

/** GitHub Contents API 쪽 fetch 스파이 — 실제로 나간 (method, url) 쌍을 전부 기록한다.
 * 기본은 "기존 파일 없음"(sha 조회 404) — 신규 파일 생성 경로. */
function githubSpy(opts: { existingSha?: string | null } = {}) {
  const calls: { method: string; url: string }[] = []
  const existingSha = opts.existingSha ?? null
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url })
    if (method === 'GET' && url.includes('/contents/')) {
      if (existingSha === null) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ sha: existingSha }), { status: 200 })
    }
    if (method === 'PUT' && url.includes('/contents/')) {
      return new Response(
        JSON.stringify({ commit: { sha: 'commit-sha-42', html_url: 'https://github.com/acme/site/commit/abc' } }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function gateCheckSpy(status: string) {
  return (async () => new Response(JSON.stringify({ status }), { status: 200 })) as unknown as typeof fetch
}

function siteGitConfig(fetchImpl: typeof fetch, overrides: Partial<{ githubToken: string; repo: string; branch: string; pathTemplate: string; siteBaseUrl: string }> = {}) {
  return {
    githubToken: overrides.githubToken ?? 'gh-token',
    repo: overrides.repo ?? 'acme/site',
    branch: overrides.branch ?? 'main',
    pathTemplate: overrides.pathTemplate ?? 'content/blog/{lang}/{slug}.md',
    siteBaseUrl: overrides.siteBaseUrl ?? 'https://sprintable.ai',
    fetchImpl,
  }
}

const BASE_PARAMS = {
  title: '제목', body: '본문 markdown', slug: 'hello-world', lang: 'ko',
  sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
}

describe('publishSitePost — frozen (story #3366 Phase0 external-publish freeze)', () => {
  test('⭐AC1/AC2 — 승인된 gate여도 즉시 EXTERNAL_PUBLISH_MOVED_TO_PLATFORM, GitHub·게이트 조회 outbound 0건', async () => {
    const { calls, fetchImpl } = githubSpy()
    let gateCheckCalled = false
    const gateCheckFetchImpl = (async () => {
      gateCheckCalled = true
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
    expect(gateCheckCalled).toBe(false)
  })

  test('⭐AC3 — work_item 경로(#3312 AC5 동형)로 줘도 동결은 그대로, outbound 0건', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, workItemId: 'wi-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('경로 조작 slug를 줘도(과거 방어 대상) 동결이 먼저 걸린다 — GitHub·게이트 조회 outbound 0건', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1', slug: '../../.github/workflows/x',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('gate_id도 work_item도 없어도 동결 에러가 먼저다("requires either..." 에러보다 우선)', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS,
        siteGit: siteGitConfig(fetchImpl),
      }),
    ).rejects.toThrow(ExternalPublishMovedToPlatformError)
    expect(calls).toHaveLength(0)
  })

  test('에러 메시지에 도구명(publish_site_post)이 실린다', async () => {
    const { fetchImpl } = githubSpy()
    try {
      await publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      })
      throw new Error('unreachable — publishSitePost must be frozen')
    } catch (err) {
      expect((err as Error).message).toContain('publish_site_post')
    }
  })
})

describe('buildSitePostFile — frontmatter 직렬화(계약 SSOT) — 동결 대상 아님(순수 함수)', () => {
  test('필수 필드만 — YAML frontmatter + 본문', () => {
    const file = buildSitePostFile(
      { title: '안녕', slug: 'hi', lang: 'ko', publishedAt: '2026-09-03T00:00:00.000Z' },
      '본문입니다',
    )
    expect(file).toBe(
      '---\n' +
      'title: "안녕"\n' +
      'slug: "hi"\n' +
      'lang: "ko"\n' +
      'publishedAt: "2026-09-03T00:00:00.000Z"\n' +
      '---\n\n본문입니다',
    )
  })

  test('선택 필드(summary·tags·source_story) 있으면 실리고, 없으면 줄 자체가 생략된다', () => {
    const withOptional = buildSitePostFile(
      { title: 't', slug: 's', lang: 'ko', publishedAt: 'p', summary: '요약', tags: ['a', 'b'], sourceStory: 'story-1' },
      'body',
    )
    expect(withOptional).toContain('summary: "요약"')
    expect(withOptional).toContain('tags: ["a", "b"]')
    expect(withOptional).toContain('source_story: "story-1"')

    const withoutOptional = buildSitePostFile({ title: 't', slug: 's', lang: 'ko', publishedAt: 'p' }, 'body')
    expect(withoutOptional).not.toContain('summary:')
    expect(withoutOptional).not.toContain('tags:')
    expect(withoutOptional).not.toContain('source_story:')
  })

  test('제목에 큰따옴표·백슬래시가 있어도 YAML로 안전하게 이스케이프된다', () => {
    const file = buildSitePostFile(
      { title: '제목 "인용" \\경로', slug: 's', lang: 'ko', publishedAt: 'p' },
      'body',
    )
    expect(file).toContain('title: "제목 \\"인용\\" \\\\경로"')
  })
})

describe('assertSlugAndLangShape — slug/lang 경로 조작 방어(story a32c9f1a, PR#37 PO 리뷰) — 동결 대상 아님(순수 함수, story #3366 이후 publishSitePost를 거치지 않고 직접 검증)', () => {
  test('⭐slug에 경로 조작 문자열(traversal)은 SlugOrLangInvalidError', () => {
    expect(() => assertSlugAndLangShape('../../.github/workflows/x', 'ko')).toThrow(SlugOrLangInvalidError)
  })

  test('lang에 경로 조작 문자열(traversal)도 동일하게 거부된다', () => {
    expect(() => assertSlugAndLangShape('hello-world', '../../etc')).toThrow(SlugOrLangInvalidError)
  })

  test('대문자·공백·언더스코어 등 규격 밖 slug도 거부된다', () => {
    for (const badSlug of ['Hello-World', 'hello_world', 'hello world', '-leading-dash', 'trailing-dash-', '']) {
      expect(() => assertSlugAndLangShape(badSlug, 'ko')).toThrow(SlugOrLangInvalidError)
    }
  })

  test('정상 slug(hello-world)·lang(ko, en-US)은 통과한다(양성대조 — 과잉차단 아님)', () => {
    for (const lang of ['ko', 'en', 'en-US']) {
      expect(() => assertSlugAndLangShape('hello-world', lang)).not.toThrow()
    }
  })
})
