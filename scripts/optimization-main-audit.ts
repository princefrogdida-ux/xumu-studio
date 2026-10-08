import assert from 'node:assert/strict';
import { cpSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ProjectStore } from '../apps/server/src/db/store.ts';

// Explicit local migration audit. Refuse a running main service; never restore or overwrite data.
const root = path.resolve('output/optimization');
const source = path.join(root, 'stopped-data');
const items = JSON.parse(readFileSync(path.join(root, 'stopped-data-hashes.json'), 'utf8').replace(/^\uFEFF/, '')) as { path: string; sha256: string }[];
const digest = async (filename: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
};
for (const port of [4310, 4311]) {
  const listening = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (e: NodeJS.ErrnoException) => e.code === 'ECONNREFUSED' ? resolve(false) : reject(e));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('端口检查超时')); });
  });
  assert.equal(listening, false, '请先停止主服务：' + port);
}
for (const item of items) assert.equal(await digest(path.join(source, item.path)), item.sha256, '备份改变：' + item.path);
const auditCopy = path.join(root, 'main-audit-copy-' + Date.now());
mkdirSync(auditCopy);
cpSync(source, auditCopy, { recursive: true });
const tables = ['projects', 'tasks', 'generations', 'assets', 'project_assets', 'mock_jobs'];
const readTables = (db: DatabaseSync) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const backup = new DatabaseSync(path.join(auditCopy, 'studio.sqlite'), { readOnly: true });
let expected: ReturnType<typeof readTables>;
try { expected = readTables(backup); } finally { backup.close(); }
const original = new DatabaseSync(path.resolve('data/studio.sqlite'), { readOnly: true });
let previousVersion: number;
try {
  previousVersion = (original.prepare('SELECT max(version) AS n FROM migrations').get() as { n: number }).n;
  assert.equal(previousVersion, 4, '此脚本只审计升级前版本 4，禁止重复迁移');
  assert.deepEqual(readTables(original), expected, '原数据与停服务备份不一致');
  assert.equal((original.prepare("SELECT count(*) AS n FROM tasks WHERE status IN ('queued','submitting','running','persisting')").get() as { n: number }).n, 0);
} finally { original.close(); }
const files = items.filter(item => !/^studio\.sqlite(?:-wal|-shm)?$/.test(item.path));
for (const item of files) assert.equal(await digest(path.resolve('data', item.path)), item.sha256, '原文件改变：' + item.path);
const store = new ProjectStore(path.resolve('data/studio.sqlite'));
try {
  assert.deepEqual(readTables(store.db), expected, '迁移改写了业务数据');
  const integrity = store.db.prepare('PRAGMA integrity_check').get();
  assert.equal(Object.values(integrity!)[0], 'ok');
  assert.equal((store.db.prepare('SELECT max(version) AS n FROM migrations').get() as { n: number }).n, 5);
  for (const item of files) assert.equal(await digest(path.resolve('data', item.path)), item.sha256);
  const documents = (expected.projects as { document: string }[]).map(row => JSON.parse(row.document).schemaVersion);
  assert.ok(documents.every(version => version === 4));
  writeFileSync(path.join(root, 'main-migration-audit.json'), JSON.stringify({ at: new Date().toISOString(), previousVersion, databaseVersion: 5, documentVersion: 4, backupFilesVerified: items.length, originalFilesUnchanged: files.length, preservedRows: Object.fromEntries(tables.map(table => [table, expected[table].length])), integrity, paidCalls: 0, restoredOriginalData: false }, null, 2));
  console.log('原数据库 4→5；业务表逐行一致；完整备份与非数据库文件校验通过。');
} finally { store.close(); }
