/**
 * MCP 도구 목록 정의 — story #3317 PR#30 후속 채팅(PO 확定)에서 server.ts의
 * ListToolsRequestSchema 핸들러 안에 인라인이던 `tools: [...]`를 순수(부작용 0) 모듈로
 * 뽑았다. server.ts는 `await mcp.connect(...)`·SSE dial-out을 모듈 로드 시점에 실행하므로
 * 그 파일을 테스트에서 직접 import하면 실제 stdio 서버/네트워크 연결이 시도된다 — 이
 * 파일은 그 부작용이 전혀 없어 `tool-definitions.test.ts`가 안전하게 import해 드리프트를
 * 직접 pin할 수 있다(사본 비교가 아니라 실제 이 배열을 대조 — server.ts도 동일 배열을
 * 그대로 쓴다).
 *
 * publish_threads_post의 `text` 프로퍼티는 THREADS_CONNECTOR_DESCRIPTOR(connectors/
 * threads.schema.ts)에서 `contentPropertiesToJsonSchema()`로 기계적으로 파생된다 — 손으로
 * 따로 안 쓴다(드리프트 원천 차단). publish_stibee_campaign의 `create.*`/`html`은 중첩
 * 객체라 이 파생 대상이 아니고 손으로 유지하되, tool-definitions.test.ts가
 * STIBEE_CONNECTOR_DESCRIPTOR의 content 필드가 실제로 여기 존재하는지 대조한다.
 */
import { THREADS_CONNECTOR_DESCRIPTOR } from './connectors/threads.schema'
import { STIBEE_CONNECTOR_DESCRIPTOR } from './connectors/stibee.schema'
import { contentPropertiesToJsonSchema } from './connectors/connector-schema'

const threadsContentSchema = contentPropertiesToJsonSchema(THREADS_CONNECTOR_DESCRIPTOR)

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
    // story #3311([M1·마케팅자동화] Threads 발행 커넥터) — doc
    // threads-publish-channel-onboarding, story #3292(스티비)와 동형 chokepoint.
    // gate_id는 external_publish 게이트가 이 발행 task에 이미 묶여 있어야 함 — 이
    // 도구를 호출하는 것 자체는 승인의 증거가 아니다: 내부에서 GET
    // /api/v2/gates/{gate_id}로 gate.status를 재확인하고, approved/auto_passed가
    // 아니면 실제 게시(POST .../threads_publish)를 절대 호출하지 않는다
    // (defense-in-depth). ⚠️THREADS_ACCESS_TOKEN/THREADS_USER_ID 미설정이면 즉시 에러
    // (/sprintable:configure-threads 안내). ⚠️조직 상수 0 — 어느 조직이든 자기
    // 토큰·계정으로 그대로 돈다(story #3311 «제품 경계»).
    // story #3312 AC5: gate_id가 없으면 work_item(+work_item_type)으로 「이 work item의
    // 최신 external_publish 게이트」를 조회해 동일 판정을 한다(stibee와 동형 경로).
    // work_item은 gate_id가 있을 때도 항상 필수 — evidence/logging에 쓰는 원래 목적은
    // 그대로 유지.
    // story #3317: `text`는 THREADS_CONNECTOR_DESCRIPTOR(connectors/threads.schema.ts)에서
    // 기계적으로 파생 — 아래 스프레드가 정본, 손으로 따로 안 쓴다.
    name: 'publish_threads_post',
    description:
      'Publish a text post to Threads (create container → publish), gated on an approved ' +
      'external_publish Gate. Pass gate_id explicitly, or omit it to resolve the latest ' +
      'external_publish gate for work_item instead. The publish call is blocked unless the ' +
      'resolved gate reports status approved or auto_passed — calling this tool does not ' +
      'itself authorize the publish. Text is capped at 500 characters and the 250-post/24h ' +
      'Threads limit is checked before posting.',
    inputSchema: {
      type: 'object',
      properties: {
        gate_id: {
          type: 'string',
          description: 'The external_publish Gate id this publish task is linked to. ' +
            'Omit to resolve via work_item instead.',
        },
        ...threadsContentSchema.properties,
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
      required: [...threadsContentSchema.required, 'work_item'],
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
          enum: ['threads', 'stibee'],
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
          description: 'Threads post (media) id — the id publish_threads_post returned.',
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
]
