/**
 * story a98dfbea([M4·마케팅자동화] 두 번째 A 경로 채널 = Instagram Graph API 커넥터)
 * — 배선 부분만(PO 지시, 2026-09-02: connector 스키마·describe_connector·publish 도구·
 * chokepoint 2점·드라이런 — 실 IG 계정/토큰 없이 되는 만큼). Threads(#3311)의 Meta 앱을
 * 재사용한다는 게 이 스토리의 전제 — 단 Threads API(graph.threads.net)와 Instagram
 * Graph API(graph.facebook.com, Facebook Login/Page-연결 변형)는 **다른 host·다른 인증
 * 경로**다: Instagram professional 계정이 **Facebook Page에 연결**돼 있어야 하고,
 * 그 Page의 access token으로 호출한다(developers.facebook.com/docs/instagram-api/
 * guides/content-publishing 실측, 추정 아님) — 재사용되는 건 "같은 Meta 개발자 앱
 * 등록"뿐, API host·토큰 종류는 별개.
 *
 * 2개 엔드포인트(위 레퍼런스 페이지 실측):
 *   1. POST /<IG_ID>/media          — 컨테이너 생성(image_url 필수 — Instagram은 순수
 *                                      텍스트 게시를 지원하지 않는다, "media must be
 *                                      hosted on a publicly accessible server") → {id}
 *   2. POST /<IG_ID>/media_publish  — 게시(creation_id) ← chokepoint②가 이 호출 직전
 *
 * ⚠️`content_publishing_limit`(24h/100건 한도) 엔드포인트는 존재가 문서로 확認됐으나
 * **응답 body 형상은 문서에서 못 찾았다**(threads_publishing_limit처럼 example JSON이
 * 없음) — 추정으로 파서를 짜지 않는다(이 조직 규율: 실측 안 된 건 안 쓴다). 이번 배선은
 * 그래서 한도 조회를 포함하지 않는다 — 실 계정으로 1회 호출해 응답을 실측한 뒤 별도로
 * 추가한다(스코프 밖 선언, Threads AC4 동형 기능이 이 스토리엔 없음).
 * ⚠️M4 스코프 — 실계정 실발행은 착수 조건(M3 Threads 실발행 후) 충족 뒤 별도. 이 모듈
 * 자체는 축 무관하게 항상 chokepoint를 강제한다.
 */
import { assertGateApproved, assertGateApprovedForWorkItem } from './gate-check'

const EXTERNAL_PUBLISH_GATE_TYPE = 'external_publish'
const DEFAULT_WORK_ITEM_TYPE = 'story'

const INSTAGRAM_BASE = 'https://graph.facebook.com/v25.0'

export interface InstagramClientConfig {
  /** Facebook Page access token(IG 계정이 연결된 그 Page) — IG 유저 토큰이 아니다. */
  accessToken: string
  /** Instagram professional 계정의 IG user id(Page 연결로 얻는 값, 앱/토큰과 별개). */
  igUserId: string
  fetchImpl?: typeof fetch
}

function withToken(url: string, accessToken: string): string {
  const u = new URL(url)
  u.searchParams.set('access_token', accessToken)
  return u.toString()
}

async function instagramCreateContainer(
  params: { imageUrl: string; caption?: string }, config: InstagramClientConfig,
): Promise<{ id: string }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(withToken(`${INSTAGRAM_BASE}/${config.igUserId}/media`, config.accessToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: params.imageUrl, ...(params.caption ? { caption: params.caption } : {}) }),
  })
  if (!res.ok) throw new Error(`instagram create container failed: ${res.status}`)
  return (await res.json()) as { id: string }
}

async function instagramPublishContainer(
  creationId: string, config: InstagramClientConfig,
): Promise<{ id: string }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(withToken(`${INSTAGRAM_BASE}/${config.igUserId}/media_publish`, config.accessToken), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId }),
  })
  if (!res.ok) throw new Error(`instagram publish failed: ${res.status}`)
  return (await res.json()) as { id: string }
}

export interface PublishInstagramPostParams {
  /** 명시 경로(수동 호출·테스트 호환) — 있으면 이 경로가 우선한다. */
  gateId?: string
  /** work_item 경로(story #3312 AC5 동형) — gateId가 없을 때 이 work item의 최신
   * external_publish 게이트를 조회해 판정한다. gateId·workItemId 둘 다 없으면 즉시
   * 명시 에러(네트워크 호출 0건). */
  workItemId?: string
  /** 기본 'story'(threads.ts·stibee.ts와 동형 — 오타 방지 목적일 뿐 조직 규칙 아님). */
  workItemType?: string
  /** 공개 접근 가능한 이미지 URL — Instagram은 순수 텍스트 게시를 지원하지 않는다(필수). */
  imageUrl: string
  /** 게시물 캡션(선택). */
  caption?: string
  sprintableApiUrl: string
  sprintableApiKey: string
  instagram: InstagramClientConfig
  /** 테스트 전용 — assertGateApproved(ForWorkItem)에 넘길 fetch 스파이(Instagram 호출용
   * fetch와 별개). */
  gateCheckFetchImpl?: typeof fetch
}

export interface PublishInstagramPostResult {
  mediaId: string
}

/**
 * gateId 명시 경로 또는 work_item 해석 경로(story #3312 AC5) 중 하나로 게이트 승인을
 * 확認한다 — threads.ts·stibee.ts::assertPublishGateApproved와 동형(새 게이트 로직
 * 발명 0, gate-check.ts의 두 검증 함수를 그대로 위임).
 */
async function assertPublishGateApproved(params: PublishInstagramPostParams): Promise<void> {
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
  throw new Error('publishInstagramPost requires either gateId or workItemId to check the external_publish gate')
}

/**
 * 두 chokepoint(story 6f2034cf·threads.ts §PR#29 PO AC 리뷰와 동형 배치, story a98dfbea
 * 처방 그대로 재사용 — "공통 계약" README 절 참조): 컨테이너 생성(POST .../media)은
 * Instagram 쪽에 실제로 나가는 쓰기 요청이라 — stibee의 옛 "draft 준비" 가정(story
 * 6f2034cf가 이미 틀렸다고 정정)과 같은 함정을 이 커넥터는 처음부터 안 만든다.
 *   1) 첫 chokepoint — 함수 진입 직후, 어떤 Instagram 호출보다도 먼저. 미승인이면 이
 *      시점에서 outbound 정확히 0건.
 *   2) 둘째 chokepoint — media_publish 호출 바로 앞(레이스 방어: ①과 이 사이에 승인이
 *      철회됐을 수 있다).
 */
export async function publishInstagramPost(
  params: PublishInstagramPostParams,
): Promise<PublishInstagramPostResult> {
  if (!params.gateId && !params.workItemId) {
    throw new Error('publishInstagramPost requires either gateId or workItemId to check the external_publish gate')
  }

  // ⭐chokepoint① — media 컨테이너 생성을 포함한 어떤 Instagram 호출보다도 먼저. 이 줄을
  // 지우거나 아래로 옮기면(뮤테이션) pending/rejected 게이트로도 컨테이너 생성이 나가야
  // 정상 — instagram.test.ts가 그 갈림을 pin한다.
  await assertPublishGateApproved(params)

  const { id: creationId } = await instagramCreateContainer(
    { imageUrl: params.imageUrl, caption: params.caption }, params.instagram,
  )

  // ⭐chokepoint② — media_publish 호출 바로 앞의 마지막 줄(레이스 방어). 이 줄을 지우거나
  // 위로 옮기면(뮤테이션) ①통과 후 철회된 게이트로도 게시가 나가야 정상 —
  // instagram.test.ts가 그 갈림을 pin한다.
  await assertPublishGateApproved(params)

  const { id: mediaId } = await instagramPublishContainer(creationId, params.instagram)
  return { mediaId }
}
