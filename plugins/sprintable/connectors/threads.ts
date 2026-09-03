/**
 * story #3311([M1·마케팅자동화] Threads 발행 커넥터, 채널 재확定 후 발행 커넥터 #2)
 * — doc threads-publish-channel-onboarding. Meta Threads API(전부
 * developers.facebook.com/docs/threads sitemap 경유 실 레퍼런스 페이지로 실측, 추정
 * 아님):
 *
 *   1. GET  /v1.0/{THREADS_USER_ID}/threads_publishing_limit — 250건/24h 한도 조회
 *   2. GET  /v1.0/{media-id}/insights                 — 인사이트(measure 단계, #3321)
 *
 * ⚠️제품 경계(story #3311 본문): 이 모듈은 뭉클랩 전용이 아니다 — 조직 상수 0. 토큰·
 * 계정은 전부 호출부가 넘기는 config에서 온다(하드코딩 0).
 *
 * ⭐story #3399(2026-09-04, 페드루 PO 확定) — 이 파일에 있던 에이전트 직접 발행 함수
 * `publishThreadsPost`(컨테이너 생성→게시 2-콜, gate 재확認 chokepoint 2회)는 삭제했다.
 * 배경: story #3366(PR#39)이 먼저 이 함수를 `EXTERNAL_PUBLISH_MOVED_TO_PLATFORM`으로
 * 동결(코드는 유지, 실행만 credential/게이트 조회보다 먼저 차단)해 둔 상태였는데, 이
 * 스토리에서 그 동결 위에 실제 삭제까지 마무리했다 — 동결을 되돌리는 게 아니라 그 위에서
 * 완결하는 것(PR 본문에 #3366 링크). 대체 경로: 서버가 이미 갖고 있는 채널 포스트
 * 초안·상신 API(#3374)를 직접 부르는 `connectors/channel-posts.ts::
 * createOrUpdateChannelPostDraft`/`submitChannelPostDraft` — 발행(POST .../publish) 자체는
 * 서버가 human-only(`CHANNEL_POST_PUBLISH_HUMAN_ONLY`, story f8f7cb0f)라 플러그인엔 절대
 * 없다. `get_threads_insights`(측정, 발행 아님)는 그대로 이 파일에 남는다.
 */
import { recordEvidence } from './evidence'

const DEFAULT_WORK_ITEM_TYPE = 'story'

const THREADS_BASE = 'https://graph.threads.net/v1.0'

export interface ThreadsClientConfig {
  /** 그 조직의 것 — 이 모듈은 절대 하드코딩하지 않는다(story #3311 제품 경계). */
  accessToken: string
  userId: string
  fetchImpl?: typeof fetch
}

function withToken(url: string, accessToken: string): string {
  const u = new URL(url)
  u.searchParams.set('access_token', accessToken)
  return u.toString()
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

export interface GetThreadsInsightsAndRecordEvidenceParams {
  postId: string
  workItemId: string
  /** 기본 'story'(threads.ts 나머지 함수와 동형 — 오타 방지 목적일 뿐 조직 규칙 아님). */
  workItemType?: string
  sprintableApiUrl: string
  sprintableApiKey: string
  threads: ThreadsClientConfig
  /** 테스트 전용 — evidence 기록 호출에 넘길 fetch 스파이(Threads insights 호출용
   * fetch와 별개 — 두 시스템에 각각 나가므로 스파이도 갈라야 시퀀스를 정확히 pin한다). */
  evidenceFetchImpl?: typeof fetch
}

export interface GetThreadsInsightsAndRecordEvidenceResult extends ThreadsInsights {
  /** 이 도구는 성공/실패 "판단"을 하지 않는다(story #3321 경계) — evidenceRecorded는
   * "기록이 됐다/안 됐다"는 사실 보고일 뿐, 지표 자체의 좋고 나쁨과 무관하다. */
  evidenceRecorded: boolean
  evidenceId?: string
  /** evidenceRecorded===false일 때만 채워진다 — 조용한 성공 금지(PO 리뷰 못박음①). */
  evidenceError?: string
}

/**
 * story #3321([M5·마케팅자동화] measure 단계 도구) — insights 조회 + evidence 기록을
 * 한 호출로 묶는다. "측정은 했는데 기록을 깜빡" 갭(전달≠도착 교훈)을 구조로 막는다.
 *
 * 순서: ① insights 조회 실패 → 그 자리에서 throw, evidence 호출 0건(원자성 — 아직 잴
 * 것도 없는데 기록부터 만들면 안 된다). ② insights 성공 → evidence 기록 시도 — 성공하면
 * evidenceRecorded:true+evidenceId, **실패해도 지표는 그대로 반환**하되
 * evidenceRecorded:false+evidenceError로 명시(PO 리뷰 못박음① — 조용한 성공 금지).
 * 응답에 verdict/success 류 판정 필드는 절대 없다(못박음②) — 목표값은 work item의
 * success_hypothesis가 조직 몫으로 갖는다.
 */
export async function getThreadsInsightsAndRecordEvidence(
  params: GetThreadsInsightsAndRecordEvidenceParams,
): Promise<GetThreadsInsightsAndRecordEvidenceResult> {
  if (!params.workItemId) {
    throw new Error('getThreadsInsightsAndRecordEvidence requires workItemId (evidence attribution)')
  }

  const insights = await threadsGetInsights(params.postId, params.threads)

  try {
    const { id } = await recordEvidence({
      workItemId: params.workItemId,
      workItemType: params.workItemType ?? DEFAULT_WORK_ITEM_TYPE,
      type: 'metric',
      ref: params.postId,
      note: JSON.stringify({ ...insights, measured_at: new Date().toISOString() }),
      apiUrl: params.sprintableApiUrl,
      apiKey: params.sprintableApiKey,
      fetchImpl: params.evidenceFetchImpl,
    })
    return { ...insights, evidenceRecorded: true, evidenceId: id }
  } catch (err) {
    return { ...insights, evidenceRecorded: false, evidenceError: err instanceof Error ? err.message : String(err) }
  }
}
