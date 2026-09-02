/**
 * story #3311([M1·마케팅자동화] Threads 발행 커넥터, 채널 재확定 후 발행 커넥터 #2)
 * — doc threads-publish-channel-onboarding 그대로 구현, story #3292(스티비) 동형
 * (chokepoint·assertGateApproved 재사용). Meta Threads API(전부
 * developers.facebook.com/docs/threads sitemap 경유 실 레퍼런스 페이지로 실측, 추정
 * 아님):
 *
 *   1. POST /v1.0/{THREADS_USER_ID}/threads          — 컨테이너 생성(media_type=TEXT,
 *                                                        text) → {id}(creation_id)
 *   2. POST /v1.0/{THREADS_USER_ID}/threads_publish   — 게시(creation_id) ← chokepoint가
 *                                                        이 호출 직전 (2콜 시퀀스)
 *   3. GET  /v1.0/{THREADS_USER_ID}/threads_publishing_limit — 250건/24h 한도 조회
 *   4. GET  /v1.0/{media-id}/insights                 — 인사이트(measure 대비, M3 실호출)
 *
 * ⚠️제품 경계(story #3311 본문): 이 모듈은 뭉클랩 전용이 아니다 — 조직 상수 0. 토큰·
 * 계정은 전부 호출부가 넘기는 config에서 온다(하드코딩 0).
 * ⚠️M1 스코프 — 실계정 실발행은 M3(별도 사람 승인). 이 모듈 자체는 축 무관하게 항상
 * chokepoint를 강제한다(dry-run 여부는 호출부/환경 문제, 이 모듈이 판단하지 않는다).
 */
import { assertGateApproved } from './gate-check'

const THREADS_BASE = 'https://graph.threads.net/v1.0'
const MAX_TEXT_LENGTH = 500

export interface ThreadsClientConfig {
  /** 그 조직의 것 — 이 모듈은 절대 하드코딩하지 않는다(story #3311 제품 경계). */
  accessToken: string
  userId: string
  fetchImpl?: typeof fetch
}

export class ThreadsTextTooLongError extends Error {
  constructor(public readonly length: number) {
    super(`threads post text is ${length} chars, exceeds ${MAX_TEXT_LENGTH}-char limit`)
    this.name = 'ThreadsTextTooLongError'
  }
}

export class ThreadsRateLimitExceededError extends Error {
  constructor(public readonly quotaUsage: number, public readonly quotaTotal: number) {
    super(`threads publishing limit exceeded: ${quotaUsage}/${quotaTotal} in the current 24h window`)
    this.name = 'ThreadsRateLimitExceededError'
  }
}

function withToken(url: string, accessToken: string): string {
  const u = new URL(url)
  u.searchParams.set('access_token', accessToken)
  return u.toString()
}

async function threadsCreateContainer(
  text: string, config: ThreadsClientConfig,
): Promise<{ id: string }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(withToken(`${THREADS_BASE}/${config.userId}/threads`, config.accessToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'TEXT', text }),
  })
  if (!res.ok) throw new Error(`threads create container failed: ${res.status}`)
  return (await res.json()) as { id: string }
}

async function threadsPublishContainer(
  creationId: string, config: ThreadsClientConfig,
): Promise<{ id: string }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(withToken(`${THREADS_BASE}/${config.userId}/threads_publish`, config.accessToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId }),
  })
  if (!res.ok) throw new Error(`threads publish failed: ${res.status}`)
  return (await res.json()) as { id: string }
}

export interface ThreadsPublishingLimit {
  quotaUsage: number
  quotaTotal: number
}

/** AC4 — 250/24h 한도 조회. 게시 전 호출해 초과분을 명시 에러로 막는다(재시도는 다음
 * 24h 윈도우까지 대기 — 즉시 재시도 정책 0, 호출부가 윈도우 리셋을 기다려야 한다). */
export async function threadsGetPublishingLimit(
  config: ThreadsClientConfig,
): Promise<ThreadsPublishingLimit> {
  const fetchImpl = config.fetchImpl ?? fetch
  const url = withToken(
    `${THREADS_BASE}/${config.userId}/threads_publishing_limit?fields=quota_usage,config`,
    config.accessToken,
  )
  const res = await fetchImpl(url, { method: 'GET' })
  if (!res.ok) throw new Error(`threads publishing limit lookup failed: ${res.status}`)
  const body = (await res.json()) as {
    data: [{ quota_usage: number; config: { quota_total: number } }]
  }
  const entry = body.data[0]
  return { quotaUsage: entry.quota_usage, quotaTotal: entry.config.quota_total }
}

export interface ThreadsInsights {
  views: number
  likes: number
  replies: number
  reposts: number
  quotes: number
}

/** AC5 — M3 measure 단계용. 이번엔 함수+테스트만(실호출은 M3). */
export async function threadsGetInsights(
  mediaId: string, config: ThreadsClientConfig,
): Promise<ThreadsInsights> {
  const fetchImpl = config.fetchImpl ?? fetch
  const url = withToken(
    `${THREADS_BASE}/${mediaId}/insights?metric=views,likes,replies,reposts,quotes`,
    config.accessToken,
  )
  const res = await fetchImpl(url, { method: 'GET' })
  if (!res.ok) throw new Error(`threads insights lookup failed: ${res.status}`)
  const body = (await res.json()) as { data: { name: string; values: [{ value: number }] }[] }
  const metric = (name: string) => body.data.find((m) => m.name === name)?.values[0]?.value ?? 0
  return {
    views: metric('views'),
    likes: metric('likes'),
    replies: metric('replies'),
    reposts: metric('reposts'),
    quotes: metric('quotes'),
  }
}

export interface PublishThreadsPostParams {
  gateId: string
  text: string
  sprintableApiUrl: string
  sprintableApiKey: string
  threads: ThreadsClientConfig
  /** 테스트 전용 — assertGateApproved에 넘길 fetch 스파이(Threads 호출용 fetch와 별개). */
  gateCheckFetchImpl?: typeof fetch
}

export interface PublishThreadsPostResult {
  postId: string
}

/**
 * 컨테이너 생성(draft 준비, 게이트 승인과 무관)→게이트 chokepoint→게시(밖으로 나가는
 * 마지막 한 걸음)의 2콜 시퀀스(doc threads-publish-channel-onboarding §6, story #3292
 * 동형). assertGateApproved가 여기서 throw하면 threads_publish는 절대 호출되지 않는다.
 */
export async function publishThreadsPost(
  params: PublishThreadsPostParams,
): Promise<PublishThreadsPostResult> {
  const textLength = [...params.text].length
  if (textLength > MAX_TEXT_LENGTH) throw new ThreadsTextTooLongError(textLength)

  const limit = await threadsGetPublishingLimit(params.threads)
  if (limit.quotaUsage >= limit.quotaTotal) {
    throw new ThreadsRateLimitExceededError(limit.quotaUsage, limit.quotaTotal)
  }

  const { id: creationId } = await threadsCreateContainer(params.text, params.threads)

  // ⭐chokepoint — threads_publish 호출 바로 앞의 마지막 줄(story #3311, stibee.ts
  // §chokepoint 동형). 이 줄을 지우거나 위로 옮기면(뮤테이션) pending/rejected 게이트로도
  // 게시가 나가야 정상 — threads.test.ts가 그 갈림을 pin한다.
  await assertGateApproved(
    params.gateId, params.sprintableApiUrl, params.sprintableApiKey, params.gateCheckFetchImpl,
  )

  const { id: postId } = await threadsPublishContainer(creationId, params.threads)
  return { postId }
}
