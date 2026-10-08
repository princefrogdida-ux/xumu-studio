// Explicit local verification fixture. Only MockProvider is instantiated; no .env or external API is loaded.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { MediaStore } from '../apps/server/src/storage/media.ts';
import { TaskService } from '../apps/server/src/tasks/service.ts';
import { TaskWorker } from '../apps/server/src/worker/runner.ts';
import { MockProvider } from '../apps/server/src/providers/mock.ts';
import { ExportService } from '../apps/server/src/exports/service.ts';
import { applyDraft, selectGeneration, mockCapabilities } from '../packages/shared/src/generation.ts';
import { emptyDocument, newShot, type GenerationNode, type CanvasNode } from '../packages/shared/src/index.ts';

const dataRoot = path.resolve(process.argv[2] ?? 'output/m5/case-data'), out = path.resolve('output/m5');
mkdirSync(out, { recursive: true });
const store = new ProjectStore(path.join(dataRoot, 'studio.sqlite')), media = new MediaStore(path.join(dataRoot, 'media'), store), service = new TaskService(store, media);
const worker = new TaskWorker(service.tasks, new MockProvider(store, 0), media, 0), exports = new ExportService(store, media, path.join(dataRoot, 'exports'));
const initialIds = store.list().map(p => p.id), oldProjects = initialIds.map(id => store.get(id));
if (store.list().some(p => service.tasks.list(p.id).some(t => ['queued', 'submitting', 'running', 'persisting'].includes(t.status)))) {
  store.close(); throw new Error('存在其他未完成任务，请停止服务并确认任务状态后运行本地案例');
}
const title = '雨夜来信 · M5 完整模拟交付';
if (store.list().some(p => p.name === title)) { store.close(); throw new Error('该案例已存在；本脚本不会覆盖或重复创建任务。请使用新的独立数据目录。'); }
const generationNode = (type: GenerationNode['type'], prompt: string, x: number, y: number): GenerationNode => ({
  id: randomUUID(), type, position: { x, y }, width: 320, height: 300,
  data: { mode: 'mock', title: `模拟${type === 'script' ? '剧本拆解' : type === 'imageGenerate' ? '图片' : '视频'}`,
    prompt, model: mockCapabilities.models[type === 'script' ? 'script' : type === 'imageGenerate' ? 'image' : 'video'],
    ratio: '16:9', duration: 5, count: type === 'imageGenerate' ? 2 : 1, shotCount: 3, scenario: 'success', shotId: null, selectedGenerationId: null, selectedAssetId: null },
});
let p = store.create(title);
const generate = async (nodeId: string) => {
  const input = await service.preview(p.id, nodeId), task = await service.submit(p.id, { nodeId, revision: input.revision, inputFingerprint: input.inputFingerprint, requestKey: randomUUID() });
  for (let i = 0; i < 20 && service.tasks.get(task.id).status !== 'succeeded'; i++) { await worker.tick(); service.tasks.update(service.tasks.get(task.id), { nextPollAt: 0 }); }
  assert.equal(service.tasks.get(task.id).status, 'succeeded'); return service.tasks.generations(p.id).find(g => g.taskId === task.id)!;
};
try {
  const script = generationNode('script', '雨夜，林夏走进旧照相馆。她拆开柜台上的信。旧友抬头，两人相视无言。', 0, -400);
  p.document.nodes.push(script); p = store.save(p.id, p.revision, p.document, p.name);
  const draft = (await generate(script.id)).draft!; p = store.get(p.id); p.document = applyDraft(p.document, draft, 'append', randomUUID);
  const ref = await media.upload(p.id, '林夏-本地参考.png', 'image/png', await sharp(Buffer.from('<svg width="320" height="180"><rect width="320" height="180" fill="#514166"/><text x="20" y="92" font-size="22" fill="white">MOCK / LOCAL REFERENCE</text></svg>')).png().toBuffer());
  const cast = randomUUID(), scene = randomUUID();
  p.document.references.push({ id: cast, kind: 'character', name: '林夏', description: '三个镜头共享的模拟角色参考', assetIds: [ref.id], selectedAssetId: ref.id },
    { id: scene, kind: 'scene', name: '旧照相馆', description: '雨夜暖色灯光，模拟设定', assetIds: [ref.id], selectedAssetId: ref.id });
  const refNode: CanvasNode = { id: randomUUID(), type: 'reference', position: { x: -400, y: 0 }, width: 300, height: 230, data: { referenceId: cast } }; p.document.nodes.push(refNode);
  p.document.shots.forEach((s, i) => { s.characterIds = [cast]; s.sceneId = scene; s.number = String(i + 1).padStart(2, '0'); });
  p = store.save(p.id, p.revision, p.document, p.name);
  for (let i = 0; i < 3; i++) {
    const shot = p.document.shots[i], shotNode = p.document.nodes.find(n => n.type === 'shot' && n.data.shotId === shot.id)!;
    const image = generationNode('imageGenerate', '电影构图，本地模拟验证', i * 380, 500); image.data.shotId = shot.id;
    p.document.nodes.push(image); p.document.edges.push({ id: randomUUID(), source: shotNode.id, target: image.id, sourceHandle: 'image-prompt', targetHandle: 'text-in' },
      { id: randomUUID(), source: refNode.id, target: image.id, sourceHandle: 'image-out', targetHandle: 'image-in', inputOrder: 0 });
    p = store.save(p.id, p.revision, p.document, p.name); let g = await generate(image.id);
    if (i === 0) g = await generate(image.id); // Regenerate, then choose a candidate explicitly.
    p = store.get(p.id); p.document = selectGeneration(p.document, g, g.outputAssetIds[i === 0 ? 1 : 0], true);
    const video = generationNode('videoGenerate', '缓慢推进，本地模拟视频', i * 380, 900); video.data.shotId = shot.id;
    p.document.nodes.push(video); p.document.edges.push({ id: randomUUID(), source: shotNode.id, target: video.id, sourceHandle: 'video-prompt', targetHandle: 'text-in' },
      { id: randomUUID(), source: image.id, target: video.id, sourceHandle: 'image-out', targetHandle: 'image-in', inputOrder: 0 });
    p = store.save(p.id, p.revision, p.document, p.name); const vg = await generate(video.id);
    p = store.get(p.id); p.document = selectGeneration(p.document, vg, vg.outputAssetIds[0], true); p = store.save(p.id, p.revision, p.document, p.name);
  }
  // Story order is deliberately different from canvas placement.
  p.document.shots[0].order = 1; p.document.shots[1].order = 0; p = store.save(p.id, p.revision, p.document, p.name);
  const preview = (await exports.inspect(p.id)).preview; assert.equal(preview.issues.length, 0);
  const job = await exports.create(p.id, p.revision, preview.fingerprint, false); await exports.drain();
  const exported = await exports.file(job.id); cpSync(exported.file, path.join(out, '雨夜来信-M5-模拟素材包.zip'));
  writeFileSync(path.join(out, '雨夜来信-M5-结构快照.json'), JSON.stringify(exports.structure(p.id), null, 2));
  const perf = store.create('M5 性能检查 · 100 节点 150 连线'), doc = emptyDocument();
  store.db.prepare('INSERT INTO project_assets VALUES (?, ?)').run(perf.id, ref.id);
  for (let i = 0; i < 20; i++) doc.nodes.push({ id: `text-${i}`, type: 'text', position: { x: i % 10 * 380, y: Math.floor(i / 10) * 340 }, width: 300, height: 230, data: { title: `剧情 ${i}`, content: '本地性能检查，画布操作不会生成任务。', category: 'note' } });
  for (let i = 0; i < 40; i++) {
    doc.references.push({ id: `ref-${i}`, kind: 'character', name: `参考 ${i}`, description: '', assetIds: [ref.id], selectedAssetId: ref.id });
    doc.nodes.push({ id: `ref-node-${i}`, type: 'reference', position: { x: i % 10 * 380, y: 680 + Math.floor(i / 10) * 340 }, width: 300, height: 230, data: { referenceId: `ref-${i}` } });
    doc.shots.push({ ...newShot(`shot-${i}`, i), description: '性能检查分镜' });
    doc.nodes.push({ id: `shot-node-${i}`, type: 'shot', position: { x: i % 10 * 380, y: 2200 + Math.floor(i / 10) * 340 }, width: 300, height: 230, data: { shotId: `shot-${i}` } });
    doc.edges.push({ id: `text-edge-${i}`, source: `text-${i % 20}`, target: `shot-node-${i}`, sourceHandle: 'text-out', targetHandle: 'text-in' });
  }
  for (let i = 0; i < 110; i++) doc.edges.push({ id: `image-edge-${i}`, source: `ref-node-${Math.floor(i / 40)}`, target: `shot-node-${i % 40}`, sourceHandle: 'image-out', targetHandle: 'image-in', inputOrder: Math.floor(i / 40) });
  const start = performance.now(); const savedPerf = store.save(perf.id, perf.revision, doc, perf.name); const saveMs = performance.now() - start;
  for (const old of oldProjects) assert.deepEqual(store.get(old.id), old);
  writeFileSync(path.join(out, 'sample-report.json'), JSON.stringify({ dataRoot, projectId: p.id, name: p.name, tasks: service.tasks.list(p.id).length,
    assets: store.assets(p.id).length, preview, job: await exports.get(job.id), performanceProjectId: savedPerf.id, performanceSaveMs: saveMs,
    baselineProjectsUnchanged: oldProjects.length, paidCalls: 0 }, null, 2));
  console.log(JSON.stringify({ projectId: p.id, tasks: service.tasks.list(p.id).length, performanceProjectId: savedPerf.id, performanceSaveMs: saveMs, archive: 'output/m5/雨夜来信-M5-模拟素材包.zip', paidCalls: 0 }));
} finally { await exports.drain(); store.close(); }

// Verify a complete, stopped-data backup in a separate restore location without replacing the user's data.
function inventory(root: string, prefix = ''): Record<string, string> {
  const items: Record<string, string> = {};
  for (const entry of readdirSync(root)) { const relative = path.join(prefix, entry), file = path.join(root, entry);
    if (statSync(file).isDirectory()) Object.assign(items, inventory(file, relative));
    else items[relative] = createHash('sha256').update(readFileSync(file)).digest('hex'); }
  return items;
}
const backup = path.join(out, 'stopped-data-backup'), restored = path.join(out, 'restored-data');
if (existsSync(backup) || existsSync(restored)) throw new Error('备份/恢复验证目录已存在，拒绝覆盖');
const expected = inventory(dataRoot); cpSync(dataRoot, backup, { recursive: true, errorOnExist: true }); cpSync(backup, restored, { recursive: true, errorOnExist: true });
assert.deepEqual(inventory(restored), expected);
const recovered = new ProjectStore(path.join(restored, 'studio.sqlite'));
try { assert.equal(recovered.get(p.id).document.shots.length, 3); assert.equal(new TaskService(recovered, new MediaStore(path.join(restored, 'media'), recovered)).tasks.list(p.id).length, 8); }
finally { recovered.close(); }
writeFileSync(path.join(out, 'backup-report.json'), JSON.stringify({ backup, restored, fileCount: Object.keys(expected).length, hashesMatched: true, expected }, null, 2));
