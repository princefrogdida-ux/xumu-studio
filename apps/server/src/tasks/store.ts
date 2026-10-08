import { randomUUID } from 'node:crypto';
import type { Generation, InputSnapshot, StoryDraft, Task } from '../../../../packages/shared/src/generation.ts';
import { ConflictError, NotFoundError, ProjectStore } from '../db/store.ts';

export class TaskStore {
  constructor(readonly projects: ProjectStore) {}
  get db() { return this.projects.db; }
  get(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) throw new NotFoundError('任务不存在'); return JSON.parse(row.data);
  }
  list(projectId: string): Task[] {
    return (this.db.prepare('SELECT data FROM tasks WHERE project_id = ? ORDER BY rowid DESC').all(projectId) as {data:string}[]).map(r => JSON.parse(r.data));
  }
  byKey(projectId: string, key: string): Task | undefined {
    const row = this.db.prepare('SELECT data FROM tasks WHERE project_id = ? AND request_key = ?').get(projectId,key) as { data:string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  create(projectId: string, nodeId: string, requestKey: string, inputSnapshot: InputSnapshot, inputFingerprint: string, retryOf: string | null): Task {
    const existing = this.byKey(projectId, requestKey); if (existing) { if (existing.nodeId !== nodeId) throw new ConflictError('请求标识已用于另一个节点'); return existing; }
    const now = new Date().toISOString();
    const task: Task = { id: randomUUID(), projectId, nodeId, requestKey, inputSnapshot, inputFingerprint, kind: inputSnapshot.kind, provider: inputSnapshot.provider, model: inputSnapshot.model,
      status: 'queued', providerTaskId: null, attempt: 0, leaseUntil: null, leaseOwner: null, nextPollAt: 0, error: null, retryOf, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, NULL, 0, ?) ON CONFLICT(project_id,request_key) DO NOTHING').run(task.id, projectId, nodeId, requestKey, task.status, JSON.stringify(task));
    const stored=this.byKey(projectId,requestKey)!;
    if(stored.nodeId!==nodeId)throw new ConflictError('请求标识已用于另一个节点');return stored;
  }
  update(task: Task, changes: Partial<Pick<Task, 'status' | 'providerTaskId' | 'attempt' | 'nextPollAt' | 'error' | 'errorCode' | 'leaseUntil' | 'leaseOwner'>>, owner?: string): Task {
    // Compare the current owner; stale workers cannot publish state after losing their lease.
    const current = this.get(task.id);
    if(current.status!==task.status)throw new ConflictError('任务状态已变化，请刷新后重试');
    if(!owner && changes.status==='cancelled' && (current.leaseUntil??0)>Date.now())throw new ConflictError('任务已被 worker 认领，不能取消排队');
    if (owner && (current.leaseOwner !== owner || (current.leaseUntil ?? 0) <= Date.now())) throw new ConflictError('任务租约已失效');
    const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
    const result=this.db.prepare('UPDATE tasks SET status=?, lease_until=?, next_poll_at=?, data=? WHERE id=? AND data=?').run(next.status,next.leaseUntil,next.nextPollAt,JSON.stringify(next),next.id,JSON.stringify(current));
    if(!result.changes)throw new ConflictError('任务状态已被另一进程更新，请重新读取');
    return next;
  }
  lock(owner: string, now: number, leaseMs: number) {
    return !!this.db.prepare(`INSERT INTO worker_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, lease_until=excluded.lease_until WHERE worker_lock.owner=excluded.owner OR worker_lock.lease_until<=?`).run(owner,now+leaseMs,now).changes;
  }
  releaseLock(owner: string) { this.db.prepare('DELETE FROM worker_lock WHERE owner=?').run(owner); }
  claim(owner: string, leaseMs: number): Task | null {
    const now = Date.now(); this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = (this.db.prepare("SELECT data FROM tasks WHERE status IN ('submitting','running','persisting') ORDER BY rowid LIMIT 1").get() as {data:string} | undefined);
      const row = active ?? this.db.prepare("SELECT data FROM tasks WHERE status='queued' ORDER BY rowid LIMIT 1").get() as {data:string} | undefined;
      let task: Task | null = row ? JSON.parse(row.data) : null;
      if (task && (task.nextPollAt > now || (task.leaseUntil ?? 0) > now)) task = null;
      if (task) {
        // A submit started without a durable remote ID is ambiguous; never submit it again.
        if (task.status === 'submitting' && !task.providerTaskId) { this.update(task,{status:'unknown',error:'worker 在提交期间中断，远端结果未确认；不会自动重新提交',leaseUntil:null,leaseOwner:null}); task = null; }
        else task = this.update(task, { leaseOwner: owner, leaseUntil: now+leaseMs });
      }
      this.db.exec('COMMIT'); return task;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  generations(projectId: string): Generation[] {
    return (this.db.prepare('SELECT data FROM generations WHERE project_id=? ORDER BY rowid DESC').all(projectId) as {data:string}[]).map(r=>JSON.parse(r.data));
  }
  complete(task: Task, assetIds: string[], draft: StoryDraft | null, owner: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.get(task.id).leaseOwner !== owner) throw new ConflictError('任务租约已失效');
      const generation: Generation = {id:randomUUID(),projectId:task.projectId,nodeId:task.nodeId,taskId:task.id,outputAssetIds:assetIds,inputFingerprint:task.inputFingerprint,draft,createdAt:new Date().toISOString()};
      this.db.prepare('INSERT INTO generations VALUES(?,?,?,?)').run(generation.id,task.projectId,task.id,JSON.stringify(generation));
      this.update(task,{status:'succeeded',error:null,leaseUntil:null,leaseOwner:null},owner);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
