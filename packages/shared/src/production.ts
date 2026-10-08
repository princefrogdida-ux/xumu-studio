import { DocumentSchema, connectionError, freePosition, isGenerationNode, type Asset, type CanvasDocument, type CanvasNode, type GenerationNode } from './index.ts';
import { mockCapabilities } from './generation.ts';

export function prepareShot(doc: CanvasDocument, shotId: string, kind: 'image' | 'video', assets: Asset[], chooseId?: string, uuid = () => crypto.randomUUID()) {
  const shot = doc.shots.find(s => s.id === shotId); if (!shot) throw new Error('分镜记录不存在');
  const type = kind === 'image' ? 'imageGenerate' : 'videoGenerate';
  const existing = doc.nodes.filter(n => n.type === type && n.data.shotId === shotId);
  if (existing.length) {
    const chosen = chooseId ? existing.find(n => n.id === chooseId) : existing.length === 1 ? existing[0] : null;
    if (!chosen) throw new Error('该镜头有多个生成节点，请先明确选择要打开的节点');
    return { document: doc, nodeId: chosen.id, created: false };
  }
  const d = structuredClone(doc), point = freePosition(d, { x: 160, y: 100 });
  const id = uuid(), node: GenerationNode = { id, type, position: point, width: 320, height: 300,
    data: { mode: 'mock', title: `${shot.number} · ${kind === 'image' ? '图片' : '视频'}生成`, prompt: '', model: mockCapabilities.models[kind], ratio: '16:9', duration: Math.max(1, Math.min(10, Math.round(shot.duration))), count: kind === 'image' ? 2 : 1, shotCount: 3, scenario: 'success', shotId, selectedGenerationId: null, selectedAssetId: null } };
  function place(n: CanvasNode) { n.position = freePosition(d, n.position); d.nodes.push(n); return n; }
  const source = d.nodes.find(n => n.type === 'shot' && n.data.shotId === shotId) ?? place({ id: uuid(), type: 'shot', position: point, width: 320, height: 300, data: { shotId } });
  place(node);
  function connect(source: string, sourceHandle: 'image-out' | 'image-prompt' | 'video-prompt', targetHandle: 'text-in' | 'image-in') {
    const c = { source, target: id, sourceHandle, targetHandle }, error = connectionError(d.nodes, d.edges, c);
    if (error) throw new Error(error);
    d.edges.push({ ...c, id: uuid(), inputOrder: d.edges.filter(e => e.target === id).length });
  }
  connect(source.id, kind === 'image' ? 'image-prompt' : 'video-prompt', 'text-in');
  if (kind === 'image') {
    const refs = d.references.filter(r => (shot.sceneId === r.id || shot.characterIds.includes(r.id)) && r.selectedAssetId);
    if (refs.length > 8) throw new Error('参考图超过模拟模型的 8 路限制，请先减少镜头引用');
    for (const ref of refs) {
      const r = d.nodes.find(n => n.type === 'reference' && n.data.referenceId === ref.id) ?? place({ id: uuid(), type: 'reference', position: point, width: 300, height: 280, data: { referenceId: ref.id } });
      connect(r.id, 'image-out', 'image-in');
    }
  } else {
    const asset = assets.find(a => a.id === shot.selectedImageAssetId && a.mediaType === 'image' && a.status === 'ready');
    if (!asset) throw new Error('请先为镜头选用一张可用图片，再准备视频节点');
    const media = d.nodes.find(n => n.type === 'media' && n.data.assetId === asset.id) ?? place({ id: uuid(), type: 'media', position: point, width: 300, height: 280, data: { assetId: asset.id, mediaType: 'image' } });
    connect(media.id, 'image-out', 'image-in');
  }
  return { document: DocumentSchema.parse(d), nodeId: id, created: true };
}

export function affectedReferences(doc: CanvasDocument, id: string): string[] {
  return [
    ...doc.references.filter(r => r.assetIds.includes(id) || r.selectedAssetId === id).map(r => `${r.kind === 'character' ? '角色' : '场景'}：${r.name}`),
    ...doc.shots.filter(s => s.selectedImageAssetId === id || s.selectedVideoAssetId === id).map(s => `分镜：${s.number} ${s.title}`),
    ...doc.nodes.filter(n => n.type === 'media' && n.data.assetId === id || isGenerationNode(n) && n.data.selectedAssetId === id).map(n => `卡片：${'title' in n.data ? n.data.title : n.id.slice(0, 8)}`),
  ];
}
/** Change current editing references only. Historical tasks/generations and the original files stay immutable. */
export function replaceMissingAsset(doc: CanvasDocument, old: Asset, replacement: Asset) {
  if (old.status === 'ready') throw new Error('仅能映射缺失或损坏的素材');
  if (replacement.status !== 'ready' || replacement.mediaType !== old.mediaType || replacement.id === old.id) throw new Error('请选择同类型、可用且属于当前项目的替代素材');
  const d = structuredClone(doc);
  for (const r of d.references) { r.assetIds = [...new Set(r.assetIds.map(id => id === old.id ? replacement.id : id))]; if (r.selectedAssetId === old.id) r.selectedAssetId = replacement.id; }
  for (const s of d.shots) { if (s.selectedImageAssetId === old.id) s.selectedImageAssetId = replacement.id; if (s.selectedVideoAssetId === old.id) s.selectedVideoAssetId = replacement.id; }
  for (const n of d.nodes) {
    if (n.type === 'media' && n.data.assetId === old.id) n.data.assetId = replacement.id;
    if (isGenerationNode(n) && n.data.selectedAssetId === old.id) { n.data.selectedAssetId = replacement.id; n.data.selectedGenerationId = null; }
  }
  return DocumentSchema.parse(d);
}
