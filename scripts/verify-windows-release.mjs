import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const runRoot = path.resolve(process.argv[2]);
const allowed = path.resolve('output/releases') + path.sep;
assert.ok(runRoot.startsWith(allowed), '必须指定当前工作区的独立构建目录');
const build = JSON.parse(readFileSync(path.join(runRoot, 'build-result.json'), 'utf8'));
const installed = path.join(runRoot, 'installed-test');
const userDir = path.join(runRoot, 'user-test');
assert.ok(!existsSync(installed), '验证目录已存在，不覆盖');
assert.equal(createHash('sha256').update(readFileSync(build.setup)).digest('hex'), build.sha256);
const installArgs = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=' + installed, '/GROUP=Xumu Studio Release Test ' + Date.now(), '/TASKS='];
const install = spawnSync(build.setup, [...installArgs, '/LOG=' + path.join(runRoot, 'install.log')], { windowsHide: true, timeout: 60000 });
assert.equal(install.status, 0, '安装失败，查看 install.log');
const manifest = JSON.parse(readFileSync(path.join(installed, 'package-manifest.json'), 'utf8'));
for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(path.join(installed, file.path))).digest('hex'), file.sha256, '安装文件改变：' + file.path);
mkdirSync(userDir, { recursive: true });
writeFileSync(path.join(userDir, 'keep.txt'), 'Preserve this user data through uninstall.');
const { emptyDocument, newShot } = await import(pathToFileURL(path.join(installed, 'packages/shared/src/index.js')).href);
const env = { ...process.env, XUMU_USER_DIR: userDir, XUMU_PORT: '4358', XUMU_NO_BROWSER: '1', STUDIO_REAL_CALLS_ENABLED: 'false' };
const node = path.join(installed, 'runtime/node.exe');
const logs = [];
let launcher;
const base = 'http://127.0.0.1:4358';
async function request(route, method = 'GET', body) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `API ${route}: ${response.status}`); return response.json();
}
async function start() {
  launcher = spawn(node, ['launcher.mjs'], { cwd: installed, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [launcher.stdout, launcher.stderr]) stream.on('data', bytes => logs.push(bytes.toString()));
  for (let i = 0; i < 100; i++) {
    try { const health = await request('/api/health'); if (health.worker.status === 'online') { assert.equal(health.realCallsEnabled, false); return health; } } catch {}
    if (launcher.exitCode !== null) throw new Error('运行时启动失败：' + logs.join(''));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('安装版启动超时');
}
async function stop() {
  const current = launcher;
  if (!current || current.exitCode !== null) return;
  const exited = new Promise(resolve => current.once('exit', resolve));
  current.send('shutdown');
  assert.equal(await exited, 0, '安装版收尾失败'); launcher = null;
}
const report = { version: build.version, at: new Date().toISOString(), payloadFilesVerified: manifest.files.length, paidCalls: 0 };
try {
  report.health = await start();
  assert.deepEqual(await request('/api/projects'), []);
  const html = await fetch(base + '/'); assert.equal(html.status, 200); assert.ok((await html.text()).includes('root'));
  let project = await request('/api/projects', 'POST', { name: '安装包独立模拟验证', template: 'empty' });
  const doc = emptyDocument();
  function generation(type) { return { id: randomUUID(), type, position: { x: 0, y: 0 }, width: 320, height: 300, data: { mode: 'mock', title: '安装验证', prompt: '仅本地模拟，不调用真实服务。', model: type === 'imageGenerate' ? 'mock-image-v1' : 'mock-video-v1', ratio: '16:9', duration: 5, count: 1, shotCount: 3, scenario: 'success', shotId: null, selectedGenerationId: null, selectedAssetId: null } }; }
  const image = generation('imageGenerate'); doc.nodes.push(image);
  project = await request(`/api/projects/${project.id}/document`, 'PUT', { name: project.name, revision: project.revision, document: doc });
  async function generate(node) {
    const preview = await request(`/api/projects/${project.id}/inputs`, 'POST', { nodeId: node.id });
    const input = { nodeId: node.id, revision: preview.revision, inputFingerprint: preview.inputFingerprint, requestKey: randomUUID() };
    const task = await request(`/api/projects/${project.id}/tasks`, 'POST', input);
    assert.equal((await request(`/api/projects/${project.id}/tasks`, 'POST', input)).id, task.id);
    for (let i = 0; i < 150; i++) { const current = await request(`/api/tasks/${task.id}`); if (current.status === 'succeeded') return current; assert.ok(!['failed', 'unknown'].includes(current.status), current.error); await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('模拟任务超时');
  }
  const imageTask = await generate(image);
  const history = await request(`/api/projects/${project.id}/tasks`);
  const version = history.generations.find(g => g.taskId === imageTask.id);
  const assetId = version.outputAssetIds[0];
  image.data.selectedGenerationId = version.id; image.data.selectedAssetId = assetId;
  const video = generation('videoGenerate'); doc.nodes.push(video);
  doc.edges.push({ id: randomUUID(), source: image.id, target: video.id, sourceHandle: 'image-out', targetHandle: 'image-in', inputOrder: 0 });
  project = await request(`/api/projects/${project.id}/document`, 'PUT', { name: project.name, revision: project.revision, document: doc });
  const videoTask = await generate(video);
  const videoVersion = (await request(`/api/projects/${project.id}/tasks`)).generations.find(g => g.taskId === videoTask.id);
  video.data.selectedGenerationId = videoVersion.id; video.data.selectedAssetId = videoVersion.outputAssetIds[0];
  doc.shots = [2, 0, 1].map(order => ({ ...newShot(randomUUID(), order), selectedImageAssetId: assetId, selectedVideoAssetId: video.data.selectedAssetId }));
  project = await request(`/api/projects/${project.id}/document`, 'PUT', { name: project.name, revision: project.revision, document: doc });
  const preview = await request(`/api/projects/${project.id}/exports/preview`, 'POST');
  assert.equal(preview.issues.length, 0);
  const exportJob = await request(`/api/projects/${project.id}/exports`, 'POST', { revision: preview.revision, fingerprint: preview.fingerprint, allowPartial: false });
  let ready;
  for (let i = 0; i < 100; i++) { ready = await request(`/api/exports/${exportJob.id}`); if (ready.status === 'succeeded') break; assert.notEqual(ready.status, 'failed', ready.error); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(ready.status, 'succeeded');
  const zipResponse = await fetch(base + `/api/exports/${exportJob.id}/file`); assert.equal(zipResponse.status, 200);
  const zip = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(createHash('sha256').update(zip).digest('hex'), ready.checksum);
  // Read ZIP entries independently to verify actual files, order and checksums.
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.ok(end > 0);
  const entries = new Map(); let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const method = zip.readUInt16LE(offset + 10), size = zip.readUInt32LE(offset + 20), nameSize = zip.readUInt16LE(offset + 28), start = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameSize), dataOffset = start + 30 + zip.readUInt16LE(start + 26) + zip.readUInt16LE(start + 28);
    const raw = zip.subarray(dataOffset, dataOffset + size); entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    offset += 46 + nameSize + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  const exported = JSON.parse(entries.get('manifest.json').toString());
  assert.equal(exported.partial, false); assert.equal(exported.files.length, 6);
  assert.deepEqual(exported.shots.map(shot => shot.id), [...doc.shots].sort((a, b) => a.order - b.order).map(shot => shot.id));
  for (const file of exported.files) assert.equal(createHash('sha256').update(entries.get(file.path)).digest('hex'), file.checksum);
  report.zipMediaFilesVerified = 6; report.zipStoryOrderVerified = true;
  const assetResponse = await fetch(base + `/api/assets/${assetId}/file`); assert.equal(assetResponse.status, 200); assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);
  report.mockTasks = 2; report.requestKeyDeduplicated = true; report.sharpImageAndMockVideo = true;
  const conflict = spawn(node, ['launcher.mjs'], { cwd: installed, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const conflictCode = await new Promise(resolve => conflict.once('exit', resolve)); assert.equal(conflictCode, 1);
  assert.equal((await request('/api/health')).worker.status, 'online'); report.portConflictPreservedRunningApp = true;
  const blockedUpgrade = spawnSync(build.setup, [...installArgs, '/LOG=' + path.join(runRoot, 'upgrade-blocked.log')], { windowsHide: true, timeout: 60000 });
  assert.ok(blockedUpgrade.status !== null && blockedUpgrade.status !== 0, '运行期间应拒绝替换安装');
  assert.equal((await request('/api/health')).worker.status, 'online'); report.upgradeWhileRunningRejected = true;
  await stop();
  const upgrade = spawnSync(build.setup, [...installArgs, '/LOG=' + path.join(runRoot, 'upgrade.log')], { windowsHide: true, timeout: 60000 });
  assert.equal(upgrade.status, 0, '停止后应允许覆盖安装'); report.stoppedUpgradeSucceeded = true;
  await start();
  assert.equal((await request(`/api/projects/${project.id}/tasks`)).tasks.length, 2);
  assert.equal((await request(`/api/projects/${project.id}`)).revision, project.revision);
  await stop(); report.restartPreservedProjectAndTasks = true;
  const uninstall = spawnSync(path.join(installed, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + path.join(runRoot, 'uninstall.log')], { windowsHide: true, timeout: 60000 });
  assert.equal(uninstall.status, 0); assert.ok(!existsSync(path.join(installed, 'runtime/node.exe')));
  assert.equal(readFileSync(path.join(userDir, 'keep.txt'), 'utf8'), 'Preserve this user data through uninstall.');
  assert.ok(existsSync(path.join(userDir, 'data/studio.sqlite'))); report.uninstallPreservedData = true;
} finally {
  await stop(); writeFileSync(path.join(runRoot, 'runtime-test.log'), logs.join(''));
}
writeFileSync(path.join(runRoot, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
