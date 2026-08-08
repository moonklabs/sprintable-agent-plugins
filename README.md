# Sprintable — Claude Code 연결 어댑터

Claude Code를 Sprintable 팀에 **실시간으로** 붙입니다. Anthropic 공인 `fakechat` 채널
플러그인 슬롯에 이 Sprintable 어댑터를 얹는 방식으로, **Sprintable 팀 에이전트가 실제로
붙는 것과 동일한 방법**입니다.

## 무엇을 하나

- Sprintable Agent Gateway의 SSE(`/api/v2/agent/stream`)를 소비해, 채팅에서 온
  메시지를 Claude Code 세션에 `<channel source="fakechat">` 블록으로 주입합니다.
- 답장은 `reply` 도구 → `POST /api/v2/conversations/{id}/messages`.
- 이벤트 타입 allowlist(`inject-allowlist.ts`)로 실제 대화/작업 이벤트만 주입하고
  FYI성 이벤트(status_changed 등)는 드롭합니다.

## 사전 준비

- [Bun](https://bun.sh) — `server.ts` 실행 런타임
- Sprintable에서 발급한 **에이전트 API 키**
  (조직 → 워크포스 → 해당 에이전트 → API 키. 발급 값은 그 자리에서만 보이니 복사해 두십시오.)

## 3단계

### 1. 공인 fakechat 플러그인 설치

```
/plugin install fakechat@claude-plugins-official
```

설치 위치: `~/.claude/plugins/cache/claude-plugins-official/fakechat/<version>/`

### 2. 이 어댑터로 교체

설치된 슬롯에서 파일을 이 저장소 것으로 바꿉니다.

- `server.ts` → 이 저장소의 `server.ts`로 **교체**
- `inject-allowlist.ts` → 이 저장소의 `inject-allowlist.ts` **추가**
- 공인 슬롯의 `plugin.json`·`package.json`은 **그대로 둡니다** — 원본 실행 스크립트가
  교체된 `server.ts`를 그대로 구동합니다.

### 3. 자격증명과 함께 실행

```bash
export AGENT_API_KEY="<1단계에서 발급한 키>"
# prod에 붙을 때 (미설정 시 dev 기본값으로 붙음)
export SPRINTABLE_API_URL="https://sprintable-backend-prod-57iommnikq-du.a.run.app"

claude --channels plugin:fakechat@claude-plugins-official
```

키가 프로세스 환경에 없으면 어댑터는 SSE를 열지 않고 조용히 대기합니다(`SSE disabled`).

## 성공 확認

Sprintable 채팅에서 이 에이전트에게 말을 걸어 **세션이 스스로 시작**되면 연결된
것입니다. `Added`/`enabled: true`는 도구 등록(아래)이 된 것이지 채널이 붙은 증거가
아닙니다.

## 함께 필요한 것 — MCP 도구 등록(별도)

이 어댑터는 «Sprintable → 세션» 방향(채널 주입)을 담당합니다. 반대 방향 — 에이전트가
Sprintable 도구(작업 조회·댓글·상태 변경 등)를 **부르는** 것 — 은 MCP 서버 등록이며
별개입니다. Sprintable이 발급하는 `.mcp.json`을 그대로 쓰는 것이 가장 확실합니다.

## 라이선스

MIT — `LICENSE` 참조.
