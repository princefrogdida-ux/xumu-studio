import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

// Only synthetic/in-memory tasks are created. No provider submission or user data mutation.
process.env.STUDIO_REAL_CALLS_ENABLED = 'false';
const baseline = process.argv.includes('--baseline');
const runLabel = process.argv.find(value => value.startsWith('--run='))?.slice(6);
const root = path.resolve(baseline ? 'output/optimization/baseline-code' : '.');
const moduleAt = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const { ProjectStore } = await moduleAt('apps/server/src/db/store.ts');
const { TaskStore } = await moduleAt('apps/server/src/tasks/store.ts');
const { createApp } = await moduleAt('apps/server/src/api/app.ts');
const { useEditor } = await moduleAt('apps/web/src/features/canvas/editor-store.ts');
const snapshots = JSON.parse(readFileSync('output/optimization/before-projects-tasks.json', 'utf8').replace(/^\uFEFF/, ''));
const sample = snapshots.find((s: { project: { document: { nodes: unknown[] } } }) => s.project.document.nodes.length === 100).project;
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const geometry = [];
for (let run = 0; run < 3; run++) {
  useEditor.getState().load(sample);
  useEditor.getState().begin();
  const values = [];
  for (let i = 0; i < 300; i++) {
    const s = useEditor.getState(), id = s.doc.nodes[0].id;
    const start = performance.now();
    if (!baseline && s.geometry) s.geometry([{ id, position: { x: i, y: i } }]);
    else s.update((d: typeof sample.document) => ({ ...d, nodes: d.nodes.map((n: { id: string }) => n.id === id ? { ...n, position: { x: i, y: i } } : n) }), false);
    values.push(performance.now() - start);
  }
  useEditor.getState().end();
  geometry.push({ medianMs: percentile(values, .5), p95Ms: percentile(values, .95) });
}
const store = new ProjectStore(':memory:'), project = store.create('隔离历史性能夹具'), tasks = new TaskStore(store);
const input = { mode: 'mock', provider: 'mock', kind: 'script', model: 'mock-script-v1', prompt: '测试'.repeat(2000), imageAssetIds: [], params: { shotCount: 3 }, scenario: 'success' };
for (let i = 0; i < 1000; i++) { const t = tasks.create(project.id, 'bench-node', 'key-' + i, input, 'a'.repeat(64), null); tasks.update(t, { status: 'succeeded' }); }
const app = createApp(store, undefined, path.resolve('output/optimization/benchmark-media'));
const history = [];
try {
  await app.ready();
  for (let run = 0; run < (runLabel ? 21 : 3); run++) {
    const start = performance.now();
    const response = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/${baseline ? 'tasks' : 'task-history'}` });
    const value = response.json();
    history.push({ ms: performance.now() - start, status: response.statusCode, bytes: Buffer.byteLength(response.body), count: value.tasks?.length ?? value.items?.length });
  }
  const report = { baseline, measuredAt: new Date().toISOString(), nodeVersion: process.version,
    machine: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemory: os.totalmem() },
    nodes: sample.document.nodes.length, edges: sample.document.edges.length, taskCount: 1000, geometry, history,
    historyWarm: history.length > 1 ? { medianMs: percentile(history.slice(1).map(item => item.ms), .5), p95Ms: percentile(history.slice(1).map(item => item.ms), .95) } : null,
    memory: process.memoryUsage() };
  mkdirSync('output/optimization', { recursive: true });
  writeFileSync(`output/optimization/${baseline ? 'baseline' : 'optimized'}-benchmark${runLabel ? `-run-${runLabel}` : ''}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); store.close(); }
