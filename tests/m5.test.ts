import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { MediaStore } from '../apps/server/src/storage/media.ts';
import { ExportService, ExportIncompleteError, csvCell } from '../apps/server/src/exports/service.ts';
import { importProject } from '../apps/server/src/exports/import.ts';
import { createApp } from '../apps/server/src/api/app.ts';
import { newShot, type GenerationNode } from '../packages/shared/src/index.ts';
import type { ImportResult, ExportPreview, ExportJob } from '../packages/shared/src/transfer.ts';
import { TaskService } from '../apps/server/src/tasks/service.ts';
import { TaskWorker } from '../apps/server/src/worker/runner.ts';
import { MockProvider } from '../apps/server/src/providers/mock.ts';
import { selectGeneration, mockCapabilities } from '../packages/shared/src/generation.ts';

async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-m5-')), db = path.join(dir, 'studio.sqlite');
  const store = new ProjectStore(db), media = new MediaStore(path.join(dir, 'media'), store), exports = new ExportService(store, media, path.join(dir, 'exports'));
  let p = store.create('雨夜来信 · M5');
  const image = await media.upload(p.id, '参考.png', 'image/png', await sharp({ create: { width: 24, height: 24, channels: 3, background: '#986ba5' } }).png().toBuffer());
  const video = await media.upload(p.id, '镜头.mp4', 'video/mp4', readFileSync('apps/server/src/fixtures/mock-video.mp4'));
  p.document.references = [{ id: 'cast', kind: 'character', name: '林夏', description: '共享角色', assetIds: [image.id], selectedAssetId: image.id }];
  p.document.shots = [2, 0, 1].map(order => ({ ...newShot('shot-' + order, order), number: '../CON:重复', title: `镜头 ${order}`, characterIds: ['cast'], dialogue: '=1+1', selectedImageAssetId: image.id, selectedVideoAssetId: video.id }));
  p.document.nodes = p.document.shots.map((s, i) => ({ id: 'node-' + i, type: 'shot', data: { shotId: s.id }, position: { x: i * 350, y: 40 }, width: 300, height: 240 }));
  p = store.save(p.id, p.revision, p.document, p.name);
  return { dir, db, store, media, exports, p, image, video, close: async () => { await exports.drain(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
// Independent central-directory reader verifies each compressed entry, rather than trusting the export manifest.
function unzip(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), files = new Map<string, Buffer>();
  assert.ok(end > 0); const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 20), nameSize = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), start = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
    const dataOffset = start + 30 + bytes.readUInt16LE(start + 26) + bytes.readUInt16LE(start + 28), raw = bytes.subarray(dataOffset, dataOffset + size);
    assert.ok(!files.has(name)); assert.ok(!name.includes('..') && !name.startsWith('/') && !name.includes('\\'));
    files.set(name, method === 8 ? inflateRawSync(raw) : raw); offset += 46 + nameSize + extra + comment;
  }
  return files;
}

test('M5 ZIP contains chosen files for every shot in story order, unique safe paths, reference image and valid CSV', async () => {
  const f = await fixture();
  try {
    const inspected = await f.exports.inspect(f.p.id); assert.equal(inspected.preview.issues.length, 0); assert.equal(inspected.preview.fileCount, 7);
    const job = await f.exports.create(f.p.id, f.p.revision, inspected.preview.fingerprint, false); await f.exports.drain();
    const ready = await f.exports.get(job.id); assert.equal(ready.status, 'succeeded');
    const files = unzip(readFileSync((await f.exports.file(job.id)).file)); assert.equal(files.size, 9);
    const manifest = JSON.parse(files.get('manifest.json')!.toString()); assert.deepEqual(manifest.shots.map((s: { id: string }) => s.id), ['shot-0', 'shot-1', 'shot-2']);
    assert.equal(new Set(manifest.shots.map((s: { video: { path: string } }) => s.video.path)).size, 3);
    for (const entry of manifest.files) assert.equal(createHash('sha256').update(files.get(entry.path)!).digest('hex'), entry.checksum);
    const csv = files.get('storyboard.csv')!.toString(); assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"\'=1+1"')); assert.equal(csv.split('\r\n').length, 5);
    assert.equal(manifest.partial, false); assert.equal(f.store.get(f.p.id).revision, f.p.revision);
  } finally { await f.close(); }
});

test('M5 refuses silent partial exports and detects missing, same-size damaged and unfinished task inputs', async () => {
  const f = await fixture();
  try {
    const p = f.store.get(f.p.id); p.document.shots[0].selectedVideoAssetId = null; f.store.save(p.id, p.revision, p.document, p.name);
    const bytes = readFileSync(f.media.file(f.store.asset(f.image.id))); bytes[bytes.length - 1] ^= 1; writeFileSync(f.media.file(f.store.asset(f.image.id)), bytes);
    const inspect = await f.exports.inspect(p.id); assert.ok(inspect.preview.issues.some(i => i.code === 'VIDEO_NOT_SELECTED')); assert.ok(inspect.preview.issues.some(i => i.code === 'ASSET_UNAVAILABLE'));
    await assert.rejects(f.exports.create(p.id, inspect.preview.revision, inspect.preview.fingerprint, false), ExportIncompleteError);
    const job = await f.exports.create(p.id, inspect.preview.revision, inspect.preview.fingerprint, true); await f.exports.drain();
    const files = unzip(readFileSync((await f.exports.file(job.id)).file)); const manifest = JSON.parse(files.get('manifest.json')!.toString());
    assert.equal(manifest.partial, true); assert.equal(manifest.issues.length, inspect.preview.issues.length); assert.equal(files.size, 4);
    unlinkSync(f.media.file(f.store.asset(f.video.id))); assert.ok((await f.exports.inspect(p.id)).preview.issues.length > inspect.preview.issues.length);
  } finally { await f.close(); }
});

test('M5 preview is invalidated by revisions, version selections and media changes', async () => {
  const f = await fixture();
  try {
    const before = (await f.exports.inspect(f.p.id)).preview;
    f.store.save(f.p.id, f.p.revision, f.p.document, '新名称');
    await assert.rejects(f.exports.create(f.p.id, before.revision, before.fingerprint, false), /重新检查/);
    const next = (await f.exports.inspect(f.p.id)).preview;
    unlinkSync(f.media.file(f.store.asset(f.image.id)));
    await assert.rejects(f.exports.create(f.p.id, next.revision, next.fingerprint, true), /重新检查/);
  } finally { await f.close(); }
});

test('M5 same-store structural import rebuilds all IDs, preserves selections and creates no task', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(f.p.id), snapshot = f.exports.structure(f.p.id), result = await importProject(f.store, f.media, snapshot);
    assert.notEqual(result.project.id, before.id); assert.equal(result.missingAssetIds.length, 0);
    assert.ok(result.project.document.nodes.every(n => !before.document.nodes.some(o => o.id === n.id)));
    assert.ok(result.project.document.shots.every(s => !before.document.shots.some(o => o.id === s.id)));
    assert.equal(result.project.document.shots[0].selectedVideoAssetId, f.video.id);
    assert.equal(result.project.document.shots[0].characterIds[0], result.project.document.references[0].id);
    assert.deepEqual(f.store.get(f.p.id), before); assert.equal(new TaskService(f.store, f.media).tasks.list(result.project.id).length, 0);
    f.store.save(result.project.id, result.project.revision, result.project.document, result.project.name);
  } finally { await f.close(); }
});

test('M5 external and legacy JSON preserve missing media references, remain editable, and never adopt unrelated local assets', async () => {
  const f = await fixture();
  try {
    const snapshot = f.exports.structure(f.p.id); delete snapshot.sourceProjectId;
    const imported = await importProject(f.store, f.media, snapshot); assert.equal(imported.missingAssetIds.length, 2);
    assert.notEqual(imported.project.document.shots[0].selectedImageAssetId, f.image.id);
    for (const a of f.store.assets(imported.project.id)) assert.equal((await f.media.inspect(a)).status, 'missing');
    assert.ok(imported.warnings.some(w => w.includes('未包含原文件')));
    f.store.save(imported.project.id, imported.project.revision, imported.project.document, imported.project.name);
    const old = await importProject(f.store, f.media, { name: 'M1 旧快照', document: { schemaVersion: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } });
    assert.equal(old.project.document.schemaVersion, 4); assert.equal(old.project.document.shots.length, 0);
    snapshot.document.references[0].assetIds.push(randomUUID());
    const bad = structuredClone(snapshot), imageDescriptor = bad.assets.find(a => a.id === f.image.id)!;
    imageDescriptor.mediaType = 'video'; imageDescriptor.mimeType = 'video/mp4';
    await assert.rejects(importProject(f.store, f.media, bad));
  } finally { await f.close(); }
});

test('M5 import API rejects oversized, invalid version, IDs, references, node types, cycles and remote paths without mutation', async () => {
  const f = await fixture(), app = createApp(f.store, undefined, f.media.root);
  try {
    const baseline = f.store.list().length, valid = f.exports.structure(f.p.id);
    const invalid: unknown[] = [ { ...valid, document: { ...valid.document, schemaVersion: 99 } },
      { ...valid, document: { ...valid.document, nodes: [...valid.document.nodes, valid.document.nodes[0]] } },
      { ...valid, document: { ...valid.document, nodes: [{ ...valid.document.nodes[0], type: 'evil' }] } },
      { ...valid, document: { ...valid.document, shots: [{ ...valid.document.shots[0], sceneId: 'nonexistent' }] } },
      { ...valid, assets: [{ ...valid.assets[0], storagePath: 'C:/secret' }] }, { ...valid, assets: [{ ...valid.assets[0], url: 'https://example.com/file?token=secret' }] } ];
    const cycle = structuredClone(valid); cycle.document.nodes = [0, 1].map(i => ({ id: String(i), type: 'text', position: { x: 0, y: 0 }, width: 300, height: 230, data: { title: '', content: '', category: 'note' } }));
    cycle.document.edges = [{ id: 'a', source: '0', target: '1', sourceHandle: 'text-out', targetHandle: 'text-in' }, { id: 'b', source: '1', target: '0', sourceHandle: 'text-out', targetHandle: 'text-in' }]; invalid.push(cycle);
    for (const payload of invalid) assert.equal((await app.inject({ method: 'POST', url: '/api/projects/import', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/import', payload: 'x'.repeat(2 * 1024 * 1024 + 1), headers: { 'content-type': 'application/json' } })).statusCode, 413);
    assert.equal(f.store.list().length, baseline); assert.equal(f.store.assets(f.p.id).length, 2);
    const imported = (await app.inject({ method: 'POST', url: '/api/projects/import', payload: valid })).json<ImportResult>(); assert.ok(imported.project.id);
  } finally { await app.close(); await f.close(); }
});

test('M5 API requires an explicit partial decision, persists export records, and validates ZIP before download', async () => {
  const f = await fixture(); let app = createApp(f.store, undefined, f.media.root);
  try {
    const p = f.store.get(f.p.id); p.document.shots[0].selectedVideoAssetId = null; f.store.save(p.id, p.revision, p.document, p.name);
    const preview = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/exports/preview` })).json<ExportPreview>();
    const payload = { revision: preview.revision, fingerprint: preview.fingerprint, allowPartial: false };
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/exports`, payload })).statusCode, 422);
    const created = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/exports`, payload: { ...payload, allowPartial: true } }); assert.equal(created.statusCode, 202);
    const job = created.json<ExportJob>(); await app.close(); app = createApp(f.store, undefined, f.media.root);
    const status = await app.inject({ method: 'GET', url: `/api/exports/${job.id}` }); assert.equal(status.json<ExportJob>().status, 'succeeded');
    const download = await app.inject({ method: 'GET', url: `/api/exports/${job.id}/file` }); assert.equal(download.statusCode, 200); assert.equal(download.headers['content-type'], 'application/zip');
    assert.ok(unzip(download.rawPayload).has('manifest.json'));
    writeFileSync(path.join(f.dir, 'exports', `${job.id}.zip`), 'damaged');
    assert.equal((await app.inject({ method: 'GET', url: `/api/exports/${job.id}/file` })).statusCode, 400);
  } finally { await app.close(); await f.close(); }
});

test('M5 interrupted export is failed on restart and never auto-rebuilt', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); mkdirSync(f.exports.root, { recursive: true });
    writeFileSync(path.join(f.exports.root, `${id}.json`), JSON.stringify({ id, projectId: f.p.id, revision: f.p.revision, status: 'building', allowPartial: false, issues: [], createdAt: new Date().toISOString() }));
    writeFileSync(path.join(f.exports.root, `${id}.zip.part`), 'incomplete');
    await f.exports.recoverInterrupted(); assert.equal((await f.exports.get(id)).status, 'failed');
    await assert.rejects(f.exports.file(id), /中断/); assert.equal(f.store.assets(f.p.id).length, 2);
  } finally { await f.close(); }
});

test('M5 export of regenerated selected candidate retains fixed provenance and excludes private credentials and other candidates', async () => {
  const f = await fixture();
  try {
    const service = new TaskService(f.store, f.media), worker = new TaskWorker(service.tasks, new MockProvider(f.store, 0), f.media, 0);
    let p = f.store.get(f.p.id); const node: GenerationNode = { id: randomUUID(), type: 'imageGenerate', position: { x: 0, y: 0 }, width: 320, height: 300,
      data: { title: '模拟图', prompt: '雨夜照相馆', model: mockCapabilities.models.image, ratio: '16:9', duration: 5, count: 2, shotCount: 3, scenario: 'success', shotId: p.document.shots[0].id, selectedGenerationId: null, selectedAssetId: null } };
    p.document.nodes.push(node); p = f.store.save(p.id, p.revision, p.document, p.name);
    for (let round = 0; round < 2; round++) {
      const input = await service.preview(p.id, node.id), task = await service.submit(p.id, { nodeId: node.id, requestKey: randomUUID(), revision: input.revision, inputFingerprint: input.inputFingerprint });
      const unfinished = await f.exports.inspect(p.id); assert.ok(unfinished.preview.issues.some(i => i.code === 'TASK_UNFINISHED'));
      for (let i = 0; i < 10 && service.tasks.get(task.id).status !== 'succeeded'; i++) { await worker.tick(); service.tasks.update(service.tasks.get(task.id), { nextPollAt: 0 }); }
      assert.equal(service.tasks.get(task.id).status, 'succeeded');
    }
    const g = service.tasks.generations(p.id)[0]; p = f.store.get(p.id); p.document = selectGeneration(p.document, g, g.outputAssetIds[1], true); p = f.store.save(p.id, p.revision, p.document, p.name);
    const oldTask = service.tasks.get(g.taskId); service.tasks.update(oldTask, { providerTaskId: 'SECRET_REMOTE_ID', error: 'Bearer SECRET_TOKEN https://private.example/?sig=secret' });
    const inspect = await f.exports.inspect(p.id), job = await f.exports.create(p.id, p.revision, inspect.preview.fingerprint, false); await f.exports.drain();
    const entries = unzip(readFileSync((await f.exports.file(job.id)).file)), text = entries.get('manifest.json')!.toString(), manifest = JSON.parse(text);
    const s = manifest.shots.find((s: { id: string }) => s.id === node.data.shotId); assert.equal(s.image.assetId, g.outputAssetIds[1]); assert.equal(s.image.provenance.generationId, g.id);
    assert.equal(s.image.source, 'mock'); assert.equal(s.image.provenance.prompt, '雨夜照相馆'); assert.equal(s.image.provenance.candidateIndex, 1);
    assert.ok(!text.includes('SECRET') && !text.includes('private.example') && !text.includes('providerTaskId'));
    assert.ok(!manifest.files.some((a: { assetId: string }) => a.assetId === g.outputAssetIds[0]));
    const imported = await importProject(f.store, f.media, f.exports.structure(p.id)); assert.equal((imported.project.document.nodes.find(n => n.type === 'imageGenerate') as GenerationNode).data.selectedGenerationId, null);
  } finally { await f.close(); }
});

test('M5 CSV formulas, control characters and quoted multiline text are handled safely', () => {
  for (const value of ['=cmd()', '+1', '-1', '@sum()', ' \t=1', '\n=1']) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('你好,"世界"\n下一行'), '"你好,""世界""\n下一行"');
});
