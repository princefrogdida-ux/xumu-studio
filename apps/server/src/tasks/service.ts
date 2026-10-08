import { z } from 'zod';
import { fingerprint, resolveInput, type Task } from '../../../../packages/shared/src/generation.ts';
import { ConflictError, ProjectStore, ValidationError } from '../db/store.ts';
import { MediaStore } from '../storage/media.ts';
import { MockProvider } from '../providers/mock.ts';
import { TaskStore } from './store.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { taskErrorCode } from '../../../../packages/shared/src/task-query.ts';

export const SubmitSchema = z.object({nodeId:z.string().min(1).max(100),requestKey:z.string().uuid(),revision:z.number().int().nonnegative(),inputFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export class TaskService {
  readonly tasks:TaskStore; readonly provider:MockProvider;
  readonly providers:ProviderRegistry;
  constructor(private projects:ProjectStore, private media:MediaStore, providers?:ProviderRegistry) { this.tasks=new TaskStore(projects); this.providers=providers??new ProviderRegistry(projects,media);this.provider=this.providers.mock; }
  async preview(projectId:string,nodeId:string) {
    const project=this.projects.get(projectId),assets=await Promise.all(this.projects.assets(projectId).map(a=>this.media.inspect(a)));
    let input;
    try { input=resolveInput(project.document,nodeId,assets,this.providers.capabilities()); } catch(error) { throw new ValidationError((error as Error).message); }
    for(const id of input.imageAssetIds) if(!await this.media.verify(this.projects.asset(id))) throw new ValidationError('输入图片校验失败，请重新上传或选择其他版本');
    return {revision:project.revision,inputSnapshot:input,inputFingerprint:await fingerprint(input)};
  }
  async submit(projectId:string,raw:unknown,retryOf:string|null=null):Promise<Task> {
    const input=SubmitSchema.parse(raw),existing=this.tasks.byKey(projectId,input.requestKey);
    if(existing) {if(existing.nodeId!==input.nodeId) throw new ConflictError('请求标识已用于其他节点');return existing;}
    if(retryOf) {
      const old=this.tasks.get(retryOf);
      if(old.projectId!==projectId || old.nodeId!==input.nodeId || !['failed','unknown','cancelled'].includes(old.status)) throw new ValidationError('只能明确重试已失败、待确认或已取消的同节点任务');
    }
    const preview=await this.preview(projectId,input.nodeId);
    const capability=this.providers.capabilities().find(c=>c.provider===preview.inputSnapshot.provider&&c.kind===preview.inputSnapshot.kind);
    if(!capability?.enabled)throw new ValidationError(capability?.message??'该服务不可用');
    // Read again after asynchronous file validation to detect concurrent edits.
    if(this.projects.get(projectId).revision!==input.revision || preview.revision!==input.revision || preview.inputFingerprint!==input.inputFingerprint)
      throw new ConflictError('输入或项目版本已变化，请检查新的摘要后再提交');
    return this.tasks.create(projectId,input.nodeId,input.requestKey,preview.inputSnapshot,preview.inputFingerprint,retryOf);
  }
  requery(id:string) {
    const task=this.tasks.get(id);
    if(task.status!=='unknown' && !(task.status==='failed' && taskErrorCode(task)==='RESULT_SAVE_FAILED')) throw new ValidationError('该任务不需要重新查询');
    // Real reconciliation uses only a durable local receipt; never guess or repeat a remote POST.
    const remoteId=task.providerTaskId ?? this.providers.get(task.inputSnapshot).findByKey?.(task.id);
    if(!remoteId) throw new ValidationError('未找到可确认的远端任务；保留待确认状态，请人工核实后再决定重试');
    return this.tasks.update(task,{providerTaskId:remoteId,status:'running',attempt:0,nextPollAt:0,error:null,errorCode:null,leaseUntil:null,leaseOwner:null});
  }
  cancel(id:string) {
    const task=this.tasks.get(id);
    if(task.status!=='queued' || (task.leaseUntil??0)>Date.now()) throw new ValidationError('只能取消尚未被 worker 认领的排队任务');
    return this.tasks.update(task,{status:'cancelled',error:null});
  }
}
