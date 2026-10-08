import type { Task } from './generation.ts';

export type TaskSummary = Pick<Task, 'id' | 'projectId' | 'nodeId' | 'kind' | 'provider' | 'model' | 'status' | 'inputFingerprint' | 'createdAt' | 'updatedAt'> & {
  mode: 'mock' | 'real'; error: string | null; errorCode: string | null; generationId: string | null;
  actions: { requery: boolean; cancel: boolean };
};
export interface HistoryPage { items: TaskSummary[]; nextCursor: string | null; snapshot: number }
/** Compatibility for old failed records is isolated here; new workers persist the code. */
export function taskErrorCode(task: Pick<Task, 'status' | 'error'> & { errorCode?: string | null }): string | null {
  return task.errorCode ?? (task.status === 'failed' && task.error?.startsWith('保存结果失败') ? 'RESULT_SAVE_FAILED' : null);
}
