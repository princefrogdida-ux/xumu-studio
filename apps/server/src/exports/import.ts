import { randomUUID } from 'node:crypto';
import { isGenerationNode, referencedAssetIds, type CanvasDocument } from '../../../../packages/shared/src/index.ts';
import { ProjectTransferSchema, type AssetReference, type ImportResult, type ProjectTransfer } from '../../../../packages/shared/src/transfer.ts';
import { ProjectStore, ValidationError, type StoredAsset } from '../db/store.ts';
import { MediaStore } from '../storage/media.ts';

const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm' };
function assetKinds(doc: CanvasDocument) {
  const kinds = new Map<string, 'image' | 'video'>();
  const add = (id: string, kind: 'image' | 'video') => {
    if (kinds.has(id) && kinds.get(id) !== kind) throw new ValidationError('同一素材被引用为不同媒体类型');
    kinds.set(id, kind);
  };
  doc.references.forEach(r => r.assetIds.forEach(id => add(id, 'image')));
  doc.shots.forEach(s => { if (s.selectedImageAssetId) add(s.selectedImageAssetId, 'image'); if (s.selectedVideoAssetId) add(s.selectedVideoAssetId, 'video'); });
  doc.nodes.forEach(n => {
    if (n.type === 'media') add(n.data.assetId, n.data.mediaType);
    if (isGenerationNode(n) && n.data.selectedAssetId) {
      if (n.type === 'script') throw new ValidationError('剧本节点不能选用媒体');
      add(n.data.selectedAssetId, n.type === 'imageGenerate' ? 'image' : 'video');
    }
  });
  return kinds;
}

export function publicReference(a: StoredAsset): AssetReference {
  return { id: a.id, name: a.name, mediaType: a.mediaType, mimeType: a.mimeType as AssetReference['mimeType'],
    size: a.size, checksum: a.checksum, source: a.source ?? 'upload', createdAt: a.createdAt,
    ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}) };
}

export async function importProject(store: ProjectStore, media: MediaStore, raw: unknown): Promise<ImportResult> {
  const transfer: ProjectTransfer = ProjectTransferSchema.parse(raw), doc = structuredClone(transfer.document);
  const kinds = assetKinds(doc), descriptors = new Map(transfer.assets.map(a => [a.id, a]));
  let known: StoredAsset[] = [];
  if (transfer.sourceProjectId && store.list().some(p => p.id === transfer.sourceProjectId)) known = store.assets(transfer.sourceProjectId);
  const warnings = ['已导入为新项目；任务和生成历史不导入，生成节点的历史版本 ID 已清除。'];
  const mappedAssets = new Map<string, string>(), fresh: StoredAsset[] = [], shared: StoredAsset[] = [], missingAssetIds: string[] = [];
  for (const id of referencedAssetIds(doc)) {
    const desc = descriptors.get(id), kind = kinds.get(id)!;
    if (desc && desc.mediaType !== kind) throw new ValidationError('素材清单类型与项目引用不一致');
    const existing = known.find(a => a.id === id && a.mediaType === kind && (!desc || desc.checksum === a.checksum && desc.size === a.size && desc.mimeType === a.mimeType));
    if (existing) {
      mappedAssets.set(id, id); shared.push(existing);
      if (!await media.verify(existing)) { missingAssetIds.push(id); warnings.push(`素材“${existing.name}”缺失或损坏，请上传后替换引用。`); }
    } else {
      const replacement = randomUUID(); mappedAssets.set(id, replacement); missingAssetIds.push(replacement);
      // A local placeholder preserves editable references. Never fetch an external URL or copy a client path.
      const mime = desc?.mimeType ?? (kind === 'image' ? 'image/png' : 'video/mp4');
      fresh.push({ ...(desc ?? { name: `缺失素材 ${id.slice(0, 8)}`, size: 1, checksum: '0'.repeat(64), source: 'upload', createdAt: new Date().toISOString() }),
        id: replacement, mediaType: kind, mimeType: mime, filename: `${replacement}${extensions[mime]}`, thumbnail: null });
      warnings.push(`外部素材“${desc?.name ?? id}”未包含原文件，已保留缺失引用；请上传后替换。`);
    }
  }
  const nodeIds = new Map(doc.nodes.map(n => [n.id, randomUUID()])), refIds = new Map(doc.references.map(r => [r.id, randomUUID()])), shotIds = new Map(doc.shots.map(s => [s.id, randomUUID()]));
  const asset = (id: string | null) => id ? mappedAssets.get(id)! : null;
  doc.references.forEach(r => { r.id = refIds.get(r.id)!; r.assetIds = r.assetIds.map(id => asset(id)!); r.selectedAssetId = asset(r.selectedAssetId); });
  doc.shots.forEach(s => { s.id = shotIds.get(s.id)!; s.sceneId = s.sceneId ? refIds.get(s.sceneId)! : null; s.characterIds = s.characterIds.map(id => refIds.get(id)!); s.selectedImageAssetId = asset(s.selectedImageAssetId); s.selectedVideoAssetId = asset(s.selectedVideoAssetId); });
  doc.nodes.forEach(n => {
    n.id = nodeIds.get(n.id)!;
    if (n.type === 'reference') n.data.referenceId = refIds.get(n.data.referenceId)!;
    if (n.type === 'shot') n.data.shotId = shotIds.get(n.data.shotId)!;
    if (n.type === 'media') n.data.assetId = asset(n.data.assetId)!;
    if (isGenerationNode(n)) { n.data.selectedGenerationId = null; n.data.selectedAssetId = asset(n.data.selectedAssetId); n.data.shotId = n.data.shotId ? shotIds.get(n.data.shotId)! : null; }
  });
  doc.edges = doc.edges.map(e => ({ ...e, id: randomUUID(), source: nodeIds.get(e.source)!, target: nodeIds.get(e.target)! }));
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const p = store.create(`${transfer.name.slice(0, 110)} · 导入`);
    for (const a of fresh) store.db.prepare('INSERT INTO assets VALUES (?, ?)').run(a.id, JSON.stringify(a));
    for (const a of [...shared, ...fresh]) store.db.prepare('INSERT INTO project_assets VALUES (?, ?)').run(p.id, a.id);
    const project = store.save(p.id, p.revision, doc, p.name);
    store.db.exec('COMMIT'); return { project, warnings, missingAssetIds };
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
