import { z } from 'zod';
import { isGenerationNode, newShot, type Asset, type CanvasDocument, type GenerationNode, type Shot } from './index.ts';

export type TaskKind = 'script' | 'image' | 'video';
export type TaskStatus = 'queued' | 'submitting' | 'running' | 'persisting' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export const statusLabels: Record<TaskStatus, string> = { queued: '排队中', submitting: '正在提交', running: '运行中', persisting: '保存结果中', succeeded: '已完成', failed: '已确认失败', unknown: '待确认', cancelled: '已取消' };
export const mockCapabilities = { mode: 'mock', provider: 'mock', configured: true, maxReferences: 8, ratios: ['16:9', '9:16', '1:1'], models: { script: 'mock-script-v1', image: 'mock-image-v1', video: 'mock-video-v1' }, message: '本地模拟，无模型费用。图片为占位画面，视频为固定测试片段；不按提示词生成真实内容。' } as const;
export type ProviderId = 'mock' | 'relay-script' | 'relay-image' | 'relay-video';
export interface ProviderCapability {
  provider: ProviderId; kind: TaskKind; mode: 'mock' | 'real'; model: string; protocol: string;
  configured: boolean; enabled: boolean; serviceId?: string; message: string;
  maxReferences: number; maxCount: number; ratios: string[]; sizes?: Record<string, string>;
  durations: number[]; pollIntervalMs: number;
}
export const mockModels: ProviderCapability[] = (['script','image','video'] as const).map(kind => ({
  provider:'mock',kind,mode:'mock',model:mockCapabilities.models[kind],protocol:'local-mock',configured:true,enabled:true,
  message:mockCapabilities.message,maxReferences:kind==='video'?1:kind==='script'?0:8,maxCount:4,
  ratios:[...mockCapabilities.ratios],durations:[1,2,3,4,5,6,7,8,9,10],pollIntervalMs:1000,
}));
export interface InputSnapshot {
  mode: 'mock' | 'real'; provider: ProviderId; kind: TaskKind; model: string; prompt: string; imageAssetIds: string[];
  serviceId?: string;
  params: { ratio?: string; size?: string; count?: number; duration?: number; shotCount?: number };
  scenario: GenerationNode['data']['scenario'];
}
export const DraftShotSchema = z.object({ title: z.string().min(1).max(120), description: z.string().min(1).max(10000), framing: z.string().min(1).max(120), action: z.string().max(4000), camera: z.string().max(1000), dialogue: z.string().max(10000), duration: z.number().min(.1).max(600), imagePrompt: z.string().min(1).max(10000), videoPrompt: z.string().min(1).max(10000) }).strict();
export const DraftSchema = z.object({ mode: z.enum(['mock','real']), shots: z.array(DraftShotSchema).min(3).max(5) }).strict();
export type StoryDraft = z.infer<typeof DraftSchema>;
export interface Generation { id: string; projectId: string; nodeId: string; taskId: string; outputAssetIds: string[]; inputFingerprint: string; draft: StoryDraft | null; createdAt: string }
export interface Task {
  id: string; projectId: string; nodeId: string; kind: TaskKind; provider: ProviderId; model: string; status: TaskStatus;
  inputSnapshot: InputSnapshot; inputFingerprint: string; requestKey: string; providerTaskId: string | null;
  attempt: number; leaseUntil: number | null; leaseOwner: string | null; nextPollAt: number; error: string | null;
  retryOf: string | null; createdAt: string; updatedAt: string; errorCode?: string | null;
}
export function kindOf(node: GenerationNode): TaskKind { return node.type === 'imageGenerate' ? 'image' : node.type === 'videoGenerate' ? 'video' : 'script'; }
export function nodeAsset(doc: CanvasDocument, nodeId: string): string | null {
  const n = doc.nodes.find(n => n.id === nodeId);
  if (!n) return null;
  if (n.type === 'media') return n.data.assetId;
  if (n.type === 'reference') return doc.references.find(r => r.id === n.data.referenceId)?.selectedAssetId ?? null;
  return isGenerationNode(n) ? n.data.selectedAssetId : null;
}
/** This pure resolver is shared by the UI summary and server. Disk integrity is checked again server-side. */
export function resolveInput(doc: CanvasDocument, nodeId: string, assets: Pick<Asset, 'id' | 'mediaType' | 'status'>[], capabilities: ProviderCapability[] = mockModels): InputSnapshot {
  const node = doc.nodes.find(n => n.id === nodeId);
  if (!node || !isGenerationNode(node)) throw new Error('请选择剧本拆解、图片或视频生成节点');
  const kind = kindOf(node), data = node.data;
  const mode=data.mode??'mock', cap=capabilities.find(c=>c.kind===kind&&c.mode===mode&&c.model===data.model);
  if (!cap?.configured) throw new Error('服务或模型未配置，请先配置服务端并刷新服务状态');
  if(kind!=='script'&&!cap.ratios.includes(data.ratio))throw new Error('当前模型不支持该比例，请选择能力列表中的比例');
  if(kind==='image'&&data.count>cap.maxCount)throw new Error('候选数超过当前模型能力');
  if(kind==='video'&&!cap.durations.includes(data.duration))throw new Error('当前模型不支持该时长');
  const edges = doc.edges.filter(e => e.target === nodeId).sort((a,b) => (a.inputOrder ?? 0) - (b.inputOrder ?? 0) || a.id.localeCompare(b.id));
  const text = edges.find(e => e.targetHandle === 'text-in');
  let base = '';
  if (text) {
    const source = doc.nodes.find(n => n.id === text.source)!;
    if (source.type === 'text') base = source.data.content;
    if (source.type === 'shot') {
      const shot = doc.shots.find(s => s.id === source.data.shotId)!;
      base = text.sourceHandle === 'video-prompt' ? shot.videoPrompt : shot.imagePrompt;
    }
    if (!base.trim()) throw new Error('上游文字为空，请先填写上游内容');
  }
  const prompt = [base.trim(), data.prompt.trim()].filter(Boolean).join('\n\n');
  if (!prompt) throw new Error('请填写提示词或连接有效的上游文字');
  if (prompt.length > 30000) throw new Error('拼接后提示词不能超过 30,000 字符');
  const imageAssetIds = edges.filter(e => e.targetHandle === 'image-in').map(e => {
    const id = nodeAsset(doc, e.source);
    if (!id) throw new Error('上游尚未选中有效图片，请先选择输出版本或参考图');
    return id;
  });
  if (kind === 'video' && imageAssetIds.length !== 1) throw new Error('图生视频需要连接一张已选中的首帧图片');
  if (imageAssetIds.length > cap.maxReferences) throw new Error('参考图片数量超过模型能力；请核实服务的参考图支持配置');
  for (const id of imageAssetIds) if (!assets.some(a => a.id === id && a.mediaType === 'image' && a.status === 'ready')) throw new Error('输入图片不属于当前项目、缺失或损坏，请替换引用');
  return { mode, provider:cap.provider, kind, model: data.model, prompt, imageAssetIds,
    ...(mode==='real'?{serviceId:cap.serviceId}:{}),
    params: kind === 'script' ? { shotCount: data.shotCount } : kind === 'image' ? { ratio: data.ratio, count: data.count, ...(mode==='real'?{size:cap.sizes?.[data.ratio]}:{}) } : { ratio: data.ratio, duration: data.duration }, scenario: mode==='mock'?data.scenario:'success' };
}
export async function fingerprint(input: InputSnapshot): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function selectGeneration(doc: CanvasDocument, generation: Generation, assetId: string, applyShot = false): CanvasDocument {
  const node = doc.nodes.find(n => n.id === generation.nodeId);
  if (!node || !isGenerationNode(node) || !generation.outputAssetIds.includes(assetId)) throw new Error('该结果不属于当前节点');
  const next = structuredClone(doc), selected = next.nodes.find(n => n.id === node.id)! as GenerationNode;
  selected.data.selectedGenerationId = generation.id; selected.data.selectedAssetId = assetId;
  if (applyShot && selected.data.shotId) {
    const shot = next.shots.find(s => s.id === selected.data.shotId);
    if (!shot || selected.type === 'script') throw new Error('请先关联一个分镜');
    if (selected.type === 'imageGenerate') shot.selectedImageAssetId = assetId;
    else shot.selectedVideoAssetId = assetId;
  }
  return next;
}
export function applyDraft(doc: CanvasDocument, draft: StoryDraft, mode: 'append' | 'replace', id: () => string): CanvasDocument {
  const valid = DraftSchema.parse(draft), next = structuredClone(doc);
  if (mode === 'replace') {
    const removed = new Set(next.nodes.filter(n => n.type === 'shot').map(n => n.id));
    next.nodes = next.nodes.filter(n => !removed.has(n.id)); next.edges = next.edges.filter(e => !removed.has(e.source) && !removed.has(e.target));
    next.nodes.forEach(n => { if (isGenerationNode(n)) n.data.shotId = null; }); next.shots = [];
  }
  const start = next.shots.length;
  const shots: Shot[] = valid.shots.map((s,i) => ({ ...newShot(id(), start+i), ...s }));
  next.shots.push(...shots);
  for (const s of shots) next.nodes.push({ id: id(), type: 'shot', position: { x: (s.order % 3) * 380, y: Math.max(0, ...next.nodes.map(n => n.position.y + n.height)) + 60 }, width: 320, height: 300, data: { shotId: s.id } });
  return next;
}
