import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ProviderCapability, TaskKind } from '../../../../packages/shared/src/generation.ts';

const field=z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/).refine(s=>!s.split('.').some(x=>['__proto__','prototype','constructor'].includes(x)));
const apiPath=z.string().startsWith('/').max(300).refine(s=>!s.startsWith('//')&&!/[?#\\]/.test(s)&&!s.split('/').includes('..'));
export const VideoProfileSchema=z.object({
  submitPath:apiPath, queryPath:apiPath.refine(s=>s.includes('{id}')),
  input:z.object({model:field,prompt:field,image:field,duration:field,ratio:field}).strict(),
  idPath:field,statusPath:field,outputUrlsPath:field,
  states:z.object({running:z.array(z.string()).min(1),succeeded:z.array(z.string()).min(1),failed:z.array(z.string()).min(1)}).strict(),
  durations:z.array(z.number().int().min(1).max(60)).min(1).max(20),
  ratios:z.array(z.enum(['16:9','9:16','1:1','3:2','2:3'])).min(1),
}).strict().superRefine((p,c)=>{
  const states=Object.values(p.states).flat();
  if(new Set(states).size!==states.length)c.addIssue({code:'custom',message:'视频状态映射不能重叠'});
  const fields=Object.values(p.input);
  if(fields.some((a,i)=>fields.some((b,j)=>i!==j&&(a===b||a.startsWith(b+'.')))))c.addIssue({code:'custom',message:'视频输入字段不能重叠'});
});
export type VideoProfile=z.infer<typeof VideoProfileSchema>;
export interface RelayConfig {
  cap:ProviderCapability; baseUrl:string; apiKey:string; mediaHosts:string[]; timeoutMs:number;
  textFormat:'prompt'|'json_object'|'json_schema'; imageEditFormat:'json'|'multipart'; video?:VideoProfile;
}
const integer=(value:string|undefined,fallback:number,min:number,max:number)=>{
  const n=value===undefined||value===''?fallback:Number(value);
  if(!Number.isInteger(n)||n<min||n>max)throw new Error('invalid setting');return n;
};
export function readRelayConfigs(env:NodeJS.ProcessEnv=process.env):RelayConfig[] {
  return (['script','image','video'] as TaskKind[]).map(kind=>{
    const prefix=`STUDIO_${kind==='script'?'TEXT':kind.toUpperCase()}_`;
    const get=(key:string)=>env[prefix+key]?.trim()??'';
    const config:RelayConfig={baseUrl:get('BASE_URL').replace(/\/$/,''),apiKey:get('API_KEY'),mediaHosts:[],timeoutMs:120000,
      textFormat:'prompt',imageEditFormat:'json',cap:{provider:`relay-${kind}`,kind,mode:'real',model:get('MODEL'),
        protocol:kind==='script'?'chat-completions':kind==='image'?'images-api':'video-json-template',configured:false,enabled:false,
        message:'未配置中转站地址、密钥和模型。',maxReferences:kind==='video'?1:0,maxCount:1,ratios:[],durations:[],pollIntervalMs:5000}};
    try {
      config.timeoutMs=integer(get('TIMEOUT_MS'),120000,1000,300000);
      config.cap.pollIntervalMs=integer(get('POLL_MS'),5000,1000,60000);
      config.mediaHosts=get('MEDIA_HOSTS').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
      if(config.mediaHosts.some(h=>!/^[a-z0-9.-]+$/.test(h)))throw new Error('invalid host');
      if(kind==='script')config.textFormat=z.enum(['prompt','json_object','json_schema']).parse(get('FORMAT')||'prompt');
      if(kind==='image') {
        config.imageEditFormat=z.enum(['json','multipart']).parse(get('EDIT_FORMAT')||'json');
        config.cap.maxReferences=integer(get('MAX_REFERENCES'),0,0,8);
        config.cap.maxCount=integer(get('MAX_COUNT'),1,1,4);
        config.cap.sizes=z.partialRecord(z.enum(['16:9','9:16','1:1','3:2','2:3']),z.string().regex(/^\d{2,4}x\d{2,4}$/)).parse(JSON.parse(get('SIZES')||'{"1:1":"1024x1024","3:2":"1536x1024","2:3":"1024x1536"}'));
        for(const [ratio,size] of Object.entries(config.cap.sizes!)) {
          const [w,h]=size.split('x').map(Number),[a,b]=ratio.split(':').map(Number);
          if(w*h>40_000_000||Math.abs(w/h-a/b)>.01)throw new Error('size ratio mismatch');
        }
        config.cap.ratios=Object.keys(config.cap.sizes!);if(!config.cap.ratios.length)throw new Error('no sizes');
      }
      if(kind==='video') {
        if(!get('PROFILE_FILE')){config.cap.message='视频需配置 JSON 任务模板；没有通用视频标准，实际协议兼容性待核实。';return config;}
        config.video=VideoProfileSchema.parse(JSON.parse(readFileSync(get('PROFILE_FILE'),'utf8')));
        config.cap.ratios=config.video.ratios;config.cap.durations=config.video.durations;
        if(!config.mediaHosts.length){config.cap.message='视频结果需要配置允许下载的精确主机名（MEDIA_HOSTS），以免生成后无法落盘。';return config;}
      }
      if(!config.baseUrl||!config.apiKey||!config.cap.model)return config;
      const url=new URL(config.baseUrl);
      if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||config.cap.model.length>80||/[\r\n]/.test(config.apiKey))throw new Error('invalid credentials or URL');
      // Credentials never enter the public capability or the input snapshot. A changed endpoint/profile invalidates queued inputs.
      config.cap.serviceId=createHash('sha256').update(JSON.stringify({version:1,baseUrl:config.baseUrl,model:config.cap.model,kind,
        textFormat:config.textFormat,imageEditFormat:config.imageEditFormat,video:config.video,sizes:config.cap.sizes,
        maxCount:config.cap.maxCount,maxReferences:config.cap.maxReferences})).digest('hex');
      config.cap.configured=true;config.cap.enabled=env.STUDIO_REAL_CALLS_ENABLED==='true';
      config.cap.message=config.cap.enabled?'真实调用已开启；中转站费用未知，请遵守已授权额度。':'真实调用已关闭；配置可预览，本轮不发送收费请求。';
    } catch { config.cap.configured=false;config.cap.enabled=false;config.cap.message='服务端配置无效，请按 M4 配置说明检查；配置内容不会返回浏览器。'; }
    return config;
  });
}
