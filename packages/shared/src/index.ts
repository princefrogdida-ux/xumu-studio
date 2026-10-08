import { z } from 'zod';

export const PointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const NodeBase = z.object({
  id: z.string().min(1).max(100),
  position: PointSchema,
  width: z.number().min(220).max(1200).default(300),
  height: z.number().min(170).max(1200).default(230),
});
export const TextNodeSchema = NodeBase.extend({
  type: z.literal('text'),
  data: z.object({
    title: z.string().max(120),
    content: z.string().max(30000),
    category: z.enum(['script', 'character', 'scene', 'note']).default('note'),
  }).strict(),
}).strict();
export const GenerationDataSchema = z.object({
  mode: z.enum(['mock', 'real']).optional(),
  title: z.string().max(120), prompt: z.string().max(30000), model: z.string().max(80),
  ratio: z.enum(['16:9', '9:16', '1:1', '3:2', '2:3']), duration: z.number().int().min(1).max(60),
  count: z.number().int().min(1).max(4), shotCount: z.number().int().min(3).max(5),
  scenario: z.enum(['success', 'failure', 'submit-timeout', 'query-timeout', 'invalid-draft']),
  shotId: z.string().nullable(), selectedGenerationId: z.string().uuid().nullable(), selectedAssetId: z.string().uuid().nullable(),
}).strict();
export const NodeSchema = z.discriminatedUnion('type', [TextNodeSchema,
  NodeBase.extend({ type: z.literal('reference'), data: z.object({ referenceId: z.string().min(1) }).strict() }).strict(),
  NodeBase.extend({ type: z.literal('shot'), data: z.object({ shotId: z.string().min(1) }).strict() }).strict(),
  NodeBase.extend({ type: z.literal('media'), data: z.object({ assetId: z.string().uuid(), mediaType: z.enum(['image', 'video']) }).strict() }).strict(),
  ...(['script', 'imageGenerate', 'videoGenerate'] as const).map(type => NodeBase.extend({ type: z.literal(type), data: GenerationDataSchema }).strict()),
]);
export const ReferenceSchema = z.object({
  id: z.string().min(1).max(100), kind: z.enum(['character', 'scene']), name: z.string().max(120),
  description: z.string().max(10000), assetIds: z.array(z.string().uuid()).max(20), selectedAssetId: z.string().uuid().nullable(),
}).strict();
export const ShotSchema = z.object({
  id: z.string().min(1).max(100), number: z.string().max(40), order: z.number().int().nonnegative(),
  title: z.string().max(120), sceneId: z.string().nullable(), characterIds: z.array(z.string()).max(50),
  description: z.string().max(10000), framing: z.string().max(120), action: z.string().max(4000),
  camera: z.string().max(1000), dialogue: z.string().max(10000), duration: z.number().min(0.1).max(600),
  imagePrompt: z.string().max(10000), videoPrompt: z.string().max(10000),
  selectedImageAssetId: z.string().uuid().nullable().default(null), selectedVideoAssetId: z.string().uuid().nullable().default(null),
}).strict();
export const EdgeSchema = z.object({
  id: z.string().min(1).max(100),
  source: z.string(), target: z.string(),
  sourceHandle: z.enum(['text-out', 'image-out', 'video-out', 'image-prompt', 'video-prompt']),
  targetHandle: z.enum(['text-in', 'image-in']), inputOrder: z.number().int().nonnegative().optional(),
}).strict();
const DocumentBase = z.object({
  schemaVersion: z.literal(4),
  nodes: z.array(NodeSchema).max(1000),
  edges: z.array(EdgeSchema).max(2000),
  references: z.array(ReferenceSchema).max(200), shots: z.array(ShotSchema).max(500),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(2) }).strict(),
}).strict();
const DocumentV3 = DocumentBase.superRefine((doc, ctx) => {
  const ids = new Set<string>();
  for (const node of doc.nodes) {
    if (ids.has(node.id)) ctx.addIssue({ code: 'custom', message: '节点 ID 重复' });
    ids.add(node.id);
  }
  for (const [items, label] of [[doc.references, '角色/场景'], [doc.shots, '分镜']] as const) {
    if (new Set(items.map(x => x.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: `${label} ID 重复` });
  }
  if (new Set(doc.shots.map(s => s.order)).size !== doc.shots.length) ctx.addIssue({ code: 'custom', message: '分镜排序重复' });
  for (const ref of doc.references) {
    if (new Set(ref.assetIds).size !== ref.assetIds.length || ref.selectedAssetId && !ref.assetIds.includes(ref.selectedAssetId))
      ctx.addIssue({ code: 'custom', message: '参考图片选择无效' });
  }
  for (const shot of doc.shots) {
    if (shot.sceneId && !doc.references.some(r => r.id === shot.sceneId && r.kind === 'scene')) ctx.addIssue({ code: 'custom', message: '分镜场景引用无效' });
    if (new Set(shot.characterIds).size !== shot.characterIds.length || shot.characterIds.some(id => !doc.references.some(r => r.id === id && r.kind === 'character')))
      ctx.addIssue({ code: 'custom', message: '分镜角色引用无效' });
  }
  for (const node of doc.nodes) {
    if (node.type === 'shot' && !doc.shots.some(s => s.id === node.data.shotId)) ctx.addIssue({ code: 'custom', message: '分镜记录不存在' });
    if (node.type === 'reference' && !doc.references.some(r => r.id === node.data.referenceId)) ctx.addIssue({ code: 'custom', message: '角色/场景记录不存在' });
    if (isGenerationNode(node) && node.data.shotId && !doc.shots.some(s => s.id === node.data.shotId)) ctx.addIssue({ code: 'custom', message: '生成节点的分镜引用不存在' });
  }
  const seen: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const edge of doc.edges) {
    if (edgeIds.has(edge.id)) ctx.addIssue({ code: 'custom', message: '连线 ID 重复' });
    edgeIds.add(edge.id);
    const error = connectionError(doc.nodes, seen, edge);
    if (error) ctx.addIssue({ code: 'custom', message: error });
    seen.push(edge);
  }
});
// M1 files are validated before being upgraded; unknown schema versions are never reset.
const DocumentV1 = z.object({ schemaVersion: z.literal(1), nodes: z.array(TextNodeSchema).max(1000),
  edges: z.array(EdgeSchema).max(2000), viewport: DocumentV3.shape.viewport }).strict();
const DocumentV2 = DocumentBase.extend({ schemaVersion: z.literal(2) });
const LegacyV3 = DocumentBase.extend({ schemaVersion: z.literal(3) });
export const DocumentSchema = z.preprocess(input => {
  const legacy = DocumentV1.safeParse(input);
  if (legacy.success) return { ...legacy.data, schemaVersion: 4, references: [], shots: [] };
  const v2 = DocumentV2.safeParse(input);
  if (v2.success) return { ...v2.data, schemaVersion: 4 };
  const v3 = LegacyV3.safeParse(input);
  return v3.success ? { ...v3.data, schemaVersion: 4 } : input;
}, DocumentV3);

export type CanvasNode = z.infer<typeof NodeSchema>;
export type CanvasEdge = z.infer<typeof EdgeSchema>;
export type CanvasDocument = z.infer<typeof DocumentSchema>;
export type TextData = z.infer<typeof TextNodeSchema>['data'];
export type Category = TextData['category'];
export type Reference = z.infer<typeof ReferenceSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type GenerationData = z.infer<typeof GenerationDataSchema>;
export type GenerationNode = Extract<CanvasNode, { type: 'script' | 'imageGenerate' | 'videoGenerate' }>;
export function isGenerationNode(node: CanvasNode): node is GenerationNode { return node.type === 'script' || node.type === 'imageGenerate' || node.type === 'videoGenerate'; }
export interface Asset {
  id: string; name: string; mediaType: 'image' | 'video'; mimeType: string; size: number;
  checksum: string; width?: number; height?: number; createdAt: string;
  status: 'ready' | 'missing' | 'damaged';
  source?: 'upload' | 'mock' | 'generated'; generationTaskId?: string;
}
export interface Project {
  id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  document: CanvasDocument;
}
export type ProjectSummary = Omit<Project, 'document'> & { nodeCount: number };

export function emptyDocument(): CanvasDocument {
  return { schemaVersion: 4, nodes: [], edges: [], references: [], shots: [], viewport: { x: 90, y: 110, zoom: 0.85 } };
}

/** Both client and server enforce the same acyclic, single-text-input graph. */
export function connectionError(
  nodes: CanvasNode[], edges: CanvasEdge[],
  candidate: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
): string | null {
  if (!nodes.some(n => n.id === candidate.source) || !nodes.some(n => n.id === candidate.target)) return '连接的节点不存在';
  if (candidate.source === candidate.target) return '不能连接到自身';
  const source = nodes.find(n => n.id === candidate.source)!, target = nodes.find(n => n.id === candidate.target)!;
  const output = outputPorts(source).find(p => p.id === candidate.sourceHandle);
  const input = inputPorts(target).find(p => p.id === candidate.targetHandle);
  if (!output || !input || output.kind !== input.kind) return '端口类型不匹配';
  if (edges.some(e => e.source === candidate.source && e.target === candidate.target && e.sourceHandle === candidate.sourceHandle && e.targetHandle === candidate.targetHandle)) return '这条连线已存在';
  const incoming = edges.filter(e => e.target === candidate.target && e.targetHandle === candidate.targetHandle);
  if (incoming.length >= input.limit) return input.kind === 'text' ? '文本输入只能连接一个上游节点' : `参考图片最多连接 ${input.limit} 个输入`;
  const pending = [candidate.target];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === candidate.source) return '这条连线会形成循环';
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...edges.filter(e => e.source === current).map(e => e.target));
  }
  return null;
}

export function outputPorts(node: CanvasNode): { id: CanvasEdge['sourceHandle']; kind: string; label: string }[] {
  if (node.type === 'text') return [{ id: 'text-out', kind: 'text', label: '文字' }];
  if (node.type === 'shot') return [{ id: 'image-prompt', kind: 'text', label: '图片提示词' }, { id: 'video-prompt', kind: 'text', label: '视频提示词' }];
  if (node.type === 'script') return [];
  if (node.type === 'imageGenerate' || node.type === 'videoGenerate') { const kind = node.type === 'imageGenerate' ? 'image' : 'video'; return [{ id: kind === 'image' ? 'image-out' : 'video-out', kind, label: `选中${kind === 'image' ? '图片' : '视频'}` }]; }
  const kind = node.type === 'media' ? node.data.mediaType : 'image';
  return [{ id: kind === 'image' ? 'image-out' : 'video-out', kind, label: kind === 'image' ? '图片' : '视频' }];
}
export function inputPorts(node: CanvasNode): { id: CanvasEdge['targetHandle']; kind: string; label: string; limit: number }[] {
  if (node.type === 'text') return [{ id: 'text-in', kind: 'text', label: '文字输入', limit: 1 }];
  if (node.type === 'shot') return [{ id: 'text-in', kind: 'text', label: '剧情输入', limit: 1 }, { id: 'image-in', kind: 'image', label: '参考图片', limit: 8 }];
  if (isGenerationNode(node)) return [{ id: 'text-in', kind: 'text', label: '主文字输入', limit: 1 }, ...(node.type === 'script' ? [] : [{ id: 'image-in' as const, kind: 'image', label: node.type === 'videoGenerate' ? '首帧图片' : '参考图片', limit: node.type === 'videoGenerate' ? 1 : 8 }])];
  return [];
}
export function nodeText(doc: CanvasDocument, node: CanvasNode, handle?: string): string {
  if (node.type === 'text') return node.data.content;
  if (node.type === 'shot') { const shot = doc.shots.find(s => s.id === node.data.shotId); return shot ? (handle === 'video-prompt' ? shot.videoPrompt : shot.imagePrompt) : ''; }
  return '';
}
export function newShot(id: string, order: number): Shot {
  return { id, order, number: String(order + 1).padStart(2, '0'), title: `镜头 ${String(order + 1).padStart(2, '0')}`, sceneId: null, characterIds: [],
    description: '', framing: '中景', action: '', camera: '', dialogue: '', duration: 5, imagePrompt: '', videoPrompt: '', selectedImageAssetId: null, selectedVideoAssetId: null };
}
export function referencedAssetIds(doc: CanvasDocument): string[] {
  return [...new Set([...doc.references.flatMap(r => r.assetIds), ...doc.shots.flatMap(s => [s.selectedImageAssetId, s.selectedVideoAssetId].filter((x): x is string => !!x)), ...doc.nodes.flatMap(n => n.type === 'media' ? [n.data.assetId] : isGenerationNode(n) && n.data.selectedAssetId ? [n.data.selectedAssetId] : [])])];
}
export function freePosition(doc: CanvasDocument, origin: { x: number; y: number }) {
  for (let i = 0; i <= doc.nodes.length * 20; i++) {
    const point = { x: origin.x + i % 3 * 380, y: origin.y + Math.floor(i / 3) * 340 };
    if (!doc.nodes.some(n => point.x < n.position.x + n.width + 24 && point.x + 344 > n.position.x && point.y < n.position.y + n.height + 24 && point.y + 324 > n.position.y)) return point;
  }
  return { x: Math.max(origin.x, ...doc.nodes.map(n => n.position.x + n.width)) + 80, y: origin.y };
}

export function duplicateSelection(doc: CanvasDocument, selected: string[], id: () => string): CanvasDocument {
  const mapping = new Map(selected.map(old => [old, id()]));
  const nodes = doc.nodes.filter(n => mapping.has(n.id)).map(n => ({
    ...structuredClone(n), id: mapping.get(n.id)!, position: { x: n.position.x + 48, y: n.position.y + 48 },
  }));
  nodes.forEach(n => { if (isGenerationNode(n)) n.data.selectedGenerationId = null; });
  const edges = doc.edges.filter(e => mapping.has(e.source) && mapping.has(e.target)).map(e => ({
    ...e, id: id(), source: mapping.get(e.source)!, target: mapping.get(e.target)!,
  }));
  return { ...doc, nodes: [...doc.nodes, ...nodes], edges: [...doc.edges, ...edges] };
}

export function storyDocument(id: () => string): CanvasDocument {
  const doc = emptyDocument();
  const items: { category: Category; title: string; content: string }[] = [
    { category: 'script', title: '无尽夏日 · 故事梗概', content: '傍晚，林夏回到多年未去的旧照相馆。\n\n一张泛黄的合照，让她想起那个没有告别的夏天。她推开门，柜台后的人抬起头：\n\n“你终于来了。”' },
    { category: 'character', title: '林夏 · 角色设定', content: '26 岁，短发，穿米白色衬衫。\n\n外表平静，但总会在说话前停顿一下。\n\n角色参考图与跨镜头引用将在下一阶段加入。' },
    { category: 'scene', title: '旧照相馆 · 场景设定', content: '木质柜台、胶片相机、褪色海报。\n\n夕阳穿过百叶窗，细小的尘埃浮在光里。\n\n色调：暖黄、深棕、低饱和。' },
    { category: 'note', title: '镜头 01 · 开场构想', content: '远景 → 缓慢推近。\n\n林夏站在照相馆门前，手里握着旧照片。风吹动她的袖口。\n\n这是文本构思卡；结构化分镜将在 M2 加入。' },
  ];
  doc.nodes = items.map((item, index) => ({ id: id(), type: 'text', position: { x: index < 2 ? 0 : 380, y: index % 2 * 310 }, width: 300, height: 245, data: item }));
  doc.edges = [{ id: id(), source: doc.nodes[0].id, target: doc.nodes[3].id, sourceHandle: 'text-out', targetHandle: 'text-in' }];
  return doc;
}
