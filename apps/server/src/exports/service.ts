import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { referencedAssetIds, type Shot } from '../../../../packages/shared/src/index.ts';
import { ExportJobSchema, structuralSnapshot, type ExportIssue, type ExportJob, type ExportPreview } from '../../../../packages/shared/src/transfer.ts';
import { statusLabels, type Task, type Generation } from '../../../../packages/shared/src/generation.ts';
import { ConflictError, NotFoundError, ProjectStore, ValidationError, type StoredAsset } from '../db/store.ts';
import { MediaStore } from '../storage/media.ts';
import { TaskStore } from '../tasks/store.ts';
import { publicReference } from './import.ts';

export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
type FileEntry = { archivePath: string; asset: StoredAsset };
type Inspection = { preview: ExportPreview; files: FileEntry[]; manifest: ReturnType<ExportService['manifest']>; csv: string };
export class ExportIncompleteError extends Error {
  constructor(readonly preview: ExportPreview) { super('素材包存在缺失项。请检查清单，或明确选择仅导出已有素材。'); }
}
export function safeSegment(text: string) {
  const clean = text.normalize('NFKC').replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').replace(/\.+/g, '_').replace(/[\s.]+$/g, '').slice(0, 50);
  return clean || '未编号';
}
/** Quote every cell, and neutralize spreadsheet formulas while leaving manifest text exact. */
export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${(/^[\s\uFEFF]*[=+@-]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
}

export class ExportService {
  private pending = new Set<Promise<void>>();
  private failedWrites = new Map<string, ExportJob>();
  private tasks: TaskStore;
  private busy = false;
  readonly invalidRecords = new Set<string>();
  constructor(private store: ProjectStore, private media: MediaStore, readonly root: string) { this.tasks = new TaskStore(store); }
  structure(projectId: string) {
    const p = this.store.get(projectId), used = new Set(referencedAssetIds(p.document));
    return structuralSnapshot(p.name, p.document, this.store.assets(projectId).filter(a => used.has(a.id)).map(publicReference), p.id);
  }
  private provenance(asset: StoredAsset) {
    if (!asset.generationTaskId) return null;
    const row = this.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(asset.generationTaskId) as { data: string } | undefined;
    if (!row) return null;
    const task: Task = JSON.parse(row.data), s = task.inputSnapshot;
    const genRow = this.store.db.prepare('SELECT data FROM generations WHERE task_id=?').get(task.id) as { data: string } | undefined;
    const generation: Generation | null = genRow ? JSON.parse(genRow.data) : null;
    // Whitelist public provenance. No receipt, providerTaskId, remote URL, lease or configuration is serialized.
    return { taskId: task.id, generationId: generation?.id ?? null, candidateIndex: asset.outputIndex ?? null,
      mode: s.mode, provider: s.provider, model: s.model, prompt: s.prompt, imageAssetIds: s.imageAssetIds,
      params: { ratio: s.params.ratio, size: s.params.size, count: s.params.count, duration: s.params.duration, shotCount: s.params.shotCount },
      inputFingerprint: task.inputFingerprint, createdAt: task.createdAt };
  }
  manifest(projectId: string, files: FileEntry[], issues: ExportIssue[]) {
    const p = this.store.get(projectId);
    const assetInfo = (id: string | null, archivePath?: string) => {
      if (!id) return null;
      const found = files.find(f => f.asset.id === id && (!archivePath || f.archivePath === archivePath));
      if (!found) return { assetId: id, unavailable: true };
      const a = found.asset;
      return { assetId: a.id, path: found.archivePath, name: a.name, mediaType: a.mediaType, mimeType: a.mimeType,
        size: a.size, checksum: a.checksum, source: a.source ?? 'upload', provenance: this.provenance(a) };
    };
    return { format: 'drama-studio-materials', formatVersion: 1,
      project: { id: p.id, name: p.name, revision: p.revision, schemaVersion: p.document.schemaVersion },
      note: '有序素材包，不是剪辑成片或完整数据库备份。mock 来源为本地模拟；upload 为用户上传；generated 为接口产出，模型效果需另行验收。',
      issues, shots: [...p.document.shots].sort((a, b) => a.order - b.order).map((s, index) => {
        const base = `shots/${String(index + 1).padStart(3, '0')}_${safeSegment(s.number)}_${createHash('sha256').update(s.id).digest('hex').slice(0, 10)}`;
        return { sequence: index + 1, ...s,
          image: assetInfo(s.selectedImageAssetId, files.find(f => f.archivePath.startsWith(base + '/') && f.asset.mediaType === 'image')?.archivePath),
          video: assetInfo(s.selectedVideoAssetId, files.find(f => f.archivePath.startsWith(base + '/') && f.asset.mediaType === 'video')?.archivePath) };
      }), references: p.document.references.map(r => ({ ...r, assets: r.assetIds.map(id => assetInfo(id, files.find(f => f.archivePath.startsWith('references/') && f.asset.id === id)?.archivePath)) })),
      files: files.map(f => assetInfo(f.asset.id, f.archivePath)),
    };
  }
  async inspect(projectId: string): Promise<Inspection> {
    const p = this.store.get(projectId), issues: ExportIssue[] = [], files: FileEntry[] = [];
    const assets = new Map(this.store.assets(projectId).map(a => [a.id, a])), checked = new Map<string, boolean>();
    const add = async (id: string, archivePath: string, shot?: Shot) => {
      const a = assets.get(id);
      if (!checked.has(id)) checked.set(id, !!a && (await this.media.inspect(a)).status === 'ready' && await this.media.verify(a));
      if (!checked.get(id)) {
        issues.push({ code: 'ASSET_UNAVAILABLE', message: `${shot ? `镜头 ${shot.number}：` : ''}素材“${a?.name ?? id}”缺失或校验失败`, assetId: id, ...(shot ? { shotId: shot.id } : {}) });
        return;
      }
      if (!files.some(f => f.archivePath === archivePath)) files.push({ archivePath, asset: a! });
    };
    const shots = [...p.document.shots].sort((a, b) => a.order - b.order);
    if (!shots.length) issues.push({ code: 'NO_SHOTS', message: '项目没有分镜，无法形成按镜头组织的交付。' });
    for (const [index, s] of shots.entries()) {
      const base = `shots/${String(index + 1).padStart(3, '0')}_${safeSegment(s.number)}_${createHash('sha256').update(s.id).digest('hex').slice(0, 10)}`;
      for (const [id, kind] of [[s.selectedImageAssetId, 'image'], [s.selectedVideoAssetId, 'video']] as const) {
        if (!id) {
          issues.push({ code: kind === 'video' ? 'VIDEO_NOT_SELECTED' : 'IMAGE_NOT_SELECTED', message: `镜头 ${s.number || index + 1}“${s.title}”未选用${kind === 'video' ? '视频' : '图片'}`, shotId: s.id });
          continue;
        }
        const a = assets.get(id);
        if (a && a.mediaType !== kind) throw new ValidationError('镜头选用素材类型无效');
        await add(id, `${base}/${path.posix.basename(base)}_${kind}${a ? path.extname(a.filename) : ''}`, s);
      }
    }
    const referenceIds = new Set(p.document.references.flatMap(r => r.assetIds));
    for (const id of referenceIds) { const a = assets.get(id); await add(id, `references/${id}${a ? path.extname(a.filename) : ''}`); }
    for (const t of this.tasks.list(projectId)) if (['queued', 'submitting', 'running', 'persisting', 'unknown'].includes(t.status))
      issues.push({ code: 'TASK_UNFINISHED', message: `任务 ${t.id.slice(0, 8)}（${t.model}）${statusLabels[t.status]}，尚未完成`, taskId: t.id });
    // Media IDs reused in several shots still produce separate numbered files, counted towards the limit.
    const totalBytes = files.reduce((n, f) => n + f.asset.size, 0);
    if (totalBytes > MAX_EXPORT_BYTES) throw new ValidationError('素材包原文件合计超过 1 GiB，请拆分项目后导出');
    const manifest = this.manifest(projectId, files, issues);
    // Capture a consistent revision across asynchronous file checks.
    if (this.store.get(projectId).revision !== p.revision) throw new ConflictError('检查期间项目已更新，请重新检查素材包');
    const fingerprint = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const headers = ['顺序', '镜头编号', '镜头ID', '标题', '场景', '角色', '画面描述', '景别', '动作', '运镜', '对白', '预计时长', '图片提示词', '视频提示词', '图片文件', '视频文件', '图片来源', '视频来源'];
    const rows = manifest.shots.map(s => [s.sequence, s.number, s.id, s.title, p.document.references.find(r => r.id === s.sceneId)?.name,
      s.characterIds.map(id => p.document.references.find(r => r.id === id)?.name ?? id).join(' / '), s.description, s.framing, s.action, s.camera, s.dialogue, s.duration,
      s.imagePrompt, s.videoPrompt, s.image && 'path' in s.image ? s.image.path : '', s.video && 'path' in s.video ? s.video.path : '',
      s.image && 'source' in s.image ? s.image.source : '', s.video && 'source' in s.video ? s.video.source : '']);
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    return { preview: { projectId, revision: p.revision, fingerprint, shotCount: shots.length, fileCount: files.length, totalBytes, issues }, files, manifest, csv };
  }
  async create(projectId: string, revision: number, fingerprint: string, allowPartial: boolean): Promise<ExportJob> {
    if (this.busy) throw new ConflictError('已有素材包正在打包，请完成后再导出');
    this.busy = true;
    try {
      const inspected = await this.inspect(projectId);
      if (inspected.preview.revision !== revision || inspected.preview.fingerprint !== fingerprint) throw new ConflictError('项目或素材状态已变化，请重新检查再导出');
      if (inspected.preview.issues.length && !allowPartial) throw new ExportIncompleteError(inspected.preview);
      const job: ExportJob = { id: randomUUID(), projectId, revision, status: 'building', allowPartial,
        issues: inspected.preview.issues, sources: [...new Set(inspected.files.map(f => f.asset.source ?? 'upload'))], createdAt: new Date().toISOString() };
      await mkdir(this.root, { recursive: true }); await this.saveJob(job);
      const operation = this.build(job, inspected).catch(() => {
        // If even the failure record cannot be written (for example a full disk), keep the API honest without crashing.
        this.failedWrites.set(job.id, { ...job, status: 'failed', error: '打包失败且无法保存状态，请检查磁盘空间后重新导出。', completedAt: new Date().toISOString() });
      }).finally(() => { this.busy = false; this.pending.delete(operation); });
      this.pending.add(operation); return job;
    } catch (error) { this.busy = false; throw error; }
  }
  private async saveJob(job: ExportJob) {
    const filename = path.join(this.root, `${job.id}.json`);
    await writeFile(filename + '.part', JSON.stringify(job)); await rename(filename + '.part', filename);
  }
  private async build(job: ExportJob, inspected: Inspection) {
    const target = path.join(this.root, `${job.id}.zip`), partial = target + '.part', zip = new ZipFile();
    try {
      const completed = pipeline(zip.outputStream, createWriteStream(partial, { flags: 'wx' }));
      zip.on('error', error => (zip.outputStream as Readable).destroy(error));
      // Start consuming immediately; a streaming checksum catches changes after preview as well.
      for (const f of inspected.files) zip.addReadStreamLazy(f.archivePath, { size: f.asset.size, compress: false }, cb => {
        const hash = createHash('sha256');
        const validator = new Transform({
          transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); },
          flush(done) { done(hash.digest('hex') === f.asset.checksum ? null : new Error('asset checksum changed')); },
        });
        const source = createReadStream(this.media.file(f.asset));
        source.on('error', error => validator.destroy(error));
        validator.on('close', () => source.destroy());
        cb(null, source.pipe(validator));
      });
      zip.addBuffer(Buffer.from(inspected.csv, 'utf8'), 'storyboard.csv');
      zip.addBuffer(Buffer.from(JSON.stringify({ ...inspected.manifest, exportedAt: job.createdAt, partial: job.allowPartial && job.issues.length > 0 }, null, 2)), 'manifest.json');
      zip.end(); await completed; await rename(partial, target);
      const checksum = createHash('sha256'); for await (const chunk of createReadStream(target)) checksum.update(chunk);
      await this.saveJob({ ...job, status: 'succeeded', completedAt: new Date().toISOString(), size: (await stat(target)).size, checksum: checksum.digest('hex') });
    } catch {
      (zip.outputStream as Readable).destroy();
      await unlink(partial).catch(() => {}); await unlink(target).catch(() => {});
      await this.saveJob({ ...job, status: 'failed', completedAt: new Date().toISOString(), error: '打包失败：文件可能在打包期间改变或磁盘空间不足。请重新检查；不会自动重试或生成素材。' });
    }
  }
  async recoverInterrupted() {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
      try {
        const job = await this.readJob(name.slice(0, -5));
        if (job.status === 'building') {
          const failed: ExportJob = { ...job, status: 'failed', error: '打包期间服务中断，请重新检查后导出。不会自动重试。', completedAt: new Date().toISOString() };
          try { await this.saveJob(failed); } catch { this.failedWrites.set(job.id, failed); }
        }
      } catch { this.invalidRecords.add(name.slice(0, -5)); }
    }
  }
  private async readJob(id: string): Promise<ExportJob> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid id');
    const file = path.join(this.root, `${id}.json`);
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('record too large');
    const job = ExportJobSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (job.id !== id) throw new Error('id mismatch');
    return job;
  }
  async list(projectId: string, limit = 30, cursor?: string) {
    this.store.get(projectId);
    const jobs: ExportJob[] = [];
    for (const name of await readdir(this.root)) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
      try { const job = await this.get(name.slice(0, -5)); if (job.projectId === projectId) jobs.push(job); }
      catch { this.invalidRecords.add(name.slice(0, -5)); }
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    let remaining = jobs;
    if (cursor) {
      const anchor = jobs.findIndex(j => j.id === cursor);
      if (anchor < 0) throw new ValidationError('导出分页记录不可用，请刷新列表');
      remaining = jobs.slice(anchor + 1);
    }
    const items = remaining.slice(0, limit);
    return { items, nextCursor: remaining.length > limit ? items.at(-1)!.id : null, invalidRecordCount: this.invalidRecords.size };
  }
  async get(id: string): Promise<ExportJob> {
    const failed = this.failedWrites.get(id); if (failed) return failed;
    try { return await this.readJob(id); }
    catch { throw new NotFoundError('导出记录不存在或已损坏，请重新检查后导出'); }
  }
  async file(id: string) {
    const job = await this.get(id);
    if (job.status !== 'succeeded') throw new ConflictError(job.error ?? '素材包尚未完成');
    const file = path.join(this.root, `${id}.zip`), hash = createHash('sha256');
    try { if ((await stat(file)).size !== job.size) throw new ValidationError('素材包文件大小校验失败，请重新导出'); }
    catch (error) { if (error instanceof ValidationError) throw error; throw new NotFoundError('素材包文件缺失，请重新导出'); }
    try { for await (const chunk of createReadStream(file)) hash.update(chunk); }
    catch { throw new NotFoundError('素材包文件缺失，请重新导出'); }
    if (hash.digest('hex') !== job.checksum) throw new ValidationError('素材包文件校验失败，请重新导出');
    return { file, job };
  }
  async drain() { await Promise.all(this.pending); }
}
