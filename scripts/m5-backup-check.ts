import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { MediaStore } from '../apps/server/src/storage/media.ts';
import { TaskStore } from '../apps/server/src/tasks/store.ts';

// Input must be an already completed backup of stopped services. Never overwrite live data.
const backup = path.resolve(process.argv[2] ?? 'output/m5-stopped-data');
const restored = path.resolve(process.argv[3] ?? 'output/m5-verified-restore');
if (existsSync(restored)) throw new Error('恢复验证目录已存在，拒绝覆盖');
function inventory(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(root)) {
    const file = path.join(root, name), relative = path.join(prefix, name);
    if (statSync(file).isDirectory()) Object.assign(result, inventory(file, relative));
    else result[relative] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return result;
}
const expected = inventory(backup); cpSync(backup, restored, { recursive: true, errorOnExist: true });
assert.deepEqual(inventory(restored), expected);
const store = new ProjectStore(path.join(restored, 'studio.sqlite')), media = new MediaStore(path.join(restored, 'media'), store), tasks = new TaskStore(store);
try {
  const rows = store.db.prepare('PRAGMA integrity_check').all(); assert.deepEqual(rows, [{ integrity_check: 'ok' }].map(r => Object.assign(Object.create(null), r)));
  let ready = 0, missing = 0;
  const assets = new Map(store.list().flatMap(p => store.assets(p.id)).map(a => [a.id, a]));
  for (const a of assets.values()) if (await media.verify(a)) ready++; else missing++;
  const report = { backup, restored, fileCount: Object.keys(expected).length, hashesMatched: true, integrityCheck: 'ok', projects: store.list().length,
    tasks: store.list().reduce((n, p) => n + tasks.list(p.id).length, 0), assetsReady: ready, assetsUnavailable: missing, expected };
  writeFileSync('output/m5/verified-backup-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, expected: undefined }));
} finally { store.close(); }
