import { randomUUID } from 'node:crypto';
import { DraftSchema, type Task } from '../../../../packages/shared/src/generation.ts';
import { TaskStore } from '../tasks/store.ts';
import { DefiniteError, type Provider } from '../providers/provider.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { MediaStore } from '../storage/media.ts';

export class TaskWorker {
  readonly owner=randomUUID();
  constructor(readonly tasks:TaskStore, readonly provider:Provider|ProviderRegistry, readonly media:MediaStore, private pollMs?:number, private leaseMs=15000) {}
  async tick():Promise<boolean> {
    if(!this.tasks.lock(this.owner,Date.now(),this.leaseMs)) return false;
    let task:Task|null=null;
    try {
      task=this.tasks.claim(this.owner,this.leaseMs); if(!task) return false;
      let provider:Provider|null=null;
      const pollMs=this.pollMs??(this.provider instanceof ProviderRegistry?this.provider.capabilities().find(c=>c.provider===task!.provider&&c.kind===task!.kind)?.pollIntervalMs??5000:1000);
      const heartbeat=setInterval(()=>{
        try { if(task && this.tasks.lock(this.owner,Date.now(),this.leaseMs)) this.tasks.update(task,{leaseUntil:Date.now()+this.leaseMs},this.owner); } catch { /* The next state write detects lost ownership. */ }
      },Math.max(10,Math.floor(this.leaseMs/3)));
      try {
        provider=this.provider instanceof ProviderRegistry?this.provider.get(task.inputSnapshot):this.provider;
        if(task.status==='queued') {
          for(const id of task.inputSnapshot.imageAssetIds) if(!await this.media.verify(this.tasks.projects.asset(id))) throw new Error('输入图片在排队期间缺失或损坏，请替换素材后明确重试');
          task=this.tasks.update(task,{status:'submitting',attempt:0},this.owner);
          const submitted=await provider.submit(task.inputSnapshot,task.id);
          task=this.tasks.update(task,{providerTaskId:submitted.providerTaskId,status:'running',nextPollAt:Date.now()+pollMs,error:null,leaseOwner:null,leaseUntil:null},this.owner);
          return true;
        }
        if(!task.providerTaskId) throw new Error('任务缺少远端 ID，请人工核实');
        const result=await provider.query(task.providerTaskId);
        if(result.status==='running') {this.tasks.update(task,{status:'running',attempt:0,nextPollAt:Date.now()+pollMs,leaseOwner:null,leaseUntil:null},this.owner);return true;}
        if(result.status==='failed') {this.tasks.update(task,{status:'failed',error:result.error,leaseOwner:null,leaseUntil:null},this.owner);return true;}
        task=this.tasks.update(task,{status:'persisting',attempt:task.status==='persisting'?task.attempt:0},this.owner);
        let draft=null;
        if(task.kind==='script') {
          const parsed=DraftSchema.safeParse(result.rawDraft??result.draft);
          if(!parsed.success||parsed.data.mode!==task.inputSnapshot.mode||parsed.data.shots.length!==task.inputSnapshot.params.shotCount) {this.tasks.update(task,{status:'failed',error:`结构化分镜响应无效；原始响应：${JSON.stringify(result.rawDraft??result.draft)?.slice(0,16000)??'空响应'}`,leaseOwner:null,leaseUntil:null},this.owner);return true;}
          draft=parsed.data;
        }
        const assetIds:string[]=[];
        if(task.kind!=='script') for(let i=0;i<(task.kind==='image'?task.inputSnapshot.params.count??1:1);i++) {
          const saved=this.tasks.projects.assets(task.projectId).find(a=>a.generationTaskId===task!.id&&a.outputIndex===i);
          if(saved){if(!await this.media.verify(saved))throw new Error('已保存结果缺失或损坏');assetIds.push(saved.id);continue;}
          const output=await provider.media(task.inputSnapshot,task.id,i);
          const asset=await this.media.upload(task.projectId,output.name,output.mime,output.bytes,{taskId:task.id,index:i,source:task.inputSnapshot.mode==='real'?'generated':'mock'}); assetIds.push(asset.id);
        }
        this.tasks.complete(task,assetIds,draft,this.owner); return true;
      } catch(error) {
        const current=this.tasks.get(task.id);
        if(current.leaseOwner!==this.owner) return false;
        const message=provider?.normalizeError(error)??'服务配置已变化或适配器不可用，请恢复配置后明确重新查询',attempt=current.attempt+1;
        const phase=current.status;
        this.tasks.update(current,{status:phase==='queued'?'failed':phase==='submitting'?(error instanceof DefiniteError?'failed':'unknown'):phase==='persisting'?(attempt>=3?'failed':'persisting'):(attempt>=3?'unknown':'running'),
          attempt,errorCode:phase==='persisting'?'RESULT_SAVE_FAILED':'PROVIDER_ERROR',error:phase==='persisting'?`保存结果失败：${message}；可重新查询，仅重试保存，不重新生成`:message,nextPollAt:Date.now()+pollMs*2**attempt,leaseOwner:null,leaseUntil:null},this.owner);
        return true;
      } finally {clearInterval(heartbeat);}
    } finally {this.tasks.releaseLock(this.owner);}
  }
}
