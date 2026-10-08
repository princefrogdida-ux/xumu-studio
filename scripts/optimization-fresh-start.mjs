// Uses the successfully installed isolated checkout, its own data and local MockProvider only.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]);
if (!directory.startsWith(path.resolve('output/optimization/clean-install-'))) throw new Error('必须指定本项目已完成的独立安装目录');
const env = { ...process.env, STUDIO_REAL_CALLS_ENABLED: 'false', STUDIO_DATA_DIR: path.join(directory, 'output/m5/case-data'), PORT: '4351' };
const children = ['apps/server/src/index.ts', 'apps/server/src/worker/index.ts'].map(file => spawn(process.execPath, ['--import', 'tsx', file], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
const logs = [];
for (const c of children) for (const stream of [c.stdout, c.stderr]) stream.on('data', bytes => logs.push(bytes.toString()));
const base = 'http://127.0.0.1:4351';
async function json(url, init) { const r = await fetch(base + url, init); assert.ok(r.ok, `${url}: ${r.status}`); return r.json(); }
const report = { node: process.version, cycles: [], paidCalls: 0 };
try {
  for (let i = 0; i < 100; i++) { try { if ((await json('/api/health')).worker.status === 'online') break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const health = await json('/api/health'); assert.equal(health.worker.status, 'online'); assert.equal(health.realCallsEnabled, false);
  const sample = JSON.parse(await readFile(path.join(directory, 'output/m5/sample-report.json'), 'utf8'));
  const project = await json(`/api/projects/${sample.projectId}`), history = await json(`/api/projects/${project.id}/tasks`);
  assert.equal(history.tasks.length, 8); assert.ok(history.tasks.every(t => t.status === 'succeeded'));
  const task = history.tasks[0], input = { nodeId: task.nodeId, requestKey: task.requestKey, revision: project.revision, inputFingerprint: task.inputFingerprint };
  const duplicate = await json(`/api/projects/${project.id}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(duplicate.id, task.id); assert.equal((await json(`/api/projects/${project.id}/tasks`)).tasks.length, 8);
  const zip = await fetch(base + `/api/exports/${sample.job.id}/file`); assert.equal(zip.status, 200); assert.equal((await zip.arrayBuffer()).byteLength, sample.job.size);
  report.cycles.push({ health, projects: (await json('/api/projects')).length, tasks: 8, deduplicated: true, zipBytes: sample.job.size });
} finally {
  for (const child of children) if (child.connected) child.send('shutdown');
  const codes = await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) resolve(child.exitCode); else child.once('exit', resolve); })));
  assert.deepEqual(codes, [0, 0]); report.exitCodes = codes;
  await writeFile(path.join(directory, 'fresh-production.log'), logs.join(''));
  await writeFile(path.join(directory, 'fresh-production.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
