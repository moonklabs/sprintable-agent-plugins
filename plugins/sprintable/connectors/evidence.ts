/**
 * story #3321([M5·마케팅자동화] measure 단계 도구) — Sprintable evidence 기록 (일반,
 * threads 전용 아님 — 다음 measure 도구도 재사용 가능하게 커넥터 폴더 최상위에 둔다).
 *
 * 계약은 backend/app/routers/evidence.py::EvidenceCreateRequest를 소스에서 직접 확인해
 * 그대로 옮긴 것(추측 0) — `POST /api/v2/evidence`, body: work_item_id·work_item_type
 * ('story'|'task')·type(EVIDENCE_TYPES 중 하나·'metric' 포함 확인 済)·ref·source?·note?.
 * ⚠️이 Pydantic 모델엔 `extra='forbid'` 설정이 없다(기본값 extra='ignore') — 필드명
 * 오타를 보내면 422가 아니라 **그 필드가 조용히 빠진 채 성공**한다(페드루 지적 포인트).
 * 그래서 이 파일이 body 조립을 한 곳에서만 하고, 필드명은 evidence.test.ts가 정확히
 * pin한다 — 호출부가 매번 손으로 다시 짜지 않게.
 */

export interface RecordEvidenceParams {
  workItemId: string
  workItemType: string
  type: string
  ref: string
  source?: string
  note?: string
  apiUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export interface RecordEvidenceResult {
  id: string
}

export async function recordEvidence(params: RecordEvidenceParams): Promise<RecordEvidenceResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const res = await fetchImpl(`${params.apiUrl.replace(/\/$/, '')}/api/v2/evidence`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`,
      'x-agent-api-key': params.apiKey,
    },
    body: JSON.stringify({
      work_item_id: params.workItemId,
      work_item_type: params.workItemType,
      type: params.type,
      ref: params.ref,
      ...(params.source !== undefined ? { source: params.source } : {}),
      ...(params.note !== undefined ? { note: params.note } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`evidence create failed: ${res.status}`)
  }
  const body = (await res.json()) as { id: string }
  return { id: body.id }
}
