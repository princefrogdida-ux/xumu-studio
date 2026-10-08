import { z } from 'zod';
import { DocumentSchema, type CanvasDocument, type Project } from './index.ts';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const AssetReferenceSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(180), mediaType: z.enum(['image', 'video']),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']),
  size: z.number().int().min(1).max(100 * 1024 * 1024), checksum: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(['upload', 'mock', 'generated']), createdAt: z.string().datetime(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
}).strict().refine(a => a.mimeType.startsWith(a.mediaType + '/'), '素材类型与格式不一致');
export type AssetReference = z.infer<typeof AssetReferenceSchema>;
// Legacy M1–M4 structural snapshots are accepted without trusting any file paths or URLs.
export const ProjectTransferSchema = z.object({
  format: z.literal('drama-studio-structure').optional(), formatVersion: z.literal(1).optional(),
  name: z.string().trim().min(1).max(120), document: DocumentSchema,
  sourceProjectId: z.string().uuid().optional(), assets: z.array(AssetReferenceSchema).max(5000).default([]),
  note: z.string().max(1000).optional(),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.assets.map(a => a.id)).size !== p.assets.length) ctx.addIssue({ code: 'custom', message: '素材 ID 重复' });
});
export type ProjectTransfer = z.infer<typeof ProjectTransferSchema>;
export interface ImportResult { project: Project; warnings: string[]; missingAssetIds: string[] }
export interface ExportIssue { code: string; message: string; shotId?: string; assetId?: string; taskId?: string }
export interface ExportPreview {
  projectId: string; revision: number; fingerprint: string; shotCount: number;
  fileCount: number; totalBytes: number; issues: ExportIssue[];
}
export interface ExportJob {
  id: string; projectId: string; revision: number; status: 'building' | 'succeeded' | 'failed';
  allowPartial: boolean; issues: ExportIssue[]; createdAt: string; completedAt?: string;
  error?: string; size?: number; checksum?: string; sources?: ('upload' | 'mock' | 'generated')[];
}
export const ExportJobSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), revision: z.number().int().nonnegative(),
  status: z.enum(['building', 'succeeded', 'failed']), allowPartial: z.boolean(),
  issues: z.array(z.object({ code: z.string().min(1).max(80), message: z.string().max(2000), shotId: z.string().max(100).optional(), assetId: z.string().uuid().optional(), taskId: z.string().uuid().optional() }).strict()).max(10000),
  createdAt: z.string().datetime(), completedAt: z.string().datetime().optional(), error: z.string().max(2000).optional(),
  size: z.number().int().positive().optional(), checksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sources: z.array(z.enum(['upload', 'mock', 'generated'])).max(3).optional(),
}).strict().superRefine((j, ctx) => {
  if (j.status === 'succeeded' && (!j.size || !j.checksum || !j.completedAt)) ctx.addIssue({ code: 'custom', message: '成功记录缺少完整性信息' });
  if (j.status === 'failed' && (!j.error || !j.completedAt)) ctx.addIssue({ code: 'custom', message: '失败记录缺少诊断' });
});

export function structuralSnapshot(name: string, document: CanvasDocument, assets: AssetReference[], sourceProjectId?: string): ProjectTransfer {
  return ProjectTransferSchema.parse({ format: 'drama-studio-structure', formatVersion: 1, name, document,
    assets, ...(sourceProjectId ? { sourceProjectId } : {}),
    note: '仅项目结构、配置与素材引用；不含媒体原文件、后端任务或生成历史。导入创建新项目，不执行任务。' });
}
