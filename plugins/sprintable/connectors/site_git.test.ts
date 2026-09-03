/**
 * story a32c9f1a — ⭐핵심 pin(threads.test.ts·instagram.test.ts와 동형): "게이트 없이는
 * GitHub으로 단 하나의 요청도 안 나간다"를 end-to-end로 증명한다. 두 chokepoint
 * (①함수 진입 직후=sha 조회보다도 먼저, ②커밋 PUT 직전=레이스 방어)가 각각 pin
 * 대상 — story 6f2034cf "공통 계약"을 이 커넥터도 처음부터 그대로 따른다.
 */
import { describe, test, expect } from 'bun:test'
import { publishSitePost, buildSitePostFile, SlugOrLangInvalidError } from './site_git'
import { GateNotApprovedError, NoGateFoundError } from './gate-check'

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

/** 레이스 방어 테스트 전용 — 호출마다 순서대로 다른 status를 준다(소진되면 마지막 값
 * 반복) — threads.test.ts::gateCheckSequenceSpy와 동형. */
function gateCheckSequenceSpy(statuses: string[]) {
  let i = 0
  return (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)]
    i += 1
    return new Response(JSON.stringify({ status }), { status: 200 })
  }) as unknown as typeof fetch
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

function gateCheckListSpy(status: string | null) {
  return (async () =>
    new Response(JSON.stringify(status === null ? [] : [{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]), { status: 200 })
  ) as unknown as typeof fetch
}

const BASE_PARAMS = {
  title: '제목', body: '본문 markdown', slug: 'hello-world', lang: 'ko',
  sprintableApiUrl: 'https://app.sprintable.ai', sprintableApiKey: 'k',
}

describe('publishSitePost — chokepoint end-to-end (story a32c9f1a)', () => {
  test('gate.status=approved — 신규 파일 커밋이 실제로 나간다(양성대조)', async () => {
    const { calls, fetchImpl } = githubSpy()
    const result = await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1',
      siteGit: siteGitConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(result.commitSha).toBe('commit-sha-42')
    expect(result.path).toBe('content/blog/ko/hello-world.md')
    expect(result.url).toBe('https://sprintable.ai/ko/blog/hello-world')
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/contents/'))).toBe(true)
  })

  test('gate.status=auto_passed — 커밋이 실제로 나간다', async () => {
    const { calls, fetchImpl } = githubSpy()
    await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1',
      siteGit: siteGitConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('auto_passed'),
    })
    expect(calls.some((c) => c.method === 'PUT')).toBe(true)
  })

  test('⭐gate.status=pending — GitHub으로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐gate.status=rejected — GitHub으로 단 하나의 요청도 안 나간다(핵심 pin, chokepoint①)', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('rejected'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐레이스 방어(chokepoint②) — ①통과 뒤 승인이 철회되면 sha 조회(GET)는 이미 나갔어도 커밋(PUT)은 절대 안 나간다', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1',
        siteGit: siteGitConfig(fetchImpl),
        // 1번째 게이트조회(①)=approved → 통과. 2번째(②, 커밋 직전)=rejected(철회) → 차단.
        gateCheckFetchImpl: gateCheckSequenceSpy(['approved', 'rejected']),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/contents/'))).toBe(true)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  test('기존 파일이 있으면(sha 조회 200) 커밋 PUT body에 그 sha가 실린다(갱신 경로, idempotent 재발행)', async () => {
    let putBody: Record<string, unknown> | undefined
    const spyWithCapture = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/contents/')) return new Response(JSON.stringify({ sha: 'existing-sha-7' }), { status: 200 })
      if (method === 'PUT') {
        putBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ commit: { sha: 'new-sha', html_url: 'x' } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1',
      siteGit: siteGitConfig(spyWithCapture),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(putBody?.sha).toBe('existing-sha-7')
  })

  test('신규 파일이면(sha 조회 404) 커밋 PUT body에 sha 키 자체가 없다', async () => {
    let putBody: Record<string, unknown> | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/contents/')) return new Response('{}', { status: 404 })
      if (method === 'PUT') {
        putBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ commit: { sha: 'new-sha', html_url: 'x' } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1',
      siteGit: siteGitConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(putBody && 'sha' in putBody).toBe(false)
  })

  test('커밋 PUT body — content는 base64, branch·message가 실린다(Contents API 실측 계약 pin)', async () => {
    let putBody: Record<string, unknown> | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/contents/')) return new Response('{}', { status: 404 })
      if (method === 'PUT') {
        putBody = init?.body ? JSON.parse(init.body as string) : undefined
        return new Response(JSON.stringify({ commit: { sha: 'new-sha', html_url: 'x' } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1',
      siteGit: siteGitConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })

    expect(putBody?.branch).toBe('main')
    expect(typeof putBody?.message).toBe('string')
    const decoded = Buffer.from(putBody?.content as string, 'base64').toString('utf-8')
    expect(decoded).toContain('title: "제목"')
    expect(decoded).toContain('slug: "hello-world"')
    expect(decoded).toContain('lang: "ko"')
    expect(decoded).toContain('본문 markdown')
  })

  test('path_template의 {lang}/{slug}가 실제 값으로 치환된다', async () => {
    const { fetchImpl } = githubSpy()
    const result = await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-1', slug: 'my-post', lang: 'en',
      siteGit: siteGitConfig(fetchImpl, { pathTemplate: 'posts/{lang}-{slug}.md' }),
      gateCheckFetchImpl: gateCheckSpy('approved'),
    })
    expect(result.path).toBe('posts/en-my-post.md')
  })
})

describe('publishSitePost — work_item 경로(#3312 AC5 동형, gate_id 없이 조회)', () => {
  test('gateId 없이 workItemId만 줘도 approved면 커밋이 나간다', async () => {
    const { calls, fetchImpl } = githubSpy()
    const result = await publishSitePost({
      ...BASE_PARAMS, workItemId: 'wi-1',
      siteGit: siteGitConfig(fetchImpl),
      gateCheckFetchImpl: gateCheckListSpy('approved'),
    })
    expect(result.commitSha).toBe('commit-sha-42')
    expect(calls.some((c) => c.method === 'PUT')).toBe(true)
  })

  test('workItemId 경로 — pending이면 GitHub으로 단 하나의 요청도 안 나간다', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, workItemId: 'wi-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckListSpy('pending'),
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls).toHaveLength(0)
  })

  test('⭐게이트 0건(approve 단계 미발생) — NoGateFoundError, GitHub 호출 0건', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, workItemId: 'wi-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckListSpy(null),
      }),
    ).rejects.toThrow(NoGateFoundError)
    expect(calls).toHaveLength(0)
  })

  test('⭐gateId도 workItemId도 없으면 즉시 명시 에러 — 네트워크 호출 0건', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS,
        siteGit: siteGitConfig(fetchImpl),
      }),
    ).rejects.toThrow('requires either gateId or workItemId')
    expect(calls).toHaveLength(0)
  })

  test('gateId와 workItemId 둘 다 있으면 gateId(명시 경로)가 우선한다', async () => {
    const gateCheckFetchImpl = (async (url: string) => {
      expect(url).toContain('/api/v2/gates/gate-explicit')
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch
    const { fetchImpl } = githubSpy()

    const result = await publishSitePost({
      ...BASE_PARAMS, gateId: 'gate-explicit', workItemId: 'wi-should-be-ignored',
      siteGit: siteGitConfig(fetchImpl),
      gateCheckFetchImpl,
    })

    expect(result.commitSha).toBe('commit-sha-42')
  })

  test('레이스 방어 — work_item 경로도 ①과 ② 사이 철회를 잡는다(매번 새로 조회)', async () => {
    const { calls, fetchImpl } = githubSpy()
    let call = 0
    const gateCheckFetchImpl = (async () => {
      call += 1
      const status = call === 1 ? 'approved' : 'rejected'
      return new Response(
        JSON.stringify([{ id: 'gate-wi-1', status, gate_type: 'external_publish', work_item_id: 'wi-1', work_item_type: 'story' }]),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    await expect(
      publishSitePost({
        ...BASE_PARAMS, workItemId: 'wi-1',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(GateNotApprovedError)
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/contents/'))).toBe(true)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})

describe('buildSitePostFile — frontmatter 직렬화(계약 SSOT)', () => {
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

describe('publishSitePost — slug/lang 경로 조작 방어(story a32c9f1a, PR#37 PO 리뷰)', () => {
  test('⭐slug에 경로 조작 문자열(traversal) — GitHub 호출도 게이트 조회도 0건, chokepoint①보다 먼저 막힌다', async () => {
    const { calls, fetchImpl } = githubSpy()
    let gateCheckCalled = false
    const gateCheckFetchImpl = (async () => {
      gateCheckCalled = true
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1', slug: '../../.github/workflows/x',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl,
      }),
    ).rejects.toThrow(SlugOrLangInvalidError)
    expect(calls).toHaveLength(0)
    expect(gateCheckCalled).toBe(false)
  })

  test('lang에 경로 조작 문자열(traversal) — 동일하게 0건', async () => {
    const { calls, fetchImpl } = githubSpy()
    await expect(
      publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1', lang: '../../etc',
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      }),
    ).rejects.toThrow(SlugOrLangInvalidError)
    expect(calls).toHaveLength(0)
  })

  test('대문자·공백·언더스코어 등 규격 밖 slug도 거부된다', async () => {
    const { fetchImpl } = githubSpy()
    for (const badSlug of ['Hello-World', 'hello_world', 'hello world', '-leading-dash', 'trailing-dash-', '']) {
      await expect(
        publishSitePost({
          ...BASE_PARAMS, gateId: 'gate-1', slug: badSlug,
          siteGit: siteGitConfig(fetchImpl),
          gateCheckFetchImpl: gateCheckSpy('approved'),
        }),
      ).rejects.toThrow(SlugOrLangInvalidError)
    }
  })

  test('정상 slug(hello-world)·lang(ko, en-US)은 통과한다(양성대조 — 과잉차단 아님)', async () => {
    for (const lang of ['ko', 'en', 'en-US']) {
      const { fetchImpl } = githubSpy()
      const result = await publishSitePost({
        ...BASE_PARAMS, gateId: 'gate-1', lang,
        siteGit: siteGitConfig(fetchImpl),
        gateCheckFetchImpl: gateCheckSpy('approved'),
      })
      expect(result.commitSha).toBe('commit-sha-42')
    }
  })
})
