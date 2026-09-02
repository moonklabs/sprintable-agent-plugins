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
import { assertGateApproved, assertGateApprovedForWorkItem } from './gate-check'

const EXTERNAL_PUBLISH_GATE_TYPE = 'external_publish'
const DEFAULT_WORK_ITEM_TYPE = 'story'

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
  /** 명시 경로(수동 호출·테스트 호환) — 있으면 이 경로가 우선한다. */
  gateId?: string
  /** work_item 경로(story #3312 AC5, 레시피 자동루프용) — gateId가 없을 때 이 work item의
   * 최신 external_publish 게이트를 조회해 판정한다. gateId·workItemId 둘 다 없으면 즉시
   * 명시 에러(네트워크 호출 0건). */
  workItemId?: string
  /** 기본 'story' — recipe work item이 대부분 story라 기본값을 둔다(오타 방지 목적일 뿐 조직
   * 규칙 아님, 값 자체는 항상 호출부가 넘길 수 있다). */
  workItemType?: string
  text: string
  sprintableApiUrl: string
  sprintableApiKey: string
  threads: ThreadsClientConfig
  /** 테스트 전용 — assertGateApproved(ForWorkItem)에 넘길 fetch 스파이(Threads 호출용
   * fetch와 별개). */
  gateCheckFetchImpl?: typeof fetch
}

export interface PublishThreadsPostResult {
  postId: string
}

/**
 * gateId 명시 경로 또는 work_item 해석 경로(story #3312 AC5) 중 하나로 게이트 승인을
 * 확認한다 — 두 chokepoint가 매번 이 함수 하나만 부르면 되도록 판정 로직을 한 곳에
 * 모은다(새 게이트 로직 발명 0, gate-check.ts의 두 검증 함수를 그대로 위임).
 */
async function assertPublishGateApproved(params: PublishThreadsPostParams): Promise<void> {
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
  throw new Error('publishThreadsPost requires either gateId or workItemId to check the external_publish gate')
}

/**
 * ⭐두 chokepoint(PO AC 리뷰 정정, story #3311 PR#29 코멘트): 컨테이너 생성(POST
 * .../threads)은 Meta 쪽에 실제로 나가는 쓰기 요청이라 — 스티비의 draft 준비(자기
 * 시스템 내부 상태 변경)와 달리 — 게이트 승인 전에는 절대 나가면 안 된다(제품 원칙3
 * «밖으로 나가는 건 사람 승인 뒤에서만»). 그래서:
 *   1) 첫 chokepoint — 함수 진입 직후, 어떤 Threads 네트워크 호출(한도 조회 포함)보다도
 *      먼저. 미승인이면 이 시점에서 outbound 호출이 정확히 0건.
 *   2) 둘째 chokepoint — threads_publish 호출 바로 앞(stibee.ts §chokepoint 동형) —
 *      1)과 2) 사이(한도조회+컨테이너생성)에 승인이 철회되는 레이스를 막는 재확認.
 * 둘 중 하나라도 지우면(뮤테이션) 대응하는 pin이 RED — threads.test.ts가 각각 별도로
 * 검증한다(2)만 지워도 1)이 여전히 최초 outbound를 막지만, 레이스 방어 테스트가 publish
 * 호출 발생으로 RED). work_item 경로(AC5)는 매 chokepoint마다 새로 조회하므로(캐싱 없음)
 * ①과 ② 사이에 게이트가 교체/철회되는 레이스도 gateId 명시 경로와 동일하게 잡힌다.
 */
export async function publishThreadsPost(
  params: PublishThreadsPostParams,
): Promise<PublishThreadsPostResult> {
  const textLength = [...params.text].length
  if (textLength > MAX_TEXT_LENGTH) throw new ThreadsTextTooLongError(textLength)

  // ⭐chokepoint① — 한도 조회·컨테이너 생성 등 어떤 Threads 호출보다도 먼저. 미승인이면
  // 여기서 throw — outbound(한도 조회 GET 포함) 정확히 0건.
  await assertPublishGateApproved(params)

  const limit = await threadsGetPublishingLimit(params.threads)
  if (limit.quotaUsage >= limit.quotaTotal) {
    throw new ThreadsRateLimitExceededError(limit.quotaUsage, limit.quotaTotal)
  }

  const { id: creationId } = await threadsCreateContainer(params.text, params.threads)

  // ⭐chokepoint② — threads_publish 호출 바로 앞의 마지막 줄(레이스 방어: ①과 이 사이에
  // 승인이 철회됐을 수 있다). 이 줄을 지우거나 위로 옮기면(뮤테이션) ①통과 후 철회된
  // 게이트로도 게시가 나가야 정상 — threads.test.ts가 그 갈림을 pin한다.
  await assertPublishGateApproved(params)

  const { id: postId } = await threadsPublishContainer(creationId, params.threads)
  return { postId }
}
