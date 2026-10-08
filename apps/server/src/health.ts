import { runtimeInfo } from '../../../packages/shared/src/runtime.ts';
import type { ProjectStore } from './db/store.ts';

export function heartbeat(store: ProjectStore, stopped = false) {
  store.db.prepare('INSERT INTO worker_health VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at,stopped=excluded.stopped').run(Date.now(), stopped ? 1 : 0);
}
export function health(store: ProjectStore) {
  const row = store.db.prepare('SELECT seen_at,stopped FROM worker_health WHERE id=1').get() as { seen_at: number; stopped: number } | undefined;
  const active = store.db.prepare("SELECT count(*) AS n FROM tasks WHERE status IN ('queued','submitting','running','persisting')").get() as { n: number };
  return { ok: true, mode: 'configurable', ...runtimeInfo, now: new Date().toISOString(),
    worker: { status: row?.stopped ? 'stopped' : row && Date.now() - row.seen_at <= 20000 ? 'online' : 'stale', lastSeen: row ? new Date(row.seen_at).toISOString() : null }, activeTasks: active.n };
}
