import { create } from 'zustand';
import type { Generation, Task } from '../../../../../packages/shared/src/generation.ts';
import { request } from '../../lib/api.ts';
import { useAssets } from '../assets/asset-store.ts';
import type { TaskSummary, HistoryPage } from '../../../../../packages/shared/src/task-query.ts';
import { isGenerationNode } from '../../../../../packages/shared/src/index.ts';
import { useEditor } from '../canvas/editor-store.ts';

interface TaskState {
  projectId: string; tasks: TaskSummary[]; generations: Generation[]; details: Task[]; activeCount: number; error: string;
  load: (id: string) => Promise<void>;
  history: (id: string, nodeId?: string, cursor?: string) => Promise<HistoryPage>;
  ensureGeneration: (projectId: string, id: string) => Promise<Generation>;
  detail: (id: string) => Promise<Task>;
}
let epoch = 0;
const inflight = new Map<string, Promise<void>>();
const generationRequests = new Map<string, Promise<Generation>>();
function same(a: TaskSummary, b: TaskSummary) {
  return Object.keys(a).every(key => key === 'actions' ? a.actions.cancel === b.actions.cancel && a.actions.requery === b.actions.requery : a[key as keyof TaskSummary] === b[key as keyof TaskSummary]);
}
export const useTasks = create<TaskState>((set, get) => ({
  projectId: '', tasks: [], generations: [], details: [], activeCount: 0, error: '',
  load: id => {
    if (get().projectId !== id) { epoch++; set({ projectId: id, tasks: [], generations: [], details: [], activeCount: 0, error: '' }); }
    const currentEpoch = epoch, key = `${currentEpoch}:${id}`;
    if (inflight.has(key)) return inflight.get(key)!;
    const pending = (async () => {
      try {
        const value = await request<{ items: TaskSummary[]; activeCount: number }>(`/api/projects/${id}/task-activity`);
        if (epoch !== currentEpoch) return;
        const old = new Map(get().tasks.map(t => [t.id, t]));
        const tasks = value.items.map(t => old.has(t.id) && same(old.get(t.id)!, t) ? old.get(t.id)! : t);
        const changed = tasks.length !== get().tasks.length || tasks.some((t, i) => t !== get().tasks[i]);
        const newOutput = tasks.some(t => t.generationId && t.generationId !== old.get(t.id)?.generationId);
        if (changed || value.activeCount !== get().activeCount || get().error) set({ tasks: changed ? tasks : get().tasks, activeCount: value.activeCount, error: '' });
        const editor = useEditor.getState();
        const selected = editor.projectId === id ? editor.doc.nodes.flatMap(n => isGenerationNode(n) && n.data.selectedGenerationId ? [n.data.selectedGenerationId] : []) : [];
        for (const genId of new Set(selected)) { if (epoch !== currentEpoch) return; await get().ensureGeneration(id, genId); }
        if (newOutput && epoch === currentEpoch) await useAssets.getState().load(id);
      } catch (error) { if (epoch === currentEpoch) set({ error: (error as Error).message }); }
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending); return pending;
  },
  history: async (id, nodeId, cursor) => {
    const query = new URLSearchParams(); if (nodeId) query.set('nodeId', nodeId); if (cursor) query.set('cursor', cursor);
    return request<HistoryPage>(`/api/projects/${id}/task-history?${query}`);
  },
  ensureGeneration: async (projectId, id) => {
    const cached = get().projectId === projectId ? get().generations.find(g => g.id === id) : undefined;
    if (cached) return cached;
    const currentEpoch = epoch, key = `${currentEpoch}:${projectId}:${id}`;
    let pending = generationRequests.get(key);
    if (!pending) {
      pending = request<Generation>(`/api/projects/${projectId}/generations/${id}`).then(g => {
        if (get().projectId === projectId && epoch === currentEpoch) {
          const pins = new Set(useEditor.getState().doc.nodes.flatMap(n => isGenerationNode(n) && n.data.selectedGenerationId ? [n.data.selectedGenerationId] : []));
          set(s => ({ generations: [g, ...s.generations.filter(item => item.id !== g.id)].filter((item, index) => index < 200 || pins.has(item.id)) }));
        }
        return g;
      }).finally(() => generationRequests.delete(key));
      generationRequests.set(key, pending);
    }
    return pending;
  },
  detail: async id => {
    const currentEpoch = epoch, task = await request<Task>(`/api/tasks/${id}`);
    if (epoch === currentEpoch && get().projectId === task.projectId) set(s => ({ details: [task, ...s.details.filter(t => t.id !== id)].slice(0, 100) }));
    return task;
  },
}));

export function taskPollDelay(activeCount: number, hidden: boolean) { return hidden ? 30000 : activeCount ? 1200 : 10000; }
