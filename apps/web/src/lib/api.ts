import type { Asset, CanvasDocument, Project, ProjectSummary } from '../../../../packages/shared/src/index.ts';
import type { ExportPreview, ExportJob, ImportResult, ProjectTransfer } from '../../../../packages/shared/src/transfer.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public requestId?: string) { super(message); }
}
export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options, headers: { ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result.message ?? '操作失败', result.code, response.headers.get('X-Request-Id') ?? undefined);
  return result as T;
}
export const api = {
  import: (value: unknown) => request<ImportResult>('/api/projects/import', { method: 'POST', body: JSON.stringify(value), signal: AbortSignal.timeout(120000) }),
  structure: (id: string) => request<ProjectTransfer>(`/api/projects/${id}/structure`),
  exportPreview: (id: string) => request<ExportPreview>(`/api/projects/${id}/exports/preview`, { method: 'POST', signal: AbortSignal.timeout(120000) }),
  exportCreate: (p: ExportPreview, allowPartial: boolean) => request<ExportJob>(`/api/projects/${p.projectId}/exports`, { method: 'POST', body: JSON.stringify({ revision: p.revision, fingerprint: p.fingerprint, allowPartial }), signal: AbortSignal.timeout(120000) }),
  exportJob: (id: string) => request<ExportJob>(`/api/exports/${id}`),
  assets: (id: string) => request<Asset[]>(`/api/projects/${id}/assets`),
  upload: (id: string, file: File) => request<Asset>(`/api/projects/${id}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' }, signal: AbortSignal.timeout(120000) }),
  list: () => request<ProjectSummary[]>('/api/projects'),
  get: (id: string) => request<Project>(`/api/projects/${id}`),
  create: (name: string, template: 'empty' | 'story') => request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name, template }) }),
  duplicate: (id: string) => request<Project>(`/api/projects/${id}/duplicate`, { method: 'POST' }),
  save: (id: string, revision: number, document: CanvasDocument, name: string) => request<Project>(`/api/projects/${id}/document`, {
    method: 'PUT', body: JSON.stringify({ revision, document, name }),
  }),
};

export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
