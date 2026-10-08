import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DraftShotSchema, type InputSnapshot, type ProviderCapability } from '../../../../packages/shared/src/generation.ts';
import { ProjectStore } from '../db/store.ts';
import { MediaStore } from '../storage/media.ts';
import type { RelayConfig } from './config.ts';
import { ReceiptStore, type Receipt } from './receipts.ts';
import { downloadRemote, NetworkError, remoteRequest, type NetworkPolicy } from './network.ts';
import { DefiniteError, UncertainError, type Provider, type ProviderResult } from './provider.ts';

const IMAGE_LIMIT=20*1024*1024;
const scriptShape=z.object({shots:z.array(DraftShotSchema).min(3).max(5)}).strict();
const scriptInstructions='将用户剧本拆解为指定数量的中文分镜，只返回 JSON 对象 {"shots":[...]}。每个镜头必须含 title、description、framing、action、camera、dialogue、duration（秒数值）、imagePrompt、videoPrompt，所有文字字段必须是字符串。不要返回 Markdown 或其他字段。';
function getPath(value:unknown,field:string):unknown {for(const key of field.split('.')){if(!value||typeof value!=='object')return undefined;value=(value as Record<string,unknown>)[key];}return value;}
function setPath(object:Record<string,unknown>,field:string,value:unknown){const keys=field.split('.');let parent=object;for(const key of keys.slice(0,-1))parent=(parent[key]??={}) as Record<string,unknown>;parent[keys.at(-1)!]=value;}
export function redact(message:string,secrets:string[]=[]){
  for(const secret of secrets.filter(Boolean))message=message.split(secret).join('[已隐藏]');
  return message.replace(/https?:\/\/[^\s"<>]+/gi,'[远端地址已隐藏]').replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [已隐藏]').replace(/sk-[\w-]+/g,'[密钥已隐藏]').slice(0,16000);
}
export class RelayProvider implements Provider {
  constructor(readonly config:RelayConfig,private projects:ProjectStore,private mediaStore:MediaStore,private receipts:ReceiptStore,private testPolicy:Pick<NetworkPolicy,'allowLoopbackForTests'>={}) {}
  getCapabilities():ProviderCapability {return this.config.cap;}
  private assertEnabled(){if(!this.config.cap.configured||!this.config.cap.enabled)throw new DefiniteError(this.config.cap.message);}
  private assertInput(input:InputSnapshot){
    const c=this.config.cap;
    if(input.provider!==c.provider||input.kind!==c.kind||input.model!==c.model||input.serviceId!==c.serviceId)throw new DefiniteError('服务配置已变化；不会向新的中转站提交旧任务，请检查新摘要后明确重试');
  }
  private policy(hosts:string[]):NetworkPolicy{return {hosts,...this.testPolicy};}
  private async json(apiPath:string,body?:unknown) {
    this.assertEnabled();
    const url=this.config.baseUrl+apiPath;
    const response=await remoteRequest(url,this.policy([new URL(this.config.baseUrl).hostname]),{method:body===undefined?'GET':'POST',
      headers:{Authorization:`Bearer ${this.config.apiKey}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:Buffer.from(JSON.stringify(body))}),limit:this.config.cap.kind==='image'?115*1024*1024:1024*1024,timeoutMs:this.config.timeoutMs});
    if(response.status!==200&&response.status!==201&&response.status!==202) {
      // Never log or return raw relay errors: some relays echo credentials, headers and signed URLs.
      const message=`中转站请求未完成（HTTP ${response.status}）；请检查账户、模型或接口文档，不会自动重新提交`;
      if([400,401,403,404,422,429].includes(response.status))throw new DefiniteError(message);
      throw new UncertainError(message);
    }
    try{return JSON.parse(response.bytes.toString('utf8')) as unknown;}catch{throw new UncertainError('中转站响应不是有效 JSON，提交结果需人工确认');}
  }
  findByKey(key:string){return this.receipts.exists(key)?`relay:${key}`:null;}
  private receipt(id:string){
    if(!id.startsWith('relay:'))throw new UncertainError('远端回执标识不属于中转适配器');
    const key=id.slice(6),receipt=this.receipts.get(key);
    if(receipt.serviceId!==this.config.cap.serviceId)throw new DefiniteError('服务配置已变化，不能用新配置查询旧任务；请恢复原配置后重新查询');
    return {key,receipt};
  }
  private async images(input:InputSnapshot){
    const images:string[]=[];let total=0;
    for(const id of input.imageAssetIds){
      const asset=this.projects.asset(id);if(!await this.mediaStore.verify(asset))throw new DefiniteError('输入图片缺失或损坏');
      const bytes=await readFile(this.mediaStore.file(asset));total+=bytes.length;
      if(total>30*1024*1024)throw new DefiniteError('本次参考图总大小超过 30 MiB，请压缩后重试');
      images.push(`data:${asset.mimeType};base64,${bytes.toString('base64')}`);
    }return images;
  }
  async submit(input:InputSnapshot,requestKey:string) {
    this.assertInput(input);this.assertEnabled();
    const existing=this.findByKey(requestKey);if(existing){this.receipt(existing);return {providerTaskId:existing};}
    // Validate every local input and URL before the only paid POST; no implicit retries or protocol fallbacks.
    const images=await this.images(input),receipt:Receipt={serviceId:input.serviceId!};
    if(input.kind==='script') {
      const format=this.config.textFormat;
      const body={model:input.model,stream:false,messages:[{role:'system',content:scriptInstructions},{role:'user',content:`请拆为 ${input.params.shotCount} 个镜头。\n\n${input.prompt}`}],
        ...(format==='json_object'?{response_format:{type:'json_object'}}:format==='json_schema'?{response_format:{type:'json_schema',json_schema:{name:'storyboard',strict:true,schema:z.toJSONSchema(scriptShape)}}}:{})};
      const raw=await this.json('/chat/completions',body),content=getPath(raw,'choices.0.message.content');
      if(typeof content!=='string'||content.length>500000)throw new DefiniteError('文本响应缺少有效 message.content；未形成分镜草稿，不会自动再次生成');
      const clean=redact(content,[this.config.apiKey]).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
      try{const parsed=JSON.parse(clean);receipt.rawDraft={mode:'real',...scriptShape.parse(parsed)};}catch{receipt.rawDraft=clean;}
    } else if(input.kind==='image') {
      const body={model:input.model,prompt:input.prompt,n:input.params.count,size:input.params.size};
      let raw:unknown;
      if(images.length&&this.config.imageEditFormat==='multipart')raw=await this.multipartEdit(body,input);
      else raw=await this.json(images.length?'/images/edits':'/images/generations',{...body,...(images.length?{images:images.map(image_url=>({image_url}))}:{})});
      const data=z.array(z.object({b64_json:z.string().optional(),url:z.string().optional()}).passthrough()).safeParse(getPath(raw,'data'));
      if(!data.success||data.data.length!==input.params.count)throw new DefiniteError('图片响应候选数量或 data 结构无效，未生成完整结果；不会自动再次生成');
      receipt.outputs=[];
      for(let i=0;i<data.data.length;i++) {
        const value=data.data[i];
        if(value.b64_json) {
          if(value.b64_json.length>Math.ceil(IMAGE_LIMIT*4/3)+4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.b64_json))throw new DefiniteError('图片 Base64 无效或超过 20 MiB');
          const bytes=Buffer.from(value.b64_json,'base64'),mime=imageMime(bytes);
          receipt.outputs.push({file:await this.receipts.writeOutput(requestKey,i,bytes),mime});
        } else if(value.url) receipt.outputs.push({url:value.url,mime:'image/auto'});
        else throw new DefiniteError('图片响应缺少 Base64 或 URL');
      }
    } else {
      const profile=this.config.video;if(!profile)throw new DefiniteError('视频协议模板未配置');
      const body:Record<string,unknown>={};
      for(const [field,value] of [[profile.input.model,input.model],[profile.input.prompt,input.prompt],[profile.input.image,images[0]],[profile.input.duration,input.params.duration],[profile.input.ratio,input.params.ratio]] as const)setPath(body,field,value);
      const raw=await this.json(profile.submitPath,body),id=getPath(raw,profile.idPath);
      if(typeof id!=='string'||!(/^[A-Za-z0-9_-]{1,160}$/).test(id))throw new UncertainError('视频提交响应没有可保存的任务 ID，请人工核实，禁止自动重交');
      receipt.remoteId=id;
    }
    await this.receipts.save(requestKey,receipt);
    return {providerTaskId:`relay:${requestKey}`};
  }
  private async multipartEdit(body:Record<string,unknown>,input:InputSnapshot) {
    this.assertEnabled();const boundary=`studio-${crypto.randomUUID()}`,chunks:Buffer[]=[];
    for(const [key,value] of Object.entries(body))chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    for(let i=0;i<input.imageAssetIds.length;i++) {
      const asset=this.projects.asset(input.imageAssetIds[i]),bytes=await readFile(this.mediaStore.file(asset));
      const ext=asset.mimeType==='image/jpeg'?'jpg':asset.mimeType==='image/webp'?'webp':'png';
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference-${i}.${ext}"\r\nContent-Type: ${asset.mimeType}\r\n\r\n`),bytes,Buffer.from('\r\n'));
    }chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const response=await remoteRequest(this.config.baseUrl+'/images/edits',this.policy([new URL(this.config.baseUrl).hostname]),{method:'POST',headers:{Authorization:`Bearer ${this.config.apiKey}`,'Content-Type':`multipart/form-data; boundary=${boundary}`},body:Buffer.concat(chunks),limit:115*1024*1024,timeoutMs:this.config.timeoutMs});
    if(response.status!==200) {if([400,401,403,404,422,429].includes(response.status))throw new DefiniteError(`中转站参考图编辑未完成（HTTP ${response.status}）`);throw new UncertainError(`中转站参考图编辑状态未确认（HTTP ${response.status}）`);}
    try{return JSON.parse(response.bytes.toString('utf8')) as unknown;}catch{throw new UncertainError('参考图编辑响应不是有效 JSON');}
  }
  async query(id:string):Promise<ProviderResult> {
    const {key,receipt}=this.receipt(id);
    if(this.config.cap.kind!=='video')return {status:'succeeded',rawDraft:receipt.rawDraft};
    const profile=this.config.video!;
    const raw=await this.json(profile.queryPath.replace('{id}',encodeURIComponent(receipt.remoteId!))),status=getPath(raw,profile.statusPath);
    if(typeof status!=='string')throw new UncertainError('视频查询响应缺少状态字段');
    if(profile.states.running.includes(status))return {status:'running'};
    if(profile.states.failed.includes(status))return {status:'failed',error:'中转站已确认视频生成失败；请检查服务商后台后明确重试'};
    if(!profile.states.succeeded.includes(status))throw new UncertainError('中转站返回了未映射的视频状态，请核实协议模板');
    const urls=getPath(raw,profile.outputUrlsPath),parsed=z.array(z.string().url()).length(1).safeParse(typeof urls==='string'?[urls]:urls);
    if(!parsed.success)throw new UncertainError('视频完成但缺少有效结果地址，需重新查询或核实协议模板');
    receipt.outputs=[{url:parsed.data[0],mime:'video/mp4'}];await this.receipts.save(key,receipt);
    return {status:'succeeded'};
  }
  async media(input:InputSnapshot,taskId:string,index:number) {
    this.assertInput(input);const receipt=this.receipts.get(taskId),output=receipt.outputs?.[index];
    if(!output||receipt.serviceId!==input.serviceId)throw new DefiniteError('缺少对应输出回执，请恢复回执文件后重新查询');
    let bytes:Buffer;
    if(output.file)bytes=await this.receipts.readOutput(taskId,output.file);
    else {
      this.assertEnabled();
      const response=await downloadRemote(output.url!,this.policy(this.config.mediaHosts),input.kind==='image'?IMAGE_LIMIT:100*1024*1024,this.config.timeoutMs);
      bytes=response.bytes;
    }
    const mime=input.kind==='image'?imageMime(bytes):'video/mp4',ext=mime==='image/jpeg'?'jpg':mime==='image/webp'?'webp':mime==='image/png'?'png':'mp4';
    return {name:`生成${input.kind==='image'?'图片':'视频'}-${taskId.slice(0,8)}-${index+1}.${ext}`,mime,bytes};
  }
  normalizeError(error:unknown){return error instanceof DefiniteError||error instanceof UncertainError||error instanceof NetworkError?redact(error.message,[this.config.apiKey]):'中转站处理或本地保存失败；请检查服务端配置及文件权限，敏感错误内容已隐藏';}
}
function imageMime(bytes:Buffer){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  throw new DefiniteError('生成图片格式无效，仅接受 PNG、JPEG、WebP');
}
