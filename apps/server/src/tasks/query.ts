import { z } from 'zod';
import type { Generation } from '../../../../packages/shared/src/generation.ts';
import { taskErrorCode, type TaskSummary, type HistoryPage } from '../../../../packages/shared/src/task-query.ts';
import { NotFoundError, ValidationError, type ProjectStore } from '../db/store.ts';

export const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(1000).optional(), nodeId: z.string().min(1).max(100).optional() }).strict();
const Cursor = z.object({ projectId: z.string().uuid(), nodeId: z.string().nullable(), snapshot: z.number().int().nonnegative(), before: z.number().int().positive() }).strict();
const summaryColumns = `t.rowid AS ordinal,t.id,t.project_id AS projectId,t.node_id AS nodeId,t.status,
  json_extract(t.data,'$.kind') AS kind,json_extract(t.data,'$.provider') AS provider,json_extract(t.data,'$.model') AS model,
  json_extract(t.data,'$.inputSnapshot.mode') AS mode,json_extract(t.data,'$.inputFingerprint') AS inputFingerprint,
  substr(json_extract(t.data,'$.error'),1,500) AS error,json_extract(t.data,'$.errorCode') AS errorCode,
  json_extract(t.data,'$.createdAt') AS createdAt,json_extract(t.data,'$.updatedAt') AS updatedAt,g.id AS generationId`;
type Row = Omit<TaskSummary, 'actions'> & { ordinal: number };
function summary({ ordinal: _ordinal, ...row }: Row): TaskSummary {
  const errorCode = taskErrorCode(row);
  return { ...row, mode: row.mode ?? 'mock', errorCode, actions: { cancel: row.status === 'queued', requery: row.status === 'unknown' || row.status === 'failed' && errorCode === 'RESULT_SAVE_FAILED' } };
}
export class TaskQuery {
  constructor(private store: ProjectStore) {}
  history(projectId: string, raw: unknown): HistoryPage {
    this.store.get(projectId);
    const q = PageQuery.parse(raw);
    let snapshot = (this.store.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM tasks WHERE project_id=?').get(projectId) as { n: number }).n;
    let before = snapshot + 1;
    if (q.cursor) {
      let c: z.infer<typeof Cursor>;
      try { c = Cursor.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'))); }
      catch { throw new ValidationError('无效的历史分页标识，请刷新历史'); }
      if (c.projectId !== projectId || c.nodeId !== (q.nodeId ?? null) || c.before > c.snapshot + 1) throw new ValidationError('分页标识不属于当前查询');
      snapshot = c.snapshot; before = c.before;
    }
    const rows = this.store.db.prepare(`SELECT ${summaryColumns} FROM tasks t LEFT JOIN generations g ON g.task_id=t.id
      WHERE t.project_id=? AND t.rowid<=? AND t.rowid<? ${q.nodeId ? 'AND t.node_id=?' : ''} ORDER BY t.rowid DESC LIMIT ?`)
      .all(...[projectId, snapshot, before, ...(q.nodeId ? [q.nodeId] : []), q.limit + 1]) as Row[];
    const items = rows.slice(0, q.limit);
    const nextCursor = rows.length > q.limit ? Buffer.from(JSON.stringify({ projectId, nodeId: q.nodeId ?? null, snapshot, before: items.at(-1)!.ordinal })).toString('base64url') : null;
    return { items: items.map(summary), nextCursor, snapshot };
  }
  activity(projectId: string) {
    this.store.get(projectId);
    const activeCount = (this.store.db.prepare("SELECT count(*) AS n FROM tasks WHERE project_id=? AND status IN ('queued','submitting','running','persisting')").get(projectId) as { n: number }).n;
    // One small record per current node, plus up to 100 active records for nodes removed from the canvas.
    const ids = this.store.get(projectId).document.nodes.map(n => n.id);
    const rows = this.store.db.prepare(`SELECT ${summaryColumns} FROM tasks t LEFT JOIN generations g ON g.task_id=t.id WHERE t.rowid IN
      (SELECT max(rowid) FROM tasks WHERE project_id=? AND node_id IN (SELECT value FROM json_each(?)) GROUP BY node_id)
      OR t.rowid IN (SELECT rowid FROM tasks WHERE project_id=? AND status IN ('queued','submitting','running','persisting') ORDER BY rowid DESC LIMIT 100)
      ORDER BY t.rowid DESC`).all(projectId, JSON.stringify(ids), projectId) as Row[];
    return { items: rows.map(summary), activeCount };
  }
  generation(projectId: string, id: string): Generation {
    const row = this.store.db.prepare('SELECT data FROM generations WHERE project_id=? AND id=?').get(projectId, id) as { data: string } | undefined;
    if (!row) throw new NotFoundError('生成版本不存在');
    return JSON.parse(row.data);
  }
}
