import type { InputSnapshot, StoryDraft } from '../../../../packages/shared/src/generation.ts';

export type ProviderResult = { status: 'running' } | { status: 'failed'; error: string } | { status: 'succeeded'; draft?: StoryDraft; rawDraft?: unknown };
export interface Provider {
  getCapabilities(): unknown;
  submit(input: InputSnapshot, requestKey: string): Promise<{ providerTaskId: string }>;
  query(providerTaskId: string): Promise<ProviderResult>;
  findByKey?(requestKey: string): string | null;
  media(input: InputSnapshot, taskId: string, index: number): Promise<{name:string;mime:string;bytes:Buffer}>;
  normalizeError(error: unknown): string;
}
export class UncertainError extends Error {}
export class DefiniteError extends Error {}
