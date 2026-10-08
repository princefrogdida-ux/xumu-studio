import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Asset } from '../../../../packages/shared/src/index.ts';
import { ProjectStore, ValidationError, type StoredAsset } from '../db/store.ts';

export const MAX_UPLOAD = 100 * 1024 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;
export class MediaStore {
  constructor(readonly root: string, private store: ProjectStore) {}
  async upload(projectId: string, name: string, mime: string, bytes: Buffer, generated?: { taskId: string; index: number; source?: 'mock' | 'generated' }): Promise<Asset> {
    this.store.get(projectId);
    if (generated) {
      const existing = this.store.assets(projectId).find(a => a.generationTaskId === generated.taskId && a.outputIndex === generated.index);
      if (existing) { if (!await this.verify(existing)) throw new ValidationError('已保存生成结果缺失或损坏，请恢复文件'); return this.publicAsset(existing); }
    }
    if (!name || name.length > 180 || /[\\/\x00-\x1f<>:"|?*]/.test(name) || name.endsWith('.') || name.endsWith(' ')) throw new ValidationError('文件名无效，请使用不含路径和特殊符号的文件名');
    if (!bytes.length || bytes.length > MAX_UPLOAD) throw new ValidationError('视频不得超过 100 MB，文件不能为空');
    const ext = path.extname(name).toLowerCase();
    let kind: 'image' | 'video', width: number | undefined, height: number | undefined, thumbnail: Buffer | undefined;
    const imageFormats: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    if (imageFormats[ext]) {
      if (mime !== imageFormats[ext] || bytes.length > IMAGE_LIMIT) throw new ValidationError('图片格式不匹配或超过 20 MB');
      try {
        const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
        const meta = await image.metadata();
        if (`image/${meta.format}` !== mime || (meta.pages ?? 1) > 1) throw new Error('format');
        width = meta.width; height = meta.height;
        thumbnail = await image.rotate().resize({ width: 640, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      } catch { throw new ValidationError('图片无法解码，仅支持完整的静态 PNG、JPEG、WebP（最多 4000 万像素）'); }
      kind = 'image';
    } else {
      const mp4 = ext === '.mp4' && mime === 'video/mp4' && validMp4(bytes);
      const webm = ext === '.webm' && mime === 'video/webm' && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(0, 4096).includes(Buffer.from('webm'));
      if (!mp4 && !webm) throw new ValidationError('文件内容与格式不匹配。支持 PNG、JPEG、WebP 图片及 MP4、WebM 视频');
      kind = 'video';
    }
    const id = randomUUID(), filename = `${id}${ext}`, thumbnailName = thumbnail ? `${id}.thumb.webp` : null;
    await mkdir(this.root, { recursive: true });
    const created: string[] = [];
    try {
      for (const [file, data] of [[filename, bytes], ...(thumbnail ? [[thumbnailName!, thumbnail]] : [])] as [string, Buffer][]) {
        const target = path.join(this.root, file), temp = `${target}.part`;
        created.push(temp); await writeFile(temp, data, { flag: 'wx' }); await rename(temp, target); created.push(target);
      }
      const asset: StoredAsset = { id, name, mediaType: kind, mimeType: mime, size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex'), width, height, filename, thumbnail: thumbnailName, createdAt: new Date().toISOString(), source: generated ? generated.source??'mock' : 'upload', ...(generated ? { generationTaskId: generated.taskId, outputIndex: generated.index } : {}) };
      this.store.addAsset(projectId, asset);
      return this.publicAsset(asset);
    } catch (error) {
      // Only cleanup files from this failed upload; existing media is never deleted.
      await Promise.all(created.map(file => unlink(file).catch(() => {}))); throw error;
    }
  }
  private publicAsset({ filename: _file, thumbnail: _thumb, outputIndex: _index, ...asset }: StoredAsset, status: Asset['status'] = 'ready'): Asset { return { ...asset, status }; }
  async inspect(asset: StoredAsset): Promise<Asset> {
    try {
      const s = await stat(this.file(asset));
      return this.publicAsset(asset, s.size === asset.size ? 'ready' : 'damaged');
    } catch { return this.publicAsset(asset, 'missing'); }
  }
  file(asset: StoredAsset, thumb = false) {
    const name = thumb ? asset.thumbnail : asset.filename;
    if (!name || path.basename(name) !== name) throw new ValidationError('素材文件路径无效');
    return path.join(this.root, name);
  }
  async verify(asset: StoredAsset): Promise<boolean> {
    try {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.file(asset))) hash.update(chunk);
      return hash.digest('hex') === asset.checksum;
    } catch { return false; }
  }
}

// Validate top-level MP4 boxes; codec support is checked by the browser player.
function validMp4(bytes: Buffer) {
  let offset = 0; const boxes = new Set<string>();
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) { if (offset + 16 > bytes.length) return false; size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
    if (size === 0) size = bytes.length - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length) return false;
    boxes.add(type); offset += size;
  }
  return offset === bytes.length && boxes.has('ftyp') && boxes.has('moov') && boxes.has('mdat');
}

export function byteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || !match[1] && !match[2]) return null;
  let start: number, end: number;
  if (!match[1]) { const length = Number(match[2]); if (!Number.isSafeInteger(length) || length <= 0) return null; start = Math.max(0, size - length); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start ? { start, end } : null;
}
