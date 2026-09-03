#!/usr/bin/env bun
/**
 * E-INJECT-ADAPTERS:Phase0 — CC 주입 어댑터 (SSE dial-out).
 *
 * Sprintable Agent Gateway /api/v2/agent/stream (SSE) 소비 → deliver() →
 * notifications/claude/channel emit (모델 가시). hermes adapter 동형.
 *
 * 수신: SSE /api/v2/agent/stream → deliver() → mcp.notification (channel)
 * 송신: reply 도구 → POST /api/v2/conversations/{id}/messages
 * ack:  주입 후 POST /api/v2/agent/events/ack {seq} — backfill flood 방지
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { isInjectableEventType } from './inject-allowlist'
import { formatEnvelopeText } from './envelope'
import { currentConversationFilename } from './conversation-routing'
import pluginManifest from './.claude-plugin/plugin.json'
import { pruneInboundMeta, resolveReplyTarget, type InboundMeta } from './reply-target'
import { sanitizeAttachments, attachmentPlaceholderText, type AttachmentMeta } from './attachment-meta'
import { buildChannelNotificationMeta } from './channel-notification-meta'
import {
  publishStibeeCampaign,
  type CreateEmailRequest,
  type UpdateEmailRequest,
} from './connectors/stibee'
import { publishThreadsPost, getThreadsInsightsAndRecordEvidence } from './connectors/threads'
import { publishInstagramPost } from './connectors/instagram'
// story 4213f6c4 — 두 파일이 같은 이름(publishSitePost)을 export한다(site_git.ts=레거시
// GitHub 커밋, site.ts=신규 Sprintable API 직접 발행) — alias로 충돌 회피.
import { publishSitePost as publishSitePostGit } from './connectors/site_git'
import { publishSitePost } from './connectors/site'
import { GateNotApprovedError, NoGateFoundError } from './connectors/gate-check'
import { toWireDescriptor, type ConnectorDescriptor } from './connectors/connector-schema'
import { THREADS_CONNECTOR_DESCRIPTOR } from './connectors/threads.schema'
import { STIBEE_CONNECTOR_DESCRIPTOR } from './connectors/stibee.schema'
import { INSTAGRAM_CONNECTOR_DESCRIPTOR } from './connectors/instagram.schema'
import { SITE_GIT_CONNECTOR_DESCRIPTOR } from './connectors/site_git.schema'
import { SITE_CONNECTOR_DESCRIPTOR } from './connectors/site.schema'
import { registerConnectorSchema, updateConnectorConfig, ConnectorConfigForbiddenError } from './connectors/registry'

function resolveConnectorDescriptor(key: string): ConnectorDescriptor | undefined {
  if (key === 'threads') return THREADS_CONNECTOR_DESCRIPTOR
  if (key === 'stibee') return STIBEE_CONNECTOR_DESCRIPTOR
  if (key === 'instagram') return INSTAGRAM_CONNECTOR_DESCRIPTOR
  if (key === 'site_git') return SITE_GIT_CONNECTOR_DESCRIPTOR
  if (key === 'site') return SITE_CONNECTOR_DESCRIPTOR
  return undefined
}
import { TOOL_DEFINITIONS } from './tool-definitions'
import { readFileSync, chmodSync, appendFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

// Load the agent credentials into process.env (real env wins).
// Plugin-spawned servers get no env block — this is where the API key lives when
// set via /sprintable:configure. Launcher env injection still works as a fallback.
//
// ── Multi-agent isolation ────────────────────────────────────────────────────
// A single homedir path (~/.claude/channels/sprintable/.env) is shared by every
// Claude Code session on the machine, so onboarding two agents on one machine via
// /sprintable:configure makes the last key overwrite the others. Claude Code does
// NOT expose a session identifier symmetrically to skill and server — CLAUDE_PROJECT_DIR
// reaches THIS server process but NOT the configure skill's Bash — so fully-automatic
// per-agent isolation is not achievable at the plugin layer. The supported isolation
// is an explicit override (SPRINTABLE_STATE_DIR per launch), the same mechanism the
// fleet already uses. Read the credential from the first candidate that actually has
// a .env, so existing homedir installs keep working (no regression):
//   1) SPRINTABLE_STATE_DIR           explicit override — AUTHORITATIVE, no fallback
//   2) $CLAUDE_PROJECT_DIR/.sprintable project-local (server sees CLAUDE_PROJECT_DIR)
//   3) ~/.claude/channels/sprintable  legacy homedir path
//
// SPRINTABLE_STATE_DIR is a deliberate isolation signal, so it is authoritative: if it
// is set we read ONLY that path. If its .env does not exist yet (e.g. an agent launched
// with the override but not yet /sprintable:configure'd), we leave credentials UNSET
// rather than falling back to homedir — otherwise the isolated agent would read some
// OTHER agent's key from the shared homedir on first boot (the exact cross-agent mixup
// this fix exists to stop). Only the AUTOMATIC candidates (project-local, homedir) fall
// through to "first candidate whose .env actually exists", keeping existing installs working.
let ENV_FILE: string
if (process.env.SPRINTABLE_STATE_DIR) {
  ENV_FILE = join(process.env.SPRINTABLE_STATE_DIR, '.env')
} else {
  const AUTO_DIRS = [
    process.env.CLAUDE_PROJECT_DIR ? join(process.env.CLAUDE_PROJECT_DIR, '.sprintable') : undefined,
    join(homedir(), '.claude', 'channels', 'sprintable'),
  ].filter((d): d is string => Boolean(d))
  ENV_FILE = join(AUTO_DIRS[AUTO_DIRS.length - 1], '.env') // default: homedir
  for (const dir of AUTO_DIRS) {
    const candidate = join(dir, '.env')
    try {
      readFileSync(candidate, 'utf8') // exists?
      ENV_FILE = candidate
      break
    } catch {}
  }
}
try {
  chmodSync(ENV_FILE, 0o600) // credential — lock to owner
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// ── HITL① (#2570): permission 승인을 Sprintable 챗으로 ────────────────────────
// STATE_DIR = ENV_FILE의 부모 디렉터리 — 이미 격리 결정된 그 자리를 그대로 재사용해
// events.jsonl(감사 로그, AC3)과 current_conversation.json(Path B 훅 프로세스가 이
// MCP 서버와 같은 "지금 대화 중인 conv"를 읽을 수 있게 — 서로 다른 프로세스라 in-memory
// 공유 불가, 파일로 넘긴다)을 둔다.
const STATE_DIR = dirname(ENV_FILE)
function logEvent(kind: string, fields: Record<string, unknown> = {}): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(
      join(STATE_DIR, 'events.jsonl'),
      JSON.stringify({ ts: Date.now() / 1000, kind, ...fields }) + '\n',
    )
  } catch {}
}
function persistCurrentConversation(conversationId: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    // #2589: 파일명 자체를 CLAUDE_PROJECT_DIR로 분리 — STATE_DIR이 여러 워커에서
    // 같은(공유 homedir 기본값) 경로로 떨어져도 이 파일만은 워커별로 갈린다.
    writeFileSync(
      join(STATE_DIR, currentConversationFilename()),
      JSON.stringify({ conversation_id: conversationId, updated_at: Date.now() / 1000 }),
    )
  } catch {}
}
// AC4: 기본 OFF. --permission-prompt-tool은 사용자가 claude 실행 시 명시적으로 지정해야만
// approval_prompt 툴이 호출되므로(안 지정하면 이 툴은 존재만 하고 절대 안 불림) 이 자체가
// opt-in이다 — Path A는 별도 게이트 불필요. Path B(훅)는 hooks.json이 매 세션 자동 로드되므로
// 훅 스크립트 자신이 이 값을 확認해야(별도 hitl_approval_hook.ts 참조).
const HITL_HOME_CHANNEL = process.env.SPRINTABLE_HITL_HOME_CHANNEL ?? ''
const HITL_APPROVERS = (process.env.SPRINTABLE_HITL_APPROVERS ?? '')
  .split(',').map((s: string) => s.trim()).filter(Boolean) // 빈 배열 = 전체 human 허용
const HITL_TIMEOUT_MS = Number(process.env.SPRINTABLE_HITL_TIMEOUT_MS) || 600_000 // AC2: 600s 상한(기본)

type PendingApproval = {
  resolve: (decision: { behavior: 'allow' | 'deny'; message?: string }) => void
  toolName: string
}
const pendingApprovals = new Map<string, PendingApproval>() // key: conversationId

const API_URL = (
  process.env.SPRINTABLE_API_URL ?? 'https://app.sprintable.ai'
).replace(/\/$/, '')
// AGENT_API_KEY fallback for compatibility with existing .mcp.json configs.
// 04791bd9: 키 주입은 launch env(config/launch)가 담당 — plugin 프로세스↔workspace .mcp.json
// path 링크 부재로 코드 path-fallback(#1708 readMcpJsonEnv)은 futile이라 revert(process.env-only).
const API_KEY = (process.env.SPRINTABLE_API_KEY ?? process.env.AGENT_API_KEY ?? '').trim()
// 선생님 설계: webhook 구성된 에이전트는 fakechat SSE off(이중 주입 방지·discord가 처리).
// HAS_WEBHOOK="true"(launch env) → SSE 안 엶. webhook 없으면(오스카 등) on. harmless safety.
const HAS_WEBHOOK = (process.env.HAS_WEBHOOK ?? '').toLowerCase() === 'true'

// story #2622(2026-08-14): reply()가 명시 chat_id로 정확한 대화를 지목할 수 있게 — 이전엔
// 이 Map이 채워지기만 하고(write-only) reply 핸들러는 latestInboundMeta(전역 단일값,
// last-write-wins)만 읽어 교차 채널 오배송을 냈다(카디르 06:24~06:36 PO채널 의도 4건이
// 그 사이 도착한 선생님채널 이벤트에 밀려 선생님채널로 오배송된 실피해). key는 모델이
// <channel chat_id="..."> 태그에서 보는 바로 그 값(=conversationId/thread_id) — reply가
// "그 chat_id 그대로 돌려주면" 조회되게. 조회/청소 로직은 reply-target.ts(단위테스트 가능한
// 순수 함수 — 이 파일은 mcp.connect()를 모듈 스코프 부수효과로 실행해 직접 테스트 불가).
const inboundMeta = new Map<string, InboundMeta>()
let latestInboundMeta: InboundMeta | undefined

// ── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  // #2577: 프로토콜 레벨 serverInfo.name도 .mcp.json 키(sprintable-channel)와 맞춤 —
  // hosted 도구 MCP(sprintable-mcp)와 로그·핸드셰이크 레벨에서도 분간되게.
  // story #3c7968ee(2026-08-14, PO 지적): version은 예전에 '0.2.0' 리터럴로 박혀
  // plugin.json이 0.3.0→0.3.1→0.3.2로 범프되는 동안 계속 드리프트했다(핸드셰이크 로그가
  // 실 배포 버전과 다른 값을 말하는 관측성 함정). plugin.json을 SSOT로 import — 다음 범프부터
  // 다시 갈릴 일이 구조적으로 없다(리터럴 재동기화가 아니라 드리프트 원천 차단).
  { name: 'sprintable-channel', version: pluginManifest.version },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'Sprintable 게이트웨이 이벤트가 <channel source="sprintable"> 블록으로 도착한다. ' +
      '응답은 reply 도구를 사용하는.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }))

// HITL①(#2570): 승인요청 게시 + 챗 답 대기(최대 HITL_TIMEOUT_MS). 대상 conv 해석 —
// active_conversation(latestInboundMeta, PO 확定 설계) → 없으면 HOME_CHANNEL 폴백.
async function requestApproval(
  toolName: string,
  toolInput: unknown,
): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
  const conversationId = latestInboundMeta?.threadId || HITL_HOME_CHANNEL
  if (!conversationId) {
    logEvent('hitl_no_target', { tool_name: toolName })
    return { behavior: 'deny', message: '승인 요청 게시 대상 대화를 찾을 수 없음(안전 거부)' }
  }
  const replyUrl = `${API_URL}/api/v2/conversations/${conversationId}/messages`
  const inputSummary = JSON.stringify(toolInput).slice(0, 500)
  // #2572: FE가 이 텍스트를 content-sniffing해 웹 카드로 렌더한다(플러그인 변경 0 제약의
  // 귀결) — 이 포맷("🔒 승인 요청:" 헤더 · "allow"/"deny <사유>" 응답 규약)이 사실상 FE
  // 계약이 됐다. 바꾸려면 FE와 함께.
  const promptText =
    `🔒 승인 요청: \`${toolName}\`\n입력: ${inputSummary}\n\n` +
    `「allow」 또는 「deny <사유>」로 답해주세요 (${HITL_TIMEOUT_MS / 1000}초 내 무응답 시 자동 거부).`

  try {
    const resp = await fetch(replyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        'x-agent-api-key': API_KEY,
      },
      body: JSON.stringify({ content: promptText }),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  } catch (e) {
    logEvent('hitl_post_failed', { tool_name: toolName, conversation_id: conversationId, error: String(e) })
    return { behavior: 'deny', message: `승인 요청 게시 실패(안전 거부): ${e}` }
  }
  logEvent('hitl_requested', { tool_name: toolName, conversation_id: conversationId, input: inputSummary })

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(conversationId)
      logEvent('hitl_timeout', { tool_name: toolName, conversation_id: conversationId })
      // #2570 Ortega 지시: 타임아웃 message는 "거부"와 "무응답"을 모델이 구별할 수 있게
      // 명시적으로 다르게 쓴다(그냥 "거부됨"이면 모델이 진짜 사람 거부와 구별 못 함).
      resolve({ behavior: 'deny', message: '챗 승인 타임아웃(무응답) — 사람이 정해진 시간 내 응답하지 않았습니다.' })
    }, HITL_TIMEOUT_MS)
    pendingApprovals.set(conversationId, {
      toolName,
      resolve: decision => {
        clearTimeout(timer)
        pendingApprovals.delete(conversationId)
        logEvent(decision.behavior === 'allow' ? 'hitl_approved' : 'hitl_denied', {
          tool_name: toolName, conversation_id: conversationId, message: decision.message,
        })
        resolve(decision)
      },
    })
  })
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = args.text as string
        const chatId = args.chat_id as string | undefined
        const target = resolveReplyTarget(inboundMeta, latestInboundMeta, chatId)
        if (!target.ok) throw new Error(target.error)
        const meta = target.meta
        const resp = await fetch(meta.replyCallbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${meta.replyCallbackApiKey}`,
            'x-agent-api-key': meta.replyCallbackApiKey,
          },
          body: JSON.stringify({ content: text }),
        })
        if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text().catch(() => '')}`)
        return { content: [{ type: 'text', text: 'sent' }] }
      }
      case 'edit_message': {
        // no WS anymore — best-effort via REST if endpoint exists
        return { content: [{ type: 'text', text: 'ok (edit not supported in SSE mode)' }] }
      }
      case 'approval_prompt': {
        // Claude Code가 --permission-prompt-tool로 이 도구를 부를 때 기대하는 반환 계약은
        // {behavior:"allow"|"deny", updatedInput?, message?} — 실측 확認(#2570 spike,
        // 실 MCP 서버 왕복: allow+updatedInput→write 통과, deny+message→모델에 그대로 전달).
        const toolName = String(args.tool_name ?? '')
        const toolInput = args.input ?? {}
        const decision = await requestApproval(toolName, toolInput)
        const behaviorPayload =
          decision.behavior === 'allow'
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: decision.message ?? '거부됨' }
        return { content: [{ type: 'text', text: JSON.stringify(behaviorPayload) }] }
      }
      case 'publish_stibee_campaign': {
        const stibeeToken = (process.env.STIBEE_ACCESS_TOKEN ?? '').trim()
        if (!stibeeToken) {
          throw new Error(
            'STIBEE_ACCESS_TOKEN not configured — run /sprintable:configure-stibee <access-token> first',
          )
        }
        // story #3312 AC5: gate_id는 이제 선택 — 없으면 work_item(+work_item_type)으로
        // 최신 external_publish 게이트를 조회한다(gateId 명시가 항상 우선, 커넥터 쪽
        // publishStibeeCampaign의 우선순위 로직에 위임 — 여기서 분기 안 함).
        const gateId = args.gate_id ? String(args.gate_id) : undefined
        const workItem = args.work_item ? String(args.work_item) : undefined
        const workItemType = args.work_item_type ? String(args.work_item_type) : undefined
        if (!gateId && !workItem) throw new Error('either gate_id or work_item is required')
        const create = args.create as CreateEmailRequest
        const html = String(args.html ?? '')
        const update = args.update as UpdateEmailRequest | undefined
        try {
          const result = await publishStibeeCampaign({
            gateId,
            workItemId: workItem,
            workItemType,
            content: { create, html, update },
            sprintableApiUrl: API_URL,
            sprintableApiKey: API_KEY,
            stibee: { accessToken: stibeeToken },
          })
          logEvent('stibee_publish_sent', { gate_id: gateId, work_item: workItem, email_id: result.emailId })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          if (err instanceof GateNotApprovedError) {
            logEvent('stibee_publish_blocked', { gate_id: gateId, work_item: workItem, gate_status: err.gateStatus })
          } else if (err instanceof NoGateFoundError) {
            logEvent('stibee_publish_no_gate', { work_item: workItem })
          }
          throw err
        }
      }
      case 'publish_threads_post': {
        const threadsToken = (process.env.THREADS_ACCESS_TOKEN ?? '').trim()
        const threadsUserId = (process.env.THREADS_USER_ID ?? '').trim()
        if (!threadsToken || !threadsUserId) {
          throw new Error(
            'THREADS_ACCESS_TOKEN/THREADS_USER_ID not configured — run ' +
              '/sprintable:configure-threads <access-token> <user-id> [app-secret] first',
          )
        }
        // story #3312 AC5: gate_id 선택, 없으면 work_item으로 조회(work_item 자체는 로깅
        // 목적으로 항상 필수 — 스키마 required, gateId 명시 여부와 무관).
        const gateId = args.gate_id ? String(args.gate_id) : undefined
        const text = String(args.text ?? '')
        const workItem = String(args.work_item ?? '')
        if (!workItem) throw new Error('work_item is required')
        const workItemType = args.work_item_type ? String(args.work_item_type) : undefined
        try {
          const result = await publishThreadsPost({
            gateId,
            workItemId: workItem,
            workItemType,
            text,
            sprintableApiUrl: API_URL,
            sprintableApiKey: API_KEY,
            threads: { accessToken: threadsToken, userId: threadsUserId },
          })
          logEvent('threads_publish_sent', { gate_id: gateId, work_item: workItem, post_id: result.postId })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          if (err instanceof GateNotApprovedError) {
            logEvent('threads_publish_blocked', { gate_id: gateId, work_item: workItem, gate_status: err.gateStatus })
          } else if (err instanceof NoGateFoundError) {
            logEvent('threads_publish_no_gate', { work_item: workItem })
          }
          throw err
        }
      }
      case 'publish_instagram_post': {
        const igToken = (process.env.INSTAGRAM_ACCESS_TOKEN ?? '').trim()
        const igUserId = (process.env.INSTAGRAM_USER_ID ?? '').trim()
        if (!igToken || !igUserId) {
          throw new Error(
            'INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_USER_ID not configured — set them in the plugin env first',
          )
        }
        // story #3312 AC5 동형: gate_id 선택, 없으면 work_item으로 조회(work_item 자체는
        // 로깅 목적으로 항상 필수 — 스키마 required, gateId 명시 여부와 무관).
        const gateId = args.gate_id ? String(args.gate_id) : undefined
        const imageUrl = String(args.imageUrl ?? '')
        const caption = args.caption ? String(args.caption) : undefined
        const workItem = String(args.work_item ?? '')
        if (!workItem) throw new Error('work_item is required')
        const workItemType = args.work_item_type ? String(args.work_item_type) : undefined
        try {
          const result = await publishInstagramPost({
            gateId,
            workItemId: workItem,
            workItemType,
            imageUrl,
            caption,
            sprintableApiUrl: API_URL,
            sprintableApiKey: API_KEY,
            instagram: { accessToken: igToken, igUserId },
          })
          logEvent('instagram_publish_sent', { gate_id: gateId, work_item: workItem, media_id: result.mediaId })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          if (err instanceof GateNotApprovedError) {
            logEvent('instagram_publish_blocked', { gate_id: gateId, work_item: workItem, gate_status: err.gateStatus })
          } else if (err instanceof NoGateFoundError) {
            logEvent('instagram_publish_no_gate', { work_item: workItem })
          }
          throw err
        }
      }
      case 'publish_site_post_git': {
        const githubToken = (process.env.SITE_GIT_GITHUB_TOKEN ?? '').trim()
        if (!githubToken) {
          throw new Error('SITE_GIT_GITHUB_TOKEN not configured — set it in the plugin env first')
        }
        // story #3312 AC5 동형: gate_id 선택, 없으면 work_item으로 조회(work_item 자체는
        // 로깅 목적으로 항상 필수 — 스키마 required, gateId 명시 여부와 무관).
        const gateId = args.gate_id ? String(args.gate_id) : undefined
        const workItem = String(args.work_item ?? '')
        if (!workItem) throw new Error('work_item is required')
        const workItemType = args.work_item_type ? String(args.work_item_type) : undefined
        const title = String(args.title ?? '')
        const body = String(args.body ?? '')
        const slug = String(args.slug ?? '')
        const lang = String(args.lang ?? '')
        const summary = args.summary ? String(args.summary) : undefined
        const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined
        const repo = String(args.repo ?? '')
        const branch = String(args.branch ?? '')
        const pathTemplate = String(args.path_template ?? '')
        const siteBaseUrl = String(args.site_base_url ?? '')
        try {
          const result = await publishSitePostGit({
            gateId,
            workItemId: workItem,
            workItemType,
            title,
            body,
            slug,
            lang,
            summary,
            tags,
            sprintableApiUrl: API_URL,
            sprintableApiKey: API_KEY,
            siteGit: { githubToken, repo, branch, pathTemplate, siteBaseUrl },
          })
          logEvent('site_post_git_publish_sent', { gate_id: gateId, work_item: workItem, commit_sha: result.commitSha, url: result.url })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          if (err instanceof GateNotApprovedError) {
            logEvent('site_post_git_publish_blocked', { gate_id: gateId, work_item: workItem, gate_status: err.gateStatus })
          } else if (err instanceof NoGateFoundError) {
            logEvent('site_post_git_publish_no_gate', { work_item: workItem })
          }
          throw err
        }
      }
      case 'publish_site_post': {
        // story 4213f6c4 — 기본 채널(Sprintable API 직접 발행, GitHub PAT 불요). gate_id
        // 선택, work_item은 서버 요청 바디에서도 항상 필수(site.ts 상단 주석 참고).
        const gateId = args.gate_id ? String(args.gate_id) : undefined
        const workItem = String(args.work_item ?? '')
        if (!workItem) throw new Error('work_item is required')
        const workItemType = args.work_item_type ? String(args.work_item_type) : undefined
        const title = String(args.title ?? '')
        const body = String(args.body ?? '')
        const slug = String(args.slug ?? '')
        const lang = String(args.lang ?? '')
        const summary = String(args.summary ?? '')
        const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined
        const siteBaseUrl = String(args.site_base_url ?? '')
        try {
          const result = await publishSitePost({
            gateId,
            workItemId: workItem,
            workItemType,
            title,
            body,
            slug,
            lang,
            summary,
            tags,
            sprintableApiUrl: API_URL,
            sprintableApiKey: API_KEY,
            site: { siteBaseUrl },
          })
          logEvent('site_post_publish_sent', { gate_id: gateId, work_item: workItem, post_id: result.id, url: result.url })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          if (err instanceof GateNotApprovedError) {
            logEvent('site_post_publish_blocked', { gate_id: gateId, work_item: workItem, gate_status: err.gateStatus })
          } else if (err instanceof NoGateFoundError) {
            logEvent('site_post_publish_no_gate', { work_item: workItem })
          }
          throw err
        }
      }
      case 'describe_connector': {
        const connector = String(args.connector ?? '')
        const descriptor = resolveConnectorDescriptor(connector)
        if (!descriptor) throw new Error(`unknown connector: ${connector} (expected 'threads', 'stibee', 'instagram', 'site_git', or 'site')`)
        return { content: [{ type: 'text', text: JSON.stringify(toWireDescriptor(descriptor)) }] }
      }
      case 'register_connector_schema': {
        const connector = String(args.connector ?? '')
        const descriptor = resolveConnectorDescriptor(connector)
        if (!descriptor) throw new Error(`unknown connector: ${connector} (expected 'threads', 'stibee', 'instagram', 'site_git', or 'site')`)
        const result = await registerConnectorSchema(toWireDescriptor(descriptor), {
          apiUrl: API_URL, apiKey: API_KEY,
        })
        logEvent('connector_schema_registered', { connector, version: result.version })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'set_connector_config': {
        const connector = String(args.connector ?? '')
        const descriptor = resolveConnectorDescriptor(connector)
        if (!descriptor) throw new Error(`unknown connector: ${connector} (expected 'threads', 'stibee', 'instagram', 'site_git', or 'site')`)
        const config = (args.config ?? {}) as Record<string, unknown>
        try {
          const result = await updateConnectorConfig(descriptor, config, { apiUrl: API_URL, apiKey: API_KEY })
          logEvent('connector_config_set', { connector, keys: Object.keys(config) })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          if (err instanceof ConnectorConfigForbiddenError) {
            logEvent('connector_config_forbidden', { connector })
          }
          throw err
        }
      }
      case 'get_threads_insights': {
        const threadsToken = (process.env.THREADS_ACCESS_TOKEN ?? '').trim()
        const threadsUserId = (process.env.THREADS_USER_ID ?? '').trim()
        if (!threadsToken || !threadsUserId) {
          throw new Error(
            'THREADS_ACCESS_TOKEN/THREADS_USER_ID not configured — run ' +
              '/sprintable:configure-threads <access-token> <user-id> [app-secret] first',
          )
        }
        const postId = String(args.post_id ?? '')
        if (!postId) throw new Error('post_id is required')
        const workItem = String(args.work_item ?? '')
        if (!workItem) throw new Error('work_item is required')
        const workItemType = args.work_item_type ? String(args.work_item_type) : undefined
        const result = await getThreadsInsightsAndRecordEvidence({
          postId,
          workItemId: workItem,
          workItemType,
          sprintableApiUrl: API_URL,
          sprintableApiKey: API_KEY,
          threads: { accessToken: threadsToken, userId: threadsUserId },
        })
        logEvent('threads_insights_measured', {
          post_id: postId, work_item: workItem, evidence_recorded: result.evidenceRecorded,
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())

// ── parent-death guard ───────────────────────────────────────────────────────
// stdin 은 호스트 세션(claude)이 물려준 MCP transport 파이프다. 세션이 죽으면 stdin 이
// EOF 를 맞는다. 이 가드가 없으면 아래 SSE 재연결 루프(while true)가 프로세스를 영원히
// 살려 둬 고아(PPID→1)로 남고, Agent Gateway 스트림 슬롯을 영구히 물어 재기동 뒤 "키당 3"
// 한도를 포화시킨다(2026-08-10 ortega 10일 고아 PID 38453 근본원인). 부모와 함께 죽는다.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
// 백스톱: stdin EOF 를 못 받은 채 init(PID 1)로 재양육되면(=완전 고아·2026-08-10 PID 38453
// 이 형태였다) 자진 종료. unref 로 이 타이머 자체가 프로세스를 살려 두진 않게 한다.
setInterval(() => { if (process.ppid === 1) process.exit(0) }, 15_000).unref()

// ── channel deliver ──────────────────────────────────────────────────────────

function deliver(
  id: string,
  text: string,
  // story #2649: 예전엔 단일-파일 `file?: {path, name}`였으나 실 호출부가 항상 undefined만
  // 넘겨 사실상 죽은 파라미터였다(inboundMeta Map이 write-only였던 것과 동형 패턴,
  // #2622/#2649 그라운딩 둘 다 같은 클래스 발견). attachments는 배열이라 이 자리를 그대로
  // 재사용 — 첨부 개수·이름·타입·크기만 노출(다운로드 경로는 별도 백엔드 갭, story
  // f953720d — 여기선 만들지 않는다).
  attachments?: AttachmentMeta[],
  meta?: {
    thread_id?: string
    reply_callback_url?: string
    reply_callback_api_key?: string
    // story #2583 — 이 메타의 실제 발신자. 미지정이면 이전 동작 그대로 'sprintable'
    // 폴백(다른 호출부가 생기더라도 무회귀).
    user?: string
  },
): void {
  if (meta?.thread_id && meta?.reply_callback_url && meta?.reply_callback_api_key) {
    const m: InboundMeta = {
      threadId: meta.thread_id,
      replyCallbackUrl: meta.reply_callback_url,
      replyCallbackApiKey: meta.reply_callback_api_key,
      ts: Date.now(),
    }
    // story #2622: key = thread_id(== 아래 notification의 chat_id 속성과 동일 값) — reply의
    // chat_id 파라미터가 이 값을 그대로 되돌려주는 형태이므로, message id가 아니라 대화
    // 단위로 조회 가능해야 한다(한 대화에서 새 메시지가 올 때마다 최신 콜백으로 갱신).
    inboundMeta.set(meta.thread_id, m)
    latestInboundMeta = m
    pruneInboundMeta(inboundMeta)
  }

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      // story #2649/#3c7968ee: attachment_count/attachments 포함 — 메타 값 전부 문자열
      // 직렬화는 buildChannelNotificationMeta가 전담(하니스 string-only 계약, 위반 시
      // ProtocolError로 STDIO 알림 자체가 드롭됐던 실피해).
      meta: buildChannelNotificationMeta({
        threadId: meta?.thread_id, messageId: id, user: meta?.user, attachments,
      }),
    },
  })
}

// ── SSE dial-out ─────────────────────────────────────────────────────────────

let _lastEventId = ''
let _lastAcked = 0
let _reconnectDelay = 2000
const _seen = new Map<string, number>()

function _isDuplicate(eventId: string): boolean {
  const now = Date.now()
  if (_seen.size > 1000) {
    for (const [k, v] of _seen) {
      if (now - v > 300_000) _seen.delete(k)
    }
  }
  if (_seen.has(eventId)) return true
  _seen.set(eventId, now)
  return false
}

async function _sendAck(seq: number): Promise<void> {
  if (seq <= _lastAcked) return
  try {
    const resp = await fetch(`${API_URL}/api/v2/agent/events/ack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'x-agent-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seq }),
    })
    if (resp.ok) {
      _lastAcked = seq
      process.stderr.write(`[sprintable] ack seq=${seq}\n`)
    } else {
      process.stderr.write(`[sprintable] ack HTTP ${resp.status} seq=${seq}\n`)
    }
  } catch (e) {
    process.stderr.write(`[sprintable] ack error seq=${seq}: ${e}\n`)
  }
}

async function _onEvent(evType: string, evId: string, dataStr: string): Promise<void> {
  if (evType === 'heartbeat') return

  let data: Record<string, unknown>
  try {
    data = JSON.parse(dataStr)
  } catch {
    return
  }

  // event shape: content/conversation_id/sender/recipient_seq top-level
  // payload 서브오브젝트도 지원 (conversation.message_created 등)
  const payload =
    (typeof data.payload === 'object' && data.payload !== null
      ? data.payload
      : {}) as Record<string, unknown>

  // E-CHAT-CMD S9: allowlist 밖 event_type 은 content 체크 전에 드롭(sprintable_sse.py:157 동형).
  // fakechat 가 유일하게 이 게이트가 없어 FYI 이벤트(status_changed/file_conflict 등)가 content 만
  // 있으면 세션에 주입되던 보안 갭을 닫는다.
  if (!isInjectableEventType(data, payload)) return

  // recipient_seq for ack — data 최상위 우선, payload fallback. content 체크보다 먼저 계산해야
  // 아래 빈-content 분기에서도 ack할 수 있다(#2375 AC5).
  let seq = 0
  for (const cand of [data.recipient_seq, payload.recipient_seq]) {
    const n = Number(cand)
    if (Number.isFinite(n) && n > 0) {
      seq = n
      break
    }
  }

  const content = ((data.content ?? payload.content ?? '') as string).trim()
  // story #2649: 백엔드 _msg_payload()가 이미 payload.attachments를 싣는데 이 서버는 여태
  // 전혀 안 읽었다 — content만 봐서 "첨부만 있고 텍스트 없는" 메시지가 아래 빈-content
  // 분기에서 통째로 드롭됐다(안 보일 것=0건 취급이었으나 실제론 첨부가 있었다). content·
  // recipient_seq와 동형으로 data 최상위 우선 → payload 폴백(top-level shape 이벤트에
  // 첨부가 실리는 경우도 닫는다 — 이 파일의 기존 관례 그대로 미러, Pedro QA).
  const attachments = sanitizeAttachments(data.attachments ?? payload.attachments)
  if (!content && attachments.length === 0) {
    // #2375 AC5 — 내용도 첨부도 없는 injectable 이벤트는 "전달 실패"가 아니라 "보일 것
    // 없음"이다. 예전엔 여기서 ack 없이 return해 seq가 영원히 미확인으로 남았다 — 재연결마다
    // backfill이 같은 이벤트를 다시 보내는데, 그 backfill flood를 막으려던 ack 메커니즘
    // (주석 참조) 자체가 이 경로에서만 무력화돼 있었다(2026-07-31~08-01 dispatched 20건+
    // 영구 pending의 근본원인). 서버가 content를 채운 뒤(notification_dispatch.py)로도 이
    // 분기는 남는다 — 어떤 injectable event가 정말로 텍스트도 첨부도 안 실은 채 오는
    // 경우의 안전망.
    if (seq > 0) await _sendAck(seq)
    return
  }

  const eventId = (data.event_id ?? payload.id ?? evId ?? crypto.randomUUID()) as string
  if (_isDuplicate(eventId)) return

  if (evId) _lastEventId = evId

  const conversationId = (
    payload.conversation_id ??
    payload.thread_id ??
    data.conversation_id ??
    ''
  ) as string

  // 카디르 QA: payload.sender만 보면 그 경로가 비어있는 이벤트에서 sender가 통째로
  // {}가 돼 HITL 감사 로그(hitl_reply_rejected)에 "누가 사칭 시도했나"가 안 남는다
  // (fail-closed라 보안엔 무영향이지만 관측성 갭). hermes adapter.py의 동일 폴백 패턴
  // (payload.sender or data.sender)을 그대로 가져온다.
  const senderRaw =
    (typeof payload.sender === 'object' && payload.sender !== null ? payload.sender : undefined) ??
    (typeof data.sender === 'object' && data.sender !== null ? data.sender : undefined)
  const sender = (senderRaw ?? {}) as Record<string, unknown>
  const senderName = String(sender.name ?? data.sender_id ?? 'sprintable')
  const senderType = String(sender.type ?? '')
  const senderId = String(sender.id ?? '')
  // story #2583 — 같은 방식(data 최상위 → payload fallback)으로 event_kind/ts도 뽑아
  // 아래 deliver() 호출에서 envelope으로 렌더한다(inject-allowlist.ts의 event_type 추출과
  // 동형 순서 — 두 곳이 다른 값으로 갈리면 안 되므로 같은 fallback 체인을 그대로 미러).
  const eventKind = String(data.event_type ?? payload.event_type ?? '')
  const ts = String(data.created_at ?? payload.created_at ?? '')

  if (conversationId) persistCurrentConversation(conversationId)

  // HITL①(#2570): 이 conv에 대기 중인 승인요청이 있으면 allow/deny 답인지 먼저 본다.
  // 권위 가드(Ortega 확定) — sender.type==="human"만 유효. 에이전트 발신 allow/deny는
  // "답을 사칭"할 수 있어(다른 에이전트가 팀 conv에서 대신 승인) 무시+로그만 남기고 정상
  // deliver()로 흘려보낸다(먹통 아님 — 그냥 승인 결정으로는 안 씀). 선택적 승인자
  // whitelist(SPRINTABLE_HITL_APPROVERS)도 같은 원칙: 비어있으면 human 전체 허용.
  const pending = conversationId ? pendingApprovals.get(conversationId) : undefined
  if (pending) {
    const m = content.match(/^\s*(allow|deny)\b\s*(.*)$/i)
    if (m) {
      const isHuman = senderType === 'human'
      const isApprover = HITL_APPROVERS.length === 0 || HITL_APPROVERS.includes(senderId)
      if (isHuman && isApprover) {
        const decision = m[1].toLowerCase() === 'allow' ? 'allow' : 'deny'
        pending.resolve({ behavior: decision, message: m[2]?.trim() || undefined })
        if (seq > 0) await _sendAck(seq)
        return // 승인 답 자체는 일반 채널 메시지로 재주입 안 함 — 모델이 이미 도구 응답으로 받음
      }
      logEvent('hitl_reply_rejected', {
        conversation_id: conversationId, sender_type: senderType, sender_id: senderId,
        reason: !isHuman ? 'not_human' : 'not_in_approver_whitelist',
      })
      // 사칭/권한밖 시도는 정상 deliver()로 흘려보낸다(아래로 계속) — 대기 상태는 안 풀림.
    }
  }

  const meta =
    conversationId
      ? {
          thread_id: conversationId,
          reply_callback_url: `${API_URL}/api/v2/conversations/${conversationId}/messages`,
          reply_callback_api_key: API_KEY,
          user: senderName,
        }
      : { user: senderName }

  process.stderr.write(
    `[sprintable] inbound seq=${seq} conv=${conversationId} from=${senderName}: ${content.slice(0, 80)}\n`,
  )

  // story #2583 — 발신자/이벤트종류/ts를 표준 envelope로 렌더해 실음(content만 넘기면
  // 모델이 발신자를 모른 채 진행 — 댄 어윈 오호칭 사고와 동일 코드 경로였다).
  // story #2649: content가 비어도(첨부만 있는 메시지) envelope 본문이 완전히 텅 비지
  // 않게 표시용 문구로 채운다 — 위 allow/deny 매칭·로그는 원본 content(빈 문자열 포함)를
  // 그대로 쓰고, 이 치환은 여기 렌더링 시점에만 적용한다.
  const displayContent = content || attachmentPlaceholderText(attachments)
  const envelopeText = formatEnvelopeText({
    content: displayContent, senderName, senderId, senderType, eventKind, conversationId, ts,
  })
  deliver(eventId, envelopeText, attachments, meta)

  if (seq > 0) await _sendAck(seq)
}

async function _consumeStream(): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'x-agent-api-key': API_KEY,
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
  }
  if (_lastEventId) headers['Last-Event-ID'] = _lastEventId

  const resp = await fetch(`${API_URL}/api/v2/agent/stream`, { headers })
  if (!resp.ok) {
    // 게이트웨이는 동시 스트림 한도초과를 «상태코드»로 알린다 — per-key=429, global=503
    // (agent_gateway.py). 429 는 `Retry-After` 헤더 + `{error:{code,retry_after}}` 본문을
    // 싣는다. 서버가 준 retry_after 를 backoff 하한으로 삼아, 흔적만 남기고 슬롯을 계속
    // 되무는 재연결 대신 서버 계약대로 물러선다(throw → _runStream 지수 backoff).
    let retryAfter = Number(resp.headers.get('retry-after')) || 0
    let code = `HTTP ${resp.status}`
    try {
      const j = (await resp.json()) as { error?: { code?: string; retry_after?: number } }
      if (j?.error?.code) code = j.error.code
      if (retryAfter <= 0) {
        const ra = Number(j?.error?.retry_after)
        if (Number.isFinite(ra) && ra > 0) retryAfter = ra
      }
    } catch {}
    if (retryAfter > 0) _reconnectDelay = Math.max(_reconnectDelay, retryAfter * 1000)
    process.stderr.write(`[sprintable] stream refused: ${code} (HTTP ${resp.status}) — backoff ${_reconnectDelay}ms\n`)
    throw new Error(`stream refused: ${code} (HTTP ${resp.status})`)
  }
  if (!resp.body) throw new Error('no response body')

  process.stderr.write('[sprintable] SSE stream open\n')
  _reconnectDelay = 2000 // 성공 시 backoff 리셋

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let evType = 'message'
  let evId = ''
  let dataLines: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      if (line === '') {
        if (dataLines.length) {
          await _onEvent(evType, evId, dataLines.join('\n'))
        }
        evType = 'message'
        evId = ''
        dataLines = []
      } else if (line.startsWith(':')) {
        // comment — skip
      } else if (line.startsWith('event:')) {
        evType = line.slice(6).trim()
      } else if (line.startsWith('id:')) {
        evId = line.slice(3).trim()
      } else if (line.startsWith('data:')) {
        const v = line.slice(5)
        dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
      }
    }
  }
  process.stderr.write('[sprintable] SSE stream closed\n')
}

async function _runStream(): Promise<void> {
  if (HAS_WEBHOOK) {
    process.stderr.write('[sprintable] webhook configured — SSE off\n')
    return
  }
  if (!API_KEY) {
    process.stderr.write('[sprintable] SPRINTABLE_API_KEY / AGENT_API_KEY not set — SSE disabled\n')
    return
  }

  while (true) {
    const start = Date.now()
    try {
      await _consumeStream()
    } catch (e) {
      process.stderr.write(`[sprintable] stream error: ${e}\n`)
    }
    if (Date.now() - start >= 60_000) _reconnectDelay = 2000
    process.stderr.write(`[sprintable] reconnecting in ${_reconnectDelay}ms\n`)
    await Bun.sleep(_reconnectDelay)
    _reconnectDelay = Math.min(_reconnectDelay * 2, 60_000)
  }
}

void _runStream()
