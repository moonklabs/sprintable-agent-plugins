/**
 * MCP 도구 목록 정의 — story #3317 PR#30 후속 채팅(PO 확定)에서 server.ts의
 * ListToolsRequestSchema 핸들러 안에 인라인이던 `tools: [...]`를 순수(부작용 0) 모듈로
 * 뽑았다. server.ts는 `await mcp.connect(...)`·SSE dial-out을 모듈 로드 시점에 실행하므로
 * 그 파일을 테스트에서 직접 import하면 실제 stdio 서버/네트워크 연결이 시도된다 — 이
 * 파일은 그 부작용이 전혀 없어 `tool-definitions.test.ts`가 안전하게 import해 드리프트를
 * 직접 pin할 수 있다(사본 비교가 아니라 실제 이 배열을 대조 — server.ts도 동일 배열을
 * 그대로 쓴다).
 *
 * publish_stibee_campaign의 `create.*`/`html`은 중첩 객체라 이 파생 대상이 아니고 손으로
 * 유지하되, tool-definitions.test.ts가 STIBEE_CONNECTOR_DESCRIPTOR의 content 필드가
 * 실제로 여기 존재하는지 대조한다. (story #3399 — publish_threads_post 삭제로
 * THREADS_CONNECTOR_DESCRIPTOR 파생은 이제 없다. 대체 도구 create_channel_post_draft는
 * 채널 무관 범용 text 필드라 기계적 파생 대상이 아니다.)
 *
 * story #3495(페드루 PO 確定 2026-09-05, 미르코 그라운딩 ③) — channel_post/site_post
 * 발행 도구 6개(create_channel_post_draft·submit_channel_post_draft·
 * get_channel_post_publication·create_site_post_draft·submit_site_post_draft·
 * get_site_post_publication)는 각자 description에 다음 단계를 링크해 두지만, 전체
 * 흐름을 한눈에 보려면 `skills/publish-content/SKILL.md`가 정본이다 — 여기 요약이
 * 스킬과 어긋나면 **스킬이 이긴다**(이 요약은 빠른 참조일 뿐, 재작성 시 스킬을 먼저
 * 고치고 여기를 그대로 따라오게 한다):
 *
 *   1. create_*_draft(초안 생성/수정, work_item당 버전 누적)
 *   2. violations[]가 있으면(콘텐츠 규칙 위반, {code,field,value,hint_key,settings_path}
 *      — message 필드 없음) 필드를 고쳐 create_*_draft 재호출
 *   3. submit_*_draft(external_publish 게이트로 상신 — 발행 아님)
 *   4. 휴먼 승인 대기(폴링 도구 없음 — 기다린다, 조르지 않는다)
 *   5. 승인 뒤 get_*_publication으로 결과 읽기 — 누가/언제 발행하는지는 갈린다
 *      (gate_service.py::_maybe_create_scheduled_publication_command 실측): site_post
 *      (외부 목적지)·scheduled_at 있는 channel_post=승인 즉시/그 시각에 워커가 커맨드를
 *      만들어 발행 · **scheduled_at 없는 channel_post=승인만으론 커맨드 자체가 안 생긴다
 *      — 휴먼이 화면에서 별도로 「발행」을 눌러야 한다(도구 없음). command가 null이면
 *      그게 정상 상태다("승인 済, 휴먼 발행 클릭 대기"로 보고 — 막힌 게 아니다).
 *   6. command_status 분기: pending/in_progress/failed=조치 없음(워커 자동 재시도) ·
 *      dead_letter=휴먼에게 command_id와 함께 보고(에이전트 재시도 도구는 이 슬라이스
 *      범위 밖 — 재시도는 휴먼 화면/엔드포인트 몫).
 */
import { STIBEE_CONNECTOR_DESCRIPTOR } from './connectors/stibee.schema'
import { INSTAGRAM_CONNECTOR_DESCRIPTOR } from './connectors/instagram.schema'
import { SITE_GIT_CONNECTOR_DESCRIPTOR } from './connectors/site_git.schema'
import { contentPropertiesToJsonSchema } from './connectors/connector-schema'

// story a98dfbea — instagram도 threads처럼 flat content 필드(imageUrl·caption, dot-path
// 없음)라 같은 기계적 파생 경로를 그대로 탄다(stibee만 중첩이라 예외).
const instagramContentSchema = contentPropertiesToJsonSchema(INSTAGRAM_CONNECTOR_DESCRIPTOR)
// story a32c9f1a — site_git도 flat content 필드(title/body/slug/lang/summary/tags,
// dot-path 없음)라 같은 기계적 파생 경로.
const siteGitContentSchema = contentPropertiesToJsonSchema(SITE_GIT_CONNECTOR_DESCRIPTOR)

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'reply',
    description:
      'POST /api/v2/conversations/{id}/messages. Requires an active conversation. ' +
      'If multiple channels may be active concurrently, pass chat_id (the exact value ' +
      'from the <channel chat_id="..."> tag you are replying to) to target that ' +
      'conversation explicitly — otherwise this defaults to the most recently received ' +
      'conversation, which can misroute if another channel message arrives in between.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        chat_id: {
          type: 'string',
          description:
            'Optional. Echo back the chat_id attribute from the inbound <channel> tag to ' +
            'target that exact conversation, regardless of which channel most recently sent a message.',
        },
      },
      required: ['text'],
      // story #2622(Pedro QA): 오타 파라미터명(예: 습관대로 conversation_id)이 조용히
      // 버려져 latestInboundMeta 폴백으로 새면, 이 스토리가 막으려는 정확히 그 오배송
      // 클래스가 한 겹 남는다 — 스키마 레벨에서 알 수 없는 필드를 거부한다.
      additionalProperties: false,
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a previously sent message.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['message_id', 'text'],
    },
  },
  {
    // HITL①(#2570) Path A — 사용자가 `claude -p --permission-prompt-tool
    // mcp__plugin_sprintable_sprintable-channel__approval_prompt`로 명시 지정해야만 호출됨
    // (opt-in, AC4). 카디르 QA 지적: 실 플러그인 설치 등록명은 mcp__plugin_<plugin>_
    // <server>__<tool> 접두라 bare mcp__sprintable__approval_prompt(--mcp-config
    // ad hoc 로드 전용, 로컬 개발 테스트에서만 맞음)로 쓰면 즉시 "tool not found".
    // #2577: 서버키를 sprintable → sprintable-channel로 개명(hosted 도구 MCP인
    // sprintable-mcp와의 동명 충돌 해소) — 위 실 등록명도 이 개명을 반영함.
    name: 'approval_prompt',
    description:
      'Requests human approval for a tool call via Sprintable chat. Used as --permission-prompt-tool.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
    },
  },
  {
    // story #3292([M1·마케팅자동화] 발행 커넥터) — doc stibee-publish-connector-wiring-
    // design-3292. gate_id는 external_publish 게이트(link_gate_to_task reason=
    // "external_publish"로 이 발행 task에 이미 묶여 있어야 함) — 이 도구를 호출하는 것
    // 자체는 승인의 증거가 아니다: 내부에서 GET /api/v2/gates/{gate_id}로 gate.status를
    // 재확인하고, approved/auto_passed가 아니면 실제 Stibee 발송(POST /send)을 절대
    // 호출하지 않는다(defense-in-depth — 이 호출을 승인 신호로 믿지 않는다).
    // ⚠️STIBEE_ACCESS_TOKEN 미설정이면 즉시 에러(/sprintable:configure-stibee 안내).
    // story #3312 AC5: gate_id가 없으면 work_item(+work_item_type)으로 「이 work item의
    // 최신 external_publish 게이트」를 조회해 동일 판정을 한다(PR#3704 «커넥터용 조회
    // 계약» — 새 라우트 없음, 기존 GET /api/v2/gates 필터+limit=1). 레시피 자동루프가
    // gate_id를 몰라도 되게 하는 경로 — 명시 gate_id가 있으면 그쪽이 항상 우선.
    // story #3317: create.subject/html=content, create.senderEmail/senderName/listId(+선택
    // groupIds/segmentIds)=org_config — STIBEE_CONNECTOR_DESCRIPTOR가 정본
    // (connectors/stibee.schema.ts), 이 inputSchema는 그 필드 목록과
    // tool-definitions.test.ts로 드리프트 대조된다.
    name: 'publish_stibee_campaign',
    description:
      '⚠️FROZEN (story #3366): calling this immediately throws EXTERNAL_PUBLISH_MOVED_TO_PLATFORM ' +
      'before any credential/gate lookup or HTTP request — submit the draft and publish from the ' +
      'Sprintable screen instead. Kept only for discoverability; not executable. ' +
      'Publish an email campaign via Stibee (create draft → set HTML content → optional ' +
      'metadata update → send), gated on an approved external_publish Gate. Pass either ' +
      'gate_id (explicit) or work_item (resolves the latest external_publish gate for that ' +
      'work item) — at least one is required. The send call is blocked unless the resolved ' +
      'gate reports status approved or auto_passed — calling this tool does not itself ' +
      'authorize the send.',
    inputSchema: {
      type: 'object',
      properties: {
        gate_id: {
          type: 'string',
          description: 'The external_publish Gate id this publish task is linked to. ' +
            'Omit to resolve via work_item instead — one of gate_id/work_item is required.',
        },
        work_item: {
          type: 'string',
          description: 'Story/task id this publish belongs to. Required if gate_id is ' +
            'omitted (resolves the latest external_publish gate for it); also used for ' +
            'evidence/logging when gate_id is given.',
        },
        work_item_type: {
          type: 'string',
          description: 'Type of work_item for gate resolution — defaults to "story".',
        },
        create: {
          type: 'object',
          description: 'Stibee POST /v2/emails body.',
          properties: {
            listId: { type: 'number' },
            senderEmail: { type: 'string' },
            senderName: { type: 'string' },
            subject: { type: 'string' },
            groupIds: { type: 'array', items: { type: 'number' } },
            segmentIds: { type: 'array', items: { type: 'number' } },
          },
          required: ['listId', 'senderEmail', 'senderName', 'subject'],
        },
        html: {
          type: 'string',
          description: 'Email body HTML — sent verbatim to POST /v2/emails/{id}/content.',
        },
        update: {
          type: 'object',
          description: 'Optional Stibee PUT /v2/emails/{id} body (metadata overrides).',
        },
      },
      required: ['create', 'html'],
      additionalProperties: false,
    },
  },
  {
    // story #3399(2026-09-04, 페드루 PO 확定) — 여기 있던 `publish_threads_post`(에이전트
    // 직접 발행)는 삭제했다. 먼저 story #3366(PR#39)이 동결했고(코드 유지, 실행만 차단),
    // 이 스토리가 그 동결 위에서 실제 삭제까지 마무리했다(PR 본문에 #3366 링크) — 동결을
    // 되돌리는 게 아니라 그 위에서 완결하는 것. 대체 경로는 아래 create_channel_post_draft·
    // submit_channel_post_draft(서버 #3374 초안·상신 API) — 발행 자체는 서버가
    // human-only(f8f7cb0f)라 플러그인엔 절대 없다.
    //
    // story #3399 AC2 — 채널 포스트 초안 생성/수정. connectors/channel-posts.ts::
    // createOrUpdateChannelPostDraft가 POST /organizations/{org}/channel-posts/drafts(#3374)를
    // 부른다. 같은 (work_item, connection_id)로 다시 호출하면 새 버전이 생긴다(수정) —
    // draft_id를 몰라도 되는 이유. channel은 요청에 없다 — connection_id에서 서버가
    // derive한다(클라이언트가 실제와 다른 channel을 주장할 표면 자체가 없음, #3374 PO
    // 정정). text 길이 제한은 채널마다 다르므로(서버가 CHANNEL_TEXT_TOO_LONG으로 max_length/
    // current_length를 실어 알려준다) 이 스키마는 maxLength를 하드코딩하지 않는다.
    name: 'create_channel_post_draft',
    description:
      'Create or update a channel post draft (works for any channel with an active connection — ' +
      'call list_channel_connections first to find connection_id). Calling this again with the same ' +
      'work_item and connection_id adds a new version to the same draft; it never publishes. Returns ' +
      'draft_id/version_id/version/tagged_link_preview. Submit the version with ' +
      'submit_channel_post_draft to send it to the external_publish gate — only a human can approve ' +
      'and publish it from the Sprintable screen after that (story #3399, server API #3374).',
    inputSchema: {
      type: 'object',
      properties: {
        work_item: { type: 'string', description: 'Story/task id this draft belongs to.' },
        connection_id: {
          type: 'string',
          description: 'Target channel connection id — call list_channel_connections first to discover it.',
        },
        text: { type: 'string' },
        link_url: {
          type: 'string',
          description: 'Optional link to append — when set, the response includes a tagged_link_preview.',
        },
      },
      required: ['work_item', 'connection_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    // story #3399 AC3 — 초안 버전을 external_publish 게이트에 상신. connectors/
    // channel-posts.ts::submitChannelPostDraft가 POST .../channel-posts/drafts/{id}/submit
    // (#3374)를 부른다. 서버 실측(2026-09-03): 에이전트 키도 이 호출 가능(승인·발행만
    // human-only, 상신 자체는 actor_type 가드 없음).
    name: 'submit_channel_post_draft',
    description:
      'Submit a channel post draft version to the external_publish gate for approval. Defaults to ' +
      'the latest version if version_id is omitted. This does not publish — only a human can approve ' +
      'and publish it from the Sprintable screen (story #3399, server API #3374). After a human ' +
      'approves: if this was scheduled, a worker publishes it at that time and you can call ' +
      'get_channel_post_publication to check progress; if it was not scheduled (immediate), a ' +
      'human still has to click Publish separately on the Sprintable screen (no tool for that) — ' +
      'get_channel_post_publication showing no command yet is expected in that case, not a stall.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string' },
        version_id: {
          type: 'string',
          description: 'Optional — defaults to the latest version of the draft.',
        },
      },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
  {
    // story #3399 AC8/AC9 — connectors/channel-posts.ts::listAgentVisibleChannelConnections가
    // GET .../channel-connections/agent-visible(#3758, 신규 서버 엔드포인트)를 부른다. 기존
    // GET .../channel-connections(전체 필드)는 human-only라 에이전트가 connection_id를 알
    // 방법이 그동안 전혀 없었다 — 이 도구가 그 갭을 닫는다. 응답은 최소 필드(id·channel·
    // account_label·status)뿐 — 토큰·token_expires_at 등은 절대 안 실린다(#3758 field-
    // minimization pin).
    name: 'list_channel_connections',
    description:
      'List this organization\'s channel connections with minimal fields (id, channel, account_label, ' +
      'status). Use the returned id as connection_id for create_channel_post_draft. Token and other ' +
      'sensitive fields are never included (story #3399).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    // story a98dfbea([M4·마케팅자동화] Instagram Graph API 커넥터, 두 번째 A 경로 채널)
    // — threads.ts와 동형 chokepoint(story 6f2034cf "공통 계약" — ①함수 진입 직후
    // ②publish 직전 재확認). gate_id는 external_publish 게이트가 이 발행 task에 이미
    // 묶여 있어야 함 — 이 도구를 호출하는 것 자체는 승인의 증거가 아니다.
    // ⚠️INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_USER_ID 미설정이면 즉시 에러. Instagram은 순수
    // 텍스트 게시를 지원하지 않아 image_url이 필수(caption은 선택).
    // story #3312 AC5 동형: gate_id가 없으면 work_item(+work_item_type)으로 최신
    // external_publish 게이트를 조회한다. work_item은 gate_id가 있을 때도 항상 필수
    // (evidence/logging).
    // story #3317: `image_url`/`caption`은 INSTAGRAM_CONNECTOR_DESCRIPTOR(connectors/
    // instagram.schema.ts)에서 기계적으로 파생 — 손으로 따로 안 쓴다.
    name: 'publish_instagram_post',
    description:
      '⚠️FROZEN (story #3366): calling this immediately throws EXTERNAL_PUBLISH_MOVED_TO_PLATFORM ' +
      'before any credential/gate lookup or HTTP request — submit the draft and publish from the ' +
      'Sprintable screen instead. Kept only for discoverability; not executable. ' +
      'Publish an image post to Instagram (create media container → publish), gated on an ' +
      'approved external_publish Gate. Pass gate_id explicitly, or omit it to resolve the ' +
      'latest external_publish gate for work_item instead. The publish call is blocked unless ' +
      'the resolved gate reports status approved or auto_passed — calling this tool does not ' +
      'itself authorize the publish. Instagram does not support text-only posts — image_url is ' +
      'required.',
    inputSchema: {
      type: 'object',
      properties: {
        gate_id: {
          type: 'string',
          description: 'The external_publish Gate id this publish task is linked to. ' +
            'Omit to resolve via work_item instead.',
        },
        ...instagramContentSchema.properties,
        work_item: {
          type: 'string',
          description: 'Story/task id this publish belongs to — always required (evidence/' +
            'logging); also the gate-resolution key when gate_id is omitted.',
        },
        work_item_type: {
          type: 'string',
          description: 'Type of work_item for gate resolution — defaults to "story".',
        },
      },
      required: [...instagramContentSchema.required, 'work_item'],
      additionalProperties: false,
    },
  },
  {
    // story a32c9f1a([마케팅자동화·발행 채널] 자사 사이트 git 커넥터) — threads.ts/
    // instagram.ts와 동형 chokepoint(story 6f2034cf "공통 계약" — ①함수 진입 직후
    // ②커밋 PUT 직전 재확認). gate_id는 external_publish 게이트가 이 발행 task에 이미
    // 묶여 있어야 함 — 이 도구를 호출하는 것 자체는 승인의 증거가 아니다.
    // ⚠️SITE_GIT_GITHUB_TOKEN 미설정이면 즉시 에러. repo/branch/path_template/site_base_url은
    // org_config 필드(SITE_GIT_CONNECTOR_DESCRIPTOR)지만 stibee.ts의 create.senderEmail·
    // create.listId 등과 동형 관례로 이 도구가 직접 받는다 — 서버가 등록 시점 org_config를
    // 자동 주입하지 않는다(publish_stibee_campaign이 이미 그 관례, 새 주입 경로 발명 0).
    // 값 자체는 시크릿이 아니므로(그래서 org_config로 선언했지 requiresEnv가 아니다)
    // 호출부가 그대로 넘겨도 무해하다.
    // story #3312 AC5 동형: gate_id가 없으면 work_item(+work_item_type)으로 최신
    // external_publish 게이트를 조회한다. work_item은 gate_id가 있을 때도 항상 필수
    // (evidence/logging).
    // story #3317: title/body/slug/lang/summary/tags는 SITE_GIT_CONNECTOR_DESCRIPTOR
    // (connectors/site_git.schema.ts)에서 기계적으로 파생 — 손으로 따로 안 쓴다.
    name: 'publish_site_post',
    description:
      '⚠️FROZEN (story #3366): calling this immediately throws EXTERNAL_PUBLISH_MOVED_TO_PLATFORM ' +
      'before any credential/gate lookup or HTTP request — submit the draft and publish from the ' +
      'Sprintable screen instead. Kept only for discoverability; not executable. ' +
      'Commit an approved blog post as a markdown file to the organization\'s configured ' +
      'static-site git repo (GitHub Contents API), gated on an approved external_publish Gate. ' +
      'Pass gate_id explicitly, or omit it to resolve the latest external_publish gate for ' +
      'work_item instead. The commit is blocked unless the resolved gate reports status ' +
      'approved or auto_passed — calling this tool does not itself authorize the publish. ' +
      'Returns the commit sha and the expected published URL.',
    inputSchema: {
      type: 'object',
      properties: {
        gate_id: {
          type: 'string',
          description: 'The external_publish Gate id this publish task is linked to. ' +
            'Omit to resolve via work_item instead.',
        },
        ...siteGitContentSchema.properties,
        repo: { type: 'string', description: 'Target static-site GitHub repo, "owner/name" — from org_config.' },
        branch: { type: 'string', description: 'Target branch to commit to — from org_config.' },
        path_template: {
          type: 'string',
          description: 'File path template with {lang}/{slug} placeholders, e.g. "content/blog/{lang}/{slug}.md" — from org_config.',
        },
        site_base_url: { type: 'string', description: 'Public site base URL for computing the published post URL — from org_config.' },
        work_item: {
          type: 'string',
          description: 'Story/task id this publish belongs to — always required (evidence/' +
            'logging); also the gate-resolution key when gate_id is omitted.',
        },
        work_item_type: {
          type: 'string',
          description: 'Type of work_item for gate resolution — defaults to "story".',
        },
      },
      required: [...siteGitContentSchema.required, 'repo', 'branch', 'path_template', 'site_base_url', 'work_item'],
      additionalProperties: false,
    },
  },
  {
    // story #3317 — 조회 전용(부작용 0). content_package 계약(connector-schema.ts
    // toWireDescriptor 형상)을 그대로 반환 — 백엔드가 조직 커넥터 레지스트리 등록에
    // 소비할 계약(AC2, 등록 엔드포인트 자체는 별도 스토리). apply-time 검사가 "필수
    // org_config 필드가 조직 설정에 있는가"를 판단할 출처.
    name: 'describe_connector',
    description:
      'Return the content_package schema for a publish connector (threads or stibee) — ' +
      'which fields are work-item content vs. organization config, which are required, ' +
      'and where org_config values get set up. Read-only, no side effects.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          enum: ['threads', 'stibee', 'instagram', 'site_git'],
          description: 'Which connector to describe.',
        },
      },
      required: ['connector'],
      additionalProperties: false,
    },
  },
  {
    // story #3321([M5·마케팅자동화] measure 단계 도구) — insights 조회+evidence 기록을
    // 한 호출로 묶는다(connectors/threads.ts::getThreadsInsightsAndRecordEvidence,
    // 새 로직 발명 0). 이 도구는 성공/실패 "판단"을 하지 않는다 — 응답에 verdict류
    // 필드가 없고, 목표값 판정은 work item의 success_hypothesis가 조직 몫으로 갖는다
    // (PO 못박음②). evidence 기록이 실패해도 지표는 그대로 반환되고
    // evidence_recorded:false + evidence_error로 명시된다(PO 못박음① — 조용한 성공
    // 금지).
    name: 'get_threads_insights',
    description:
      'Fetch Threads post insights (views/likes/replies/reposts/quotes) and record them as ' +
      'Sprintable evidence in one call. Metric names are Threads platform facts; this tool ' +
      'makes no success/failure judgment — target values belong to the work item\'s ' +
      'success_hypothesis. If evidence recording fails, the metrics are still returned with ' +
      'evidence_recorded:false and evidence_error set — never a silent success.',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: {
          type: 'string',
          description: 'Threads post (media) id — the platform publishes it from an approved draft (story #3399); get the id from the Sprintable screen or the publication record.',
        },
        work_item: {
          type: 'string',
          description: 'Story/task id this measurement belongs to — required (evidence attribution).',
        },
        work_item_type: {
          type: 'string',
          description: 'Type of work_item for evidence attribution — defaults to "story".',
        },
      },
      required: ['post_id', 'work_item'],
      additionalProperties: false,
    },
  },
  {
    // story #3317 — 플러그인 마지막 조각. 설정 스킬(/sprintable:configure-threads·
    // -stibee) 실행 끝에 이 도구를 불러 describe_connector와 동일한 정본을 조직
    // 커넥터 레지스트리에 등록한다(connectors/registry.ts::registerConnectorSchema).
    // org 멤버 아무나 호출 가능(owner/admin 불필요 — 설정 스킬을 돌리는 게 에이전트
    // 자신이라 owner/admin 전용이면 첫 호출에서 죽는다, 페드루 리뷰①). 멱등 upsert라
    // 여러 번 불러도 안전. 시크릿은 이 호출에 절대 안 실린다 — 정본에 requiresEnv
    // "이름"만 있을 뿐 값은 이 플러그인 밖으로 안 나간다.
    name: 'register_connector_schema',
    description:
      'Register this connector\'s content_package schema (same shape as describe_connector) ' +
      'with the organization\'s connector registry, so the backend can validate recipe ' +
      'apply-time readiness and resolve org_config values at publish time. Idempotent upsert ' +
      '— safe to call every time the configure skill runs. No secrets are ever sent.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          enum: ['threads', 'stibee', 'instagram', 'site_git'],
          description: 'Which connector to register.',
        },
      },
      required: ['connector'],
      additionalProperties: false,
    },
  },
  {
    // story #3317 — org_config 값 설정(발신자 이메일·리스트 ID 등, 비밀 아닌 조직 설정값
    // 만). **owner/admin 전용** — 이 도구를 에이전트가 부르면 403이 정상 케이스다(페드루
    // 리뷰②): 그 경우 도구가 명시 에러로 "조직 설정 화면 또는 관리자에게" 안내를 반환한다
    // (ConnectorConfigForbiddenError). config에 requiresEnv 이름과 겹치는 키가 있으면
    // 네트워크 호출 전에 클라이언트 쪽에서 즉시 거부(서버도 별도로 422 거부 — 이중 방어,
    // "플러그인을 믿지 않는다"는 서버 설계 그대로).
    name: 'set_connector_config',
    description:
      'Set organization-config values for a connector (e.g. sender email, list id) — never ' +
      'secrets. Requires org owner/admin; a non-owner/admin agent gets an explicit error ' +
      'pointing to the org settings screen or an admin, not a silent failure. The connector ' +
      'must already be registered via register_connector_schema.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          enum: ['threads', 'stibee', 'instagram', 'site_git'],
          description: 'Which connector to configure.',
        },
        config: {
          type: 'object',
          description: 'org_config field name → value pairs, as declared by describe_connector ' +
            '(e.g. {"create.senderEmail": "hello@example.com"}). Never include a requires_env name here.',
        },
      },
      required: ['connector', 'config'],
      additionalProperties: false,
    },
  },
  {
    // story #3489([Phase1·플러그인] 고객 에이전트용 발행 도구 셋, 페드루 PO 確定
    // 2026-09-05, 미르코 그라운딩 ③) — create_channel_post_draft/submit_channel_post_
    // draft(story #3399)는 이미 있지만 발행 "결과"(permalink·status·failure_kind)를
    // 읽는 도구가 0개였다. connectors/channel-posts.ts::getChannelPostPublication이
    // GET .../channel-posts/drafts/{draft_id}(#3403, "권한도 목록과 동일 — 휴먼·
    // 에이전트 둘 다")를 그대로 미러한다.
    name: 'get_channel_post_publication',
    description:
      'Read the publish result for a channel post draft — publication status, permalink, ' +
      'external_id, and command failure/retry info if the publish is pending, failed, or ' +
      'dead-lettered. Read-only, works with an agent API key alone. Returns the backend ' +
      'response shape as-is (field names unchanged from the REST API). A null/absent command ' +
      'right after human approval is expected for an immediate (unscheduled) post — a human still ' +
      'has to click Publish separately, this tool does not trigger it. Once a command exists: ' +
      'pending/in_progress/failed = no action, the worker retries automatically; dead_letter = ' +
      'report it to a human with the command_id, retrying it is a human action (see the ' +
      'publish-content skill for the full flow).',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The draft_id returned by create_channel_post_draft.' },
      },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
  {
    // story #3489 — site_posts(블로그 원문) 축 신설, 첫째. connectors/site-posts.ts::
    // createOrUpdateSitePostDraft가 POST .../site-posts/drafts(#3365, "고객 에이전트·
    // 휴먼 공용")를 부른다. 공개 발행(POST .../site-posts)은 human-only라 이 도구에
    // 없다 — 에이전트는 초안까지만.
    name: 'create_site_post_draft',
    description:
      'Create or update a blog post (site_post) draft. Calling this again with the same ' +
      'work_item adds a new version to the same draft; it never publishes. Returns draft_id/' +
      'version_id/version and any non-blocking content-rule violations from create-time lint. ' +
      'Submit the version with submit_site_post_draft to send it to the external_publish gate ' +
      '— only a human can approve and publish it from the Sprintable screen after that.',
    inputSchema: {
      type: 'object',
      properties: {
        work_item: { type: 'string', description: 'Story/task id this draft belongs to.' },
        title: { type: 'string' },
        slug: { type: 'string' },
        lang: { type: 'string', description: 'e.g. "ko".' },
        summary: { type: 'string' },
        body_md: { type: 'string', description: 'Markdown body.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional, defaults to [].' },
        media_manifest: { type: 'array', description: 'Optional, defaults to [].' },
        campaign_id: { type: 'string', description: 'Optional campaign to attach this post to.' },
        connection_id: {
          type: 'string',
          description: 'Optional external publish destination (a channel_connections row, e.g. ' +
            'a WordPress connection). Omit to keep the current destination unchanged; pass an ' +
            'empty string to explicitly reset to the default hosted_site destination.',
        },
      },
      required: ['work_item', 'title', 'slug', 'lang', 'summary', 'body_md'],
      additionalProperties: false,
    },
  },
  {
    // story #3489 — site_posts 축 둘째. connectors/site-posts.ts::submitSitePostDraft
    // → POST .../site-posts/drafts/{id}/submit(#3365 S2, "에이전트 키도 호출 가능 —
    // 게이트 생성까지만").
    name: 'submit_site_post_draft',
    description:
      'Submit a site post (blog article) draft version to the external_publish approval Gate. ' +
      'Defaults to the latest version if version_id is omitted. This does not publish — only a ' +
      'human can approve and publish it from the Sprintable screen. On failure (content-rule ' +
      'violation, another draft already holding the Gate for this slug/lang, etc.) the response ' +
      'is a structured error object (code, message, and detail such as violations[] or ' +
      'holding_draft_id) rather than a generic failure. After a human approves, call ' +
      'get_site_post_publication to read the result — do not publish it yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string' },
        version_id: { type: 'string', description: 'Optional — defaults to the latest version of the draft.' },
      },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
  {
    // story #3489 — site_posts 축 셋째. connectors/site-posts.ts::getSitePostPublication
    // → GET .../site-posts/drafts/{id}/publication(#3386/#3476, "조직 멤버(휴먼·
    // 에이전트 모두) 읽기 가능").
    name: 'get_site_post_publication',
    description:
      'Read the publish result for a site post (blog article) draft — hosted_site publish info, ' +
      'or (if an external destination like WordPress/webhook was set) the channel publication ' +
      'status/permalink and command failure/retry info. Read-only, works with an agent API key ' +
      'alone. Returns the backend response shape as-is. command_status pending/in_progress/' +
      'failed = no action, the worker retries automatically; command_status dead_letter = report ' +
      'it to a human with the command_id, retrying it is a human action (see the publish-content ' +
      'skill for the full flow).',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string' },
      },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
]
