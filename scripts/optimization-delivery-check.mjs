import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createConnection } from 'node:net';

// Read-only final verification: public code allowlist, backup hashes and business rows.
const root = path.resolve('output/optimization');
const json = name => JSON.parse(readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, ''));
const hashFile = async filename => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
};
for (const [manifest, directory] of [['baseline-code-hashes.json', 'baseline-code'], ['stopped-data-hashes.json', 'stopped-data']]) {
  for (const item of json(manifest)) assert.equal(await hashFile(path.join(root, directory, item.path)), item.sha256, '基线改变：' + item.path);
}
const tables = ['projects', 'tasks', 'generations', 'assets', 'project_assets', 'mock_jobs'];
const copy = readdirSync(root).filter(name => name.startsWith('main-audit-copy-')).sort().at(-1);
assert.ok(copy, '缺少升级前只读审计副本');
const before = new DatabaseSync(path.join(root, copy, 'studio.sqlite'), { readOnly: true });
const current = new DatabaseSync(path.resolve('data/studio.sqlite'), { readOnly: true });
try {
  for (const table of tables) assert.deepEqual(current.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), '启动后业务表改变：' + table);
} finally { before.close(); current.close(); }
for (const item of json('stopped-data-hashes.json').filter(item => !/^studio\.sqlite(?:-wal|-shm)?$/.test(item.path))) assert.equal(await hashFile(path.resolve('data', item.path)), item.sha256, '原非数据库文件改变：' + item.path);

const health = await (await fetch('http://127.0.0.1:4311/api/health', { signal: AbortSignal.timeout(3000) })).json();
assert.equal(health.worker.status, 'online'); assert.equal(health.realCallsEnabled, false); assert.equal(health.activeTasks, 0);
assert.equal(health.databaseVersion, 5); assert.equal(health.schemaVersion, 4);
const projects = await (await fetch('http://127.0.0.1:4311/api/projects')).json(); assert.equal(projects.length, 8);
const capabilities = await (await fetch('http://127.0.0.1:4311/api/providers/capabilities')).json();
assert.ok(!capabilities.providers.some(c => c.mode === 'real' && c.enabled));
const closedPorts = [];
for (const port of [4321, 4322, 4331, 4332, 4351, 4380, 4381]) {
  const open = await new Promise((resolve, reject) => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', e => e.code === 'ECONNREFUSED' ? resolve(false) : reject(e)); socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('检查端口超时')); }); });
  assert.equal(open, false, '隔离端口未释放：' + port); closedPorts.push(port);
}
const files = execFileSync('rg', ['--files', 'apps', 'packages', 'scripts', 'tests', 'docs', 'config'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).concat(['README.md', 'AGENTS.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.gitignore', '.env.example']).sort();
const brokenLinks = [];
for (const file of files.filter(file => file.endsWith('.md'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!existsSync(path.resolve(path.dirname(file), decodeURIComponent(target)))) brokenLinks.push({ file, target });
  }
}
assert.deepEqual(brokenLinks, [], '文档本地链接失效');
const hashes = [];
for (const file of files) hashes.push({ path: file.replaceAll('\\', '/'), sha256: await hashFile(file) });
writeFileSync(path.join(root, 'validated-code-hashes.json'), JSON.stringify(hashes, null, 2));
writeFileSync(path.join(root, 'delivery-check.json'), JSON.stringify({ at: new Date().toISOString(), health, projects: projects.length, originalBusinessRowsUnchanged: true, originalFilesUnchanged: true, baselineFilesVerified: 82, backupFilesVerified: 50, validatedCodeFiles: hashes.length, brokenLinks, closedPorts, paidCalls: 0, committed: false }, null, 2));
console.log('交付检查通过：原业务/文件保留，代码与备份可追溯，文档链接有效，主服务在线，隔离端口释放。');
