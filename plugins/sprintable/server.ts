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
    writeFileSync(
      join(STATE_DIR, 'current_conversation.json'),
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

type InboundMeta = {
  threadId: string
  replyCallbackUrl: string
  replyCallbackApiKey: string
}

const inboundMeta = new Map<string, InboundMeta>()
let latestInboundMeta: InboundMeta | undefined

// ── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'sprintable', version: '0.2.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'Sprintable 게이트웨이 이벤트가 <channel source="sprintable"> 블록으로 도착한다. ' +
      '응답은 reply 도구를 사용하는.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'POST /api/v2/conversations/{id}/messages. Requires an active conversation.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
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
      // mcp__plugin_sprintable_sprintable__approval_prompt`로 명시 지정해야만 호출됨
      // (opt-in, AC4). 카디르 QA 지적: 실 플러그인 설치 등록명은 mcp__plugin_<plugin>_
      // <server>__<tool> 접두라 bare mcp__sprintable__approval_prompt(--mcp-config
      // ad hoc 로드 전용, 로컬 개발 테스트에서만 맞음)로 쓰면 즉시 "tool not found".
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
  ],
}))

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
        const meta = latestInboundMeta
        if (!meta?.replyCallbackUrl) throw new Error('no active conversation')
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
  file?: { path: string; name: string },
  meta?: { thread_id?: string; reply_callback_url?: string; reply_callback_api_key?: string },
): void {
  if (meta?.thread_id && meta?.reply_callback_url && meta?.reply_callback_api_key) {
    const m: InboundMeta = {
      threadId: meta.thread_id,
      replyCallbackUrl: meta.reply_callback_url,
      replyCallbackApiKey: meta.reply_callback_api_key,
    }
    inboundMeta.set(id, m)
    latestInboundMeta = m
  }

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text || `(${file?.name ?? 'attachment'})`,
      meta: {
        chat_id: meta?.thread_id ?? 'sprintable',
        message_id: id,
        user: 'sprintable',
        ts: new Date().toISOString(),
        ...(file ? { file_path: file.path } : {}),
        ...(meta?.thread_id ? { thread_id: meta.thread_id } : {}),
      },
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
  if (!content) {
    // #2375 AC5 — 내용 없는 injectable 이벤트는 "전달 실패"가 아니라 "보일 것 없음"이다.
    // 예전엔 여기서 ack 없이 return해 seq가 영원히 미확인으로 남았다 — 재연결마다 backfill이
    // 같은 이벤트를 다시 보내는데, 그 backfill flood를 막으려던 ack 메커니즘(주석 참조) 자체가
    // 이 경로에서만 무력화돼 있었다(2026-07-31~08-01 dispatched 20건+ 영구 pending의 근본원인).
    // 서버가 content를 채운 뒤(notification_dispatch.py)로도 이 분기는 남는다 — 어떤 injectable
    // event가 정말로 텍스트를 안 실은 채 오는 경우의 안전망.
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
        }
      : undefined

  process.stderr.write(
    `[sprintable] inbound seq=${seq} conv=${conversationId} from=${senderName}: ${content.slice(0, 80)}\n`,
  )

  deliver(eventId, content, undefined, meta)

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
