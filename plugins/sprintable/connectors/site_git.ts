/**
 * story a32c9f1a([마케팅자동화·발행 채널] 자사 사이트 발행 커넥터, 외부 소셜 계정 없이
 * 밖에 닿는 첫 채널) — 승인된 글을 조직이 지정한 git 저장소 경로에 markdown 파일로
 * 커밋해 공개한다(threads.ts/instagram.ts 동형 chokepoint — "공통 계약" README 절 참조).
 * 실물 계약(PO 확定, 2026-09-03 · sprintable-landing 레포 그라운딩 후):
 *
 *   경로: `{pathTemplate}`(기본 `content/blog/{lang}/{slug}.md`, {lang}/{slug} 치환)
 *   frontmatter(YAML): title·slug·lang·publishedAt(ISO8601, 커밋 시점 자동)
 *                       + 선택 summary·tags·source_story(work_item id, 자동)
 *   본문: 순수 markdown(그대로 파일에)
 *
 * GitHub Contents API(docs.github.com/en/rest/repos/contents 실측, 추정 아님):
 *   PUT /repos/{owner}/{repo}/contents/{path} — content는 base64, 신규 파일은 sha 생략,
 *   기존 파일 갱신은 현재 sha 필수(먼저 GET으로 조회) → 응답 { commit: { sha }, content: {...} }.
 *
 * ⚠️mode='pr'(브랜치+PR 생성)은 이 배선에 없다 — org_config는 branch 하나(직접 커밋)만
 * 지원한다. PR 모드는 별도 브랜치명 생성·베이스 ref 해소·PR 오픈까지 필요해 이 스토리의
 * "wiring only" 스코프를 넘는다(threads.ts의 한도조회 미배선과 동형 discipline — 실측
 * 안 된/이번에 안 쓰는 건 안 짓는다). 필요해지면 별도 스토리.
 * ⚠️YAML frontmatter는 라이브러리 없이 손으로 직렬화한다(필드 집합이 작고 고정 — 값은
 * 항상 큰따옴표로 감싸 콜론·특수문자 모호성을 원천 차단, 배열은 인라인 `[...]`).
 */
import { assertGateApproved, assertGateApprovedForWorkItem } from './gate-check'
import { assertExternalPublishNotFrozen } from './publish-freeze'

const EXTERNAL_PUBLISH_GATE_TYPE = 'external_publish'
const DEFAULT_WORK_ITEM_TYPE = 'story'

const GITHUB_API_BASE = 'https://api.github.com'

export interface SiteGitClientConfig {
  /** 그 조직의 것 — 이 모듈은 절대 하드코딩하지 않는다(threads.ts/instagram.ts와 동형
   * 제품 경계). repo 쓰기 권한(Contents API)이 있는 GitHub PAT. */
  githubToken: string
  /** "owner/name" 형태. */
  repo: string
  branch: string
  /** 예: `content/blog/{lang}/{slug}.md` — {lang}/{slug} 플레이스홀더만 치환한다. */
  pathTemplate: string
  /** 공개 사이트의 base URL(예 `https://sprintable.ai`) — 응답의 예상 공개 URL 계산용. */
  siteBaseUrl: string
  fetchImpl?: typeof fetch
}

function resolvePath(pathTemplate: string, params: { lang: string; slug: string }): string {
  return pathTemplate.replace('{lang}', params.lang).replace('{slug}', params.slug)
}

// story a32c9f1a(PO 리뷰, PR#37) — 게이트 승인은 「글」을 본 것이지 path_template에
// 치환될 slug/lang 문자열 자체를 본 게 아니다. resolvePath()는 순수 substring 치환이라
// slug에 `../../.github/workflows/x` 같은 경로 조작 문자열이 들어오면 Contents 쓰기
// 권한이 있는 PAT로 저장소 임의 경로(워크플로우 파일이면 CI 탈취)에 쓸 수 있다 —
// chokepoint①보다도 먼저 막는다(입력 검증은 인가 판정과 무관한 별개 축).
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/

export class SlugOrLangInvalidError extends Error {
  constructor(public readonly field: 'slug' | 'lang', public readonly value: string) {
    super(`publishSitePost: ${field}=${JSON.stringify(value)} does not match the required shape — refusing to resolve a file path from it`)
    this.name = 'SlugOrLangInvalidError'
  }
}

/** story #3366 — export한다: publishSitePost가 이제 항상 그 전에 얼어붙어(아래 chokepoint
 * 이전 guard) 이 검증까지 도달하지 못하므로, site_git.test.ts가 이 순수 검증 로직 자체를
 * (경로 조작 방어는 서버 어댑터 재사용 대상이라 여전히 가치 있다) publishSitePost를
 * 거치지 않고 직접 단위 테스트할 수 있게 한다. */
export function assertSlugAndLangShape(slug: string, lang: string): void {
  if (!SLUG_RE.test(slug)) throw new SlugOrLangInvalidError('slug', slug)
  if (!LANG_RE.test(lang)) throw new SlugOrLangInvalidError('lang', lang)
}

function encodeContentsPath(path: string): string {
  // GitHub Contents API path는 세그먼트별로 인코딩(슬래시 자체는 보존).
  return path.split('/').map(encodeURIComponent).join('/')
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface SitePostFrontmatter {
  title: string
  slug: string
  lang: string
  publishedAt: string
  summary?: string
  tags?: string[]
  sourceStory?: string
}

/** frontmatter + 본문을 하나의 markdown 파일 텍스트로 직렬화(계약 SSOT — 랜딩 쪽 파서가
 * 이 형상을 그대로 읽는다, README §자사 사이트 발행 계약 참조). */
export function buildSitePostFile(frontmatter: SitePostFrontmatter, body: string): string {
  const lines: string[] = ['---']
  lines.push(`title: ${yamlQuote(frontmatter.title)}`)
  lines.push(`slug: ${yamlQuote(frontmatter.slug)}`)
  lines.push(`lang: ${yamlQuote(frontmatter.lang)}`)
  lines.push(`publishedAt: ${yamlQuote(frontmatter.publishedAt)}`)
  if (frontmatter.summary) lines.push(`summary: ${yamlQuote(frontmatter.summary)}`)
  if (frontmatter.tags && frontmatter.tags.length > 0) {
    lines.push(`tags: [${frontmatter.tags.map(yamlQuote).join(', ')}]`)
  }
  if (frontmatter.sourceStory) lines.push(`source_story: ${yamlQuote(frontmatter.sourceStory)}`)
  lines.push('---', '', body)
  return lines.join('\n')
}

interface GitHubContentsGetResponse {
  sha: string
}

/** 기존 파일의 sha 조회(갱신 시 필수 — GitHub Contents API 실측). 없으면(404) null —
 * 신규 파일 생성 경로. 404 이외의 실패는 그대로 throw(권한·레포 오류를 삼키지 않는다). */
async function siteGitGetFileSha(path: string, config: SiteGitClientConfig): Promise<string | null> {
  const fetchImpl = config.fetchImpl ?? fetch
  const url = `${GITHUB_API_BASE}/repos/${config.repo}/contents/${encodeContentsPath(path)}?ref=${encodeURIComponent(config.branch)}`
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`site_git file sha lookup failed: ${res.status}`)
  const body = (await res.json()) as GitHubContentsGetResponse
  return body.sha
}

export interface SiteGitCommitResult {
  commitSha: string
  htmlUrl: string
}

/** 파일 생성/갱신(Contents API PUT) — sha가 있으면 갱신(재발행 idempotent), 없으면 신규
 * 생성. content는 base64(Contents API 요구, 실측). */
async function siteGitCommitFile(
  path: string, content: string, sha: string | null, config: SiteGitClientConfig,
): Promise<SiteGitCommitResult> {
  const fetchImpl = config.fetchImpl ?? fetch
  const url = `${GITHUB_API_BASE}/repos/${config.repo}/contents/${encodeContentsPath(path)}`
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `chore(blog): publish ${path}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch: config.branch,
      ...(sha ? { sha } : {}),
    }),
  })
  if (!res.ok) throw new Error(`site_git commit failed: ${res.status}`)
  const body = (await res.json()) as { commit: { sha: string; html_url: string } }
  return { commitSha: body.commit.sha, htmlUrl: body.commit.html_url }
}

export interface PublishSitePostParams {
  /** 명시 경로(수동 호출·테스트 호환) — 있으면 이 경로가 우선한다. */
  gateId?: string
  /** work_item 경로(story #3312 AC5 동형) — gateId가 없을 때 이 work item의 최신
   * external_publish 게이트를 조회해 판정한다. gateId·workItemId 둘 다 없으면 즉시
   * 명시 에러(네트워크 호출 0건). */
  workItemId?: string
  /** 기본 'story'(threads.ts·stibee.ts·instagram.ts와 동형 — 오타 방지 목적일 뿐 조직
   * 규칙 아님). */
  workItemType?: string
  title: string
  /** 순수 markdown 본문. */
  body: string
  slug: string
  lang: string
  summary?: string
  tags?: string[]
  sprintableApiUrl: string
  sprintableApiKey: string
  siteGit: SiteGitClientConfig
  /** 테스트 전용 — assertGateApproved(ForWorkItem)에 넘길 fetch 스파이(GitHub 호출용
   * fetch와 별개). */
  gateCheckFetchImpl?: typeof fetch
}

export interface PublishSitePostResult {
  commitSha: string
  path: string
  /** siteBaseUrl + `/{lang}/blog/{slug}`(sprintable-landing 레포 그라운딩 확認 경로,
   * story 2b4067b5 계약과 고정). */
  url: string
}

async function assertPublishGateApproved(params: PublishSitePostParams): Promise<void> {
  if (params.gateId) {
    await assertGateApproved(
      params.gateId, params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
    )
    return
  }
  if (params.workItemId) {
    await assertGateApprovedForWorkItem(
      params.workItemId, params.workItemType ?? DEFAULT_WORK_ITEM_TYPE, EXTERNAL_PUBLISH_GATE_TYPE,
      params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
    )
    return
  }
  throw new Error('publishSitePost requires either gateId or workItemId to check the external_publish gate')
}

/**
 * 두 chokepoint(story 6f2034cf "공통 계약" README 절 그대로 재사용 — 새 게이트 로직
 * 발명 0):
 *   1) 첫 chokepoint — 함수 진입 직후, sha 조회(GitHub GET)를 포함한 어떤 GitHub 호출보다도
 *      먼저. 미승인이면 이 시점에서 outbound 정확히 0건(읽기 조회도 포함 — threads.ts의
 *      한도조회 GET과 동일 discipline).
 *   2) 둘째 chokepoint — 커밋(PUT, 실제 공개 쓰기) 바로 앞의 마지막 줄(레이스 방어: ①과
 *      이 사이에 승인이 철회됐을 수 있다). sha 조회는 읽기라 재확認 대상이 아니다.
 */
export async function publishSitePost(
  params: PublishSitePostParams,
): Promise<PublishSitePostResult> {
  // ⭐story #3366 — 함수의 가장 첫 줄. slug/lang 경로 조작 방어보다도, gateId/workItemId
  // 존재 검사보다도 먼저(뮤테이션 표적: 이 줄을 아래로 옮기면 fetch spy가 0을 벗어나야
  // 정상 — site_git.test.ts가 그 갈림을 pin한다).
  assertExternalPublishNotFrozen('publish_site_post')

  if (!params.gateId && !params.workItemId) {
    throw new Error('publishSitePost requires either gateId or workItemId to check the external_publish gate')
  }

  // ⭐경로 조작 방어(PR#37 PO 리뷰) — chokepoint①보다도 먼저, GitHub 호출은 물론
  // 게이트 조회보다도 먼저 던진다(입력 형상 자체가 글러먹었으면 승인 여부를 물을
  // 이유가 없다). 지우면(뮤테이션) traversal slug로도 sha GET이 나가야 정상 —
  // site_git.test.ts가 그 갈림을 pin한다.
  assertSlugAndLangShape(params.slug, params.lang)

  // ⭐chokepoint① — sha 조회를 포함한 어떤 GitHub 호출보다도 먼저. 지우거나 아래로
  // 옮기면(뮤테이션) pending/rejected 게이트로도 sha 조회가 나가야 정상 —
  // site_git.test.ts가 그 갈림을 pin한다.
  await assertPublishGateApproved(params)

  const path = resolvePath(params.siteGit.pathTemplate, { lang: params.lang, slug: params.slug })
  const publishedAt = new Date().toISOString()
  const fileContent = buildSitePostFile(
    {
      title: params.title, slug: params.slug, lang: params.lang, publishedAt,
      summary: params.summary, tags: params.tags, sourceStory: params.workItemId,
    },
    params.body,
  )
  const existingSha = await siteGitGetFileSha(path, params.siteGit)

  // ⭐chokepoint② — 커밋(PUT) 호출 바로 앞의 마지막 줄. 지우거나 위로 옮기면(뮤테이션)
  // ①통과 후 철회된 게이트로도 커밋이 나가야 정상 — site_git.test.ts가 그 갈림을 pin한다.
  await assertPublishGateApproved(params)

  const { commitSha } = await siteGitCommitFile(path, fileContent, existingSha, params.siteGit)
  const url = `${params.siteGit.siteBaseUrl.replace(/\/$/, '')}/${params.lang}/blog/${params.slug}`
  return { commitSha, path, url }
}
