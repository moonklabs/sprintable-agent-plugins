/**
 * story #3317 — Stibee content_package 정본. `create`/`html`이 실제로는 콘텐츠(work item이
 * 들고 오는 값)와 조직 설정값(발신자·리스트 — 조직마다 다르고 코드/프리셋에 박으면 안 됨,
 * 선생님 그라운드룰 «제품=슬롯·값=조직»)이 한 객체에 섞여 있던 게 이 스토리의 발견
 * 자체(#3310 드라이런 — 임의값으로 넘겨야 통과했다). 여기서 그 둘을 분리 선언한다.
 *
 * dot-path 필드(`create.*`)는 tool-definitions.ts의 기존 중첩 inputSchema.create.properties
 * 형태를 그대로 유지한 채(손으로 유지, connector-schema.ts 상단 주석 참고)
 * tool-definitions.test.ts가 이 정본과의 드리프트를 직접 pin한다 — 사본이 없어 갈릴 여지가
 * 없다.
 */
import type { ConnectorDescriptor } from './connector-schema'

export const STIBEE_CONNECTOR_DESCRIPTOR: ConnectorDescriptor = {
  connectorKey: 'stibee',
  version: '1.0.0',
  channel: 'stibee',
  fields: [
    {
      name: 'create.subject', type: 'string', description: 'Email subject line — drafted per campaign.',
      source: 'content', required: true,
    },
    {
      name: 'html', type: 'string', description: 'Email body HTML — sent verbatim to POST /v2/emails/{id}/content.',
      source: 'content', required: true,
    },
    {
      name: 'create.senderEmail', type: 'string', description: 'Sender email address.',
      source: 'org_config', required: true,
      setupHint: '조직의 발신 이메일 — Stibee 워크스페이스 설정에서 확인 후 조직 설정 화면에 등록',
    },
    {
      name: 'create.senderName', type: 'string', description: 'Sender display name.',
      source: 'org_config', required: true,
      setupHint: '조직의 발신자명 — 조직 설정 화면에 등록',
    },
    {
      name: 'create.listId', type: 'number', description: 'Stibee list id to send to.',
      source: 'org_config', required: true,
      setupHint: 'Stibee 워크스페이스의 리스트 ID — 워크스페이스 설정 > 주소록에서 확인 후 조직 설정 화면에 등록',
    },
    {
      name: 'create.groupIds', type: 'array', description: 'Optional Stibee group ids to target.',
      source: 'org_config', required: false, constraints: { itemType: 'number' },
      setupHint: '선택 — Stibee 워크스페이스의 그룹 ID',
    },
    {
      name: 'create.segmentIds', type: 'array', description: 'Optional Stibee segment ids to target.',
      source: 'org_config', required: false, constraints: { itemType: 'number' },
      setupHint: '선택 — Stibee 워크스페이스의 세그먼트 ID',
    },
  ],
  requiresEnv: ['STIBEE_ACCESS_TOKEN'],
}
