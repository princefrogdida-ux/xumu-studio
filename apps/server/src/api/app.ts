import Fastify from 'fastify';
import { z } from 'zod';
import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DocumentSchema } from '../../../../packages/shared/src/index.ts';
import { ConflictError, NotFoundError, ValidationError, ProjectStore } from '../db/store.ts';
import { MediaStore, MAX_UPLOAD, byteRange } from '../storage/media.ts';
import { TaskService } from '../tasks/service.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { MAX_IMPORT_BYTES } from '../../../../packages/shared/src/transfer.ts';
import { importProject } from '../exports/import.ts';
import { ExportService, ExportIncompleteError } from '../exports/service.ts';
import { TaskQuery } from '../tasks/query.ts';
import { health } from '../health.ts';
import { randomUUID } from 'node:crypto';

const NameSchema = z.string().trim().min(1).max(120);
const CreateSchema = z.object({ name: NameSchema, template: z.enum(['empty', 'story']).default('empty') }).strict();
const SaveSchema = z.object({ revision: z.number().int().nonnegative(), name: NameSchema, document: DocumentSchema }).strict();
const Params = z.object({ id: z.string().uuid() });

export function createApp(store: ProjectStore, webDist?: string, mediaRoot = path.resolve('data/media'), providers?:ProviderRegistry) {
  const app = Fastify({ bodyLimit: 2 * 1024 * 1024, logger: false, genReqId: () => randomUUID() });
  const media = new MediaStore(mediaRoot, store);
  const taskService = new TaskService(store, media,providers);
  const exports = new ExportService(store, media, path.resolve(mediaRoot, '../exports'));
  const queries = new TaskQuery(store);
  app.addHook('onReady', async () => exports.recoverInterrupted());
  app.addHook('onClose', async () => exports.drain());
  app.addContentTypeParser(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'application/octet-stream'], { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    const origin = request.headers.origin;
    const allowedOrigins = new Set([`http://127.0.0.1:${process.env.STUDIO_WEB_PORT ?? 4310}`, `http://localhost:${process.env.STUDIO_WEB_PORT ?? 4310}`, `http://127.0.0.1:${process.env.PORT ?? 4311}`, `http://localhost:${process.env.PORT ?? 4311}`]);
    if (origin && !allowedOrigins.has(origin))
      return reply.code(403).send({ code: 'ORIGIN_DENIED', message: '不接受来自其他网站的本地操作。' });
  });
  app.setErrorHandler((error, request, reply) => {
    // Log an allowlist only: never serialize request body, headers, URL/query or the raw exception.
    const operation = request.routeOptions.url ?? 'unknown';
    const parsedId = z.string().uuid().safeParse((request.params as { id?: unknown })?.id);
    const context = parsedId.success ? operation.startsWith('/api/projects/:id') ? { projectId: parsedId.data }
      : operation.startsWith('/api/tasks/:id') ? { taskId: parsedId.data } : {} : {};
    console.error(JSON.stringify({ time: new Date().toISOString(), requestId: request.id, operation: request.routeOptions.url ?? 'unknown', method: request.method,
      ...context,
      code: error instanceof z.ZodError || error instanceof ValidationError ? 'VALIDATION' : error instanceof ConflictError ? 'CONFLICT' : error instanceof NotFoundError ? 'NOT_FOUND' : error instanceof ExportIncompleteError ? 'EXPORT_INCOMPLETE' : 'REQUEST_FAILED' }));
    if (error instanceof ExportIncompleteError) return reply.code(422).send({ code: 'EXPORT_INCOMPLETE', message: error.message, preview: error.preview });
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'VALIDATION', message: error.issues.map(i => i.message).join('；') });
    if (error instanceof ValidationError) return reply.code(400).send({ code: 'VALIDATION', message: error.message });
    if (error instanceof ConflictError) return reply.code(409).send({ code: 'CONFLICT', message: error.message });
    if (error instanceof NotFoundError) return reply.code(404).send({ code: 'NOT_FOUND', message: error.message });
    const known = error as { statusCode?: number; message?: string };
    if (known.statusCode && known.statusCode < 500) return reply.code(known.statusCode).send({ code: 'BAD_REQUEST', message: '请求格式或大小不符合要求。' });
    return reply.code(500).send({ code: 'SERVER_ERROR', message: '服务暂时无法完成操作，请保留草稿并重试。' });
  });
  app.get('/api/health', async () => ({ ...health(store), realCallsEnabled: taskService.providers.capabilities().some(c => c.mode === 'real' && c.enabled), invalidExportRecords: exports.invalidRecords.size }));
  app.get('/api/projects', async () => store.list());
  app.post('/api/projects/import', { bodyLimit: MAX_IMPORT_BYTES }, async (request, reply) =>
    reply.code(201).send(await importProject(store, media, request.body)));
  app.post('/api/projects', async (request, reply) => {
    const input = CreateSchema.parse(request.body);
    return reply.code(201).send(store.create(input.name, input.template));
  });
  app.get('/api/projects/:id', async request => store.get(Params.parse(request.params).id));
  app.put('/api/projects/:id/document', async request => {
    const input = SaveSchema.parse(request.body);
    return store.save(Params.parse(request.params).id, input.revision, input.document, input.name);
  });
  app.post('/api/projects/:id/duplicate', async (request, reply) => reply.code(201).send(store.duplicate(Params.parse(request.params).id)));
  app.get('/api/projects/:id/structure', async request => exports.structure(Params.parse(request.params).id));
  app.get('/api/projects/:id/exports', async request => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().uuid().optional() }).strict().parse(request.query);
    return exports.list(Params.parse(request.params).id, q.limit, q.cursor);
  });
  app.post('/api/projects/:id/exports/preview', async request => (await exports.inspect(Params.parse(request.params).id)).preview);
  app.post('/api/projects/:id/exports', async (request, reply) => {
    const input = z.object({ revision: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), allowPartial: z.boolean().default(false) }).strict().parse(request.body);
    return reply.code(202).send(await exports.create(Params.parse(request.params).id, input.revision, input.fingerprint, input.allowPartial));
  });
  app.get('/api/exports/:id', async request => exports.get(Params.parse(request.params).id));
  app.get('/api/exports/:id/file', async (request, reply) => {
    const { file, job } = await exports.file(Params.parse(request.params).id);
    return reply.type('application/zip').header('Content-Disposition', `attachment; filename="materials-${job.id}.zip"`)
      .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').header('Content-Length', job.size!).send(createReadStream(file));
  });
  app.get('/api/projects/:id/assets', async request => {
    const id = Params.parse(request.params).id; store.get(id);
    return Promise.all(store.assets(id).map(asset => media.inspect(asset)));
  });
  app.get('/api/projects/:id/assets/:assetId', async request => {
    const p = z.object({ id: z.string().uuid(), assetId: z.string().uuid() }).parse(request.params);
    const asset = store.assets(p.id).find(a => a.id === p.assetId);
    if (!asset) throw new NotFoundError('素材不属于当前项目');
    const result = await media.inspect(asset);
    if ((request.query as { verify?: string }).verify === '1' && result.status === 'ready' && !await media.verify(asset)) result.status = 'damaged';
    return result;
  });
  app.post('/api/projects/:id/assets', { bodyLimit: MAX_UPLOAD }, async (request, reply) => {
    const id = Params.parse(request.params).id;
    const { name } = z.object({ name: z.string().min(1).max(180) }).strict().parse(request.query);
    if (!Buffer.isBuffer(request.body)) throw new ValidationError('请上传二进制媒体文件');
    return reply.code(201).send(await media.upload(id, name, request.headers['content-type']?.split(';')[0] ?? '', request.body));
  });
  app.get('/api/assets/:id/:variant', async (request, reply) => {
    const { id, variant } = z.object({ id: z.string().uuid(), variant: z.enum(['file', 'thumbnail']) }).parse(request.params);
    const asset = store.asset(id), status = (await media.inspect(asset)).status;
    if (status !== 'ready') return reply.code(410).send({ code: 'ASSET_UNAVAILABLE', message: `素材“${asset.name}”${status === 'missing' ? '文件缺失' : '文件损坏'}，请重新上传并替换引用。` });
    if (!await media.verify(asset)) return reply.code(410).send({ code: 'ASSET_DAMAGED', message: `素材“${asset.name}”校验失败，请重新上传。` });
    const thumb = variant === 'thumbnail';
    if (thumb && !asset.thumbnail) return reply.code(404).send({ message: '视频使用通用封面，点击播放后加载原文件' });
    const filename = media.file(asset, thumb);
    if (!existsSync(filename)) return reply.code(410).send({ message: '缩略图缺失，请重新上传该素材' });
    const size = (await stat(filename)).size;
    reply.type(thumb ? 'image/webp' : asset.mimeType).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-cache').header('Accept-Ranges', 'bytes');
    const download = (request.query as { download?: string }).download === '1';
    if (download) reply.header('Content-Disposition', `attachment; filename="asset${path.extname(asset.filename)}"; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/'/g, '%27')}`);
    if (request.headers.range) {
      const range = byteRange(request.headers.range, size);
      if (!range) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end - range.start + 1);
      return reply.send(createReadStream(filename, range));
    }
    return reply.header('Content-Length', size).send(createReadStream(filename));
  });
  app.get('/api/providers/capabilities', async () => taskService.providers.publicCapabilities());
  app.get('/api/projects/:id/task-history', async request => queries.history(Params.parse(request.params).id, request.query));
  app.get('/api/projects/:id/task-activity', async request => queries.activity(Params.parse(request.params).id));
  app.get('/api/tasks/:id', async request => taskService.tasks.get(Params.parse(request.params).id));
  app.get('/api/projects/:id/generations/:generationId', async request => {
    const p = z.object({ id: z.string().uuid(), generationId: z.string().uuid() }).parse(request.params);
    return queries.generation(p.id, p.generationId);
  });
  app.get('/api/projects/:id/tasks', async request => { const id=Params.parse(request.params).id;store.get(id);return {tasks:taskService.tasks.list(id),generations:taskService.tasks.generations(id)}; });
  app.post('/api/projects/:id/inputs', async request => {
    const {nodeId}=z.object({nodeId:z.string().min(1).max(100)}).strict().parse(request.body);
    return taskService.preview(Params.parse(request.params).id,nodeId);
  });
  app.post('/api/projects/:id/tasks', async (request,reply) => reply.code(201).send(await taskService.submit(Params.parse(request.params).id,request.body)));
  app.post('/api/tasks/:id/requery', async request => taskService.requery(Params.parse(request.params).id));
  app.post('/api/tasks/:id/cancel', async request => taskService.cancel(Params.parse(request.params).id));
  app.post('/api/tasks/:id/retry', async (request,reply) => {
    const old=taskService.tasks.get(Params.parse(request.params).id);
    return reply.code(201).send(await taskService.submit(old.projectId,request.body,old.id));
  });
  if (webDist && existsSync(path.join(webDist, 'index.html'))) {
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ message: '接口不存在' });
      const { readFile } = await import('node:fs/promises');
      const relative = decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, '');
      const filename = path.resolve(webDist, relative || 'index.html');
      if (!filename.startsWith(path.resolve(webDist) + path.sep)) return reply.code(403).send();
      const target = existsSync(filename) ? filename : path.join(webDist, 'index.html');
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      return reply.type(types[path.extname(target)] ?? 'application/octet-stream').send(await readFile(target));
    });
  }
  return app;
}
