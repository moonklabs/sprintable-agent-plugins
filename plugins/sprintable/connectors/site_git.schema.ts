/**
 * story a32c9f1a — 자사 사이트(git) 발행 커넥터 content_package 정본(story #3317 계약
 * 형상 그대로, stibee.schema.ts와 동형: content=work item이 들고 오는 값, org_config=
 * 조직마다 다른 값). 저장소 좌표(repo/branch/pathTemplate)·공개 base URL은 조직 설정
 * (source='org_config') — 코드/프리셋에 박지 않는다("제품=슬롯·값=조직" 그라운드룰).
 */
import type { ConnectorDescriptor } from './connector-schema'

export const SITE_GIT_CONNECTOR_DESCRIPTOR: ConnectorDescriptor = {
  connectorKey: 'site_git',
  version: '1.0.0',
  channel: 'site_git',
  kinds: ['publish'],
  fields: [
    {
      name: 'title', type: 'string', description: 'Post title.',
      source: 'content', required: true,
    },
    {
      name: 'body', type: 'string', description: 'Post body, plain markdown.',
      source: 'content', required: true,
    },
    {
      name: 'slug', type: 'string', description: 'URL slug — becomes the file name and the published path segment.',
      source: 'content', required: true,
    },
    {
      name: 'lang', type: 'string', description: 'Locale of this post (e.g. "ko") — resolves {lang} in path_template.',
      source: 'content', required: true,
    },
    {
      name: 'summary', type: 'string', description: 'Optional short summary for listing pages.',
      source: 'content', required: false,
    },
    {
      name: 'tags', type: 'array', description: 'Optional tags.',
      source: 'content', required: false, constraints: { itemType: 'string' },
    },
    {
      name: 'repo', type: 'string', description: 'GitHub "owner/name" of the target static-site repo.',
      source: 'org_config', required: true,
      setupHint: '정적 사이트 GitHub 저장소 — "owner/name" 형태로 조직 설정 화면에 등록',
    },
    {
      name: 'branch', type: 'string', description: 'Target branch to commit to.',
      source: 'org_config', required: true,
      setupHint: '커밋 대상 브랜치(보통 배포 트리거 브랜치, 예: main) — 조직 설정 화면에 등록',
    },
    {
      name: 'path_template', type: 'string',
      description: 'File path template with {lang}/{slug} placeholders, e.g. "content/blog/{lang}/{slug}.md".',
      source: 'org_config', required: true,
      setupHint: '저장소 안 파일 경로 규칙 — 조직 설정 화면에 등록(기본값 없음, 명시 필수)',
    },
    {
      name: 'site_base_url', type: 'string', description: 'Public site base URL for computing the published post URL.',
      source: 'org_config', required: true,
      setupHint: '공개 사이트 주소(예: https://sprintable.ai) — 조직 설정 화면에 등록',
    },
  ],
  // GITHUB_TOKEN만 — repo/branch/path_template/site_base_url은 시크릿이 아니라
  // org_config 필드로 선언한다(connector-schema.ts의 시크릿-형 필드명 서버측 이중가드와
  // 무관, 그 값들 자체가 비밀이 아니므로).
  requiresEnv: ['GITHUB_TOKEN'],
}
