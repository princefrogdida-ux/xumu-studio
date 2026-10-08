import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mockCapabilities, type InputSnapshot, type StoryDraft } from '../../../../packages/shared/src/generation.ts';
import { ProjectStore } from '../db/store.ts';
import { UncertainError, type Provider, type ProviderResult } from './provider.ts';

interface MockJob { id:string; requestKey:string; input:InputSnapshot; readyAt:number; queries:number }
export class MockProvider implements Provider {
  constructor(private store:ProjectStore, private delayMs=5000) {}
  getCapabilities() { return mockCapabilities; }
  findByKey(requestKey:string): string | null {
    const row = this.store.db.prepare('SELECT id FROM mock_jobs WHERE request_key=?').get(requestKey) as {id:string} | undefined;
    return row?.id ?? null;
  }
  async submit(input:InputSnapshot, requestKey:string) {
    let id = this.findByKey(requestKey);
    if (!id) {
      id=randomUUID(); const job:MockJob={id,requestKey,input,readyAt:Date.now()+this.delayMs,queries:0};
      this.store.db.prepare('INSERT INTO mock_jobs VALUES(?,?,?)').run(id,requestKey,JSON.stringify(job));
    }
    if (input.scenario === 'submit-timeout') throw new UncertainError('模拟提交超时：服务已接收，但响应丢失；请重新查询，禁止自动重交');
    return {providerTaskId:id};
  }
  async query(id:string): Promise<ProviderResult> {
    const row=this.store.db.prepare('SELECT data FROM mock_jobs WHERE id=?').get(id) as {data:string} | undefined;
    if (!row) throw new UncertainError('模拟远端记录不存在，无法确认状态');
    const job:MockJob=JSON.parse(row.data); job.queries++;
    this.store.db.prepare('UPDATE mock_jobs SET data=? WHERE id=?').run(JSON.stringify(job),id);
    if(job.input.scenario==='query-timeout' && job.queries<=3) throw new UncertainError('模拟查询超时，远端任务状态尚未确认');
    if(Date.now()<job.readyAt) return {status:'running'};
    if(job.input.scenario==='failure') return {status:'failed',error:'模拟服务已确认生成失败。可编辑输入后明确重试。'};
    if(job.input.kind==='script') {
      if(job.input.scenario==='invalid-draft') return {status:'succeeded',rawDraft:{mode:'mock',shots:[{title:'缺字段的测试响应'}]}};
      const lines=job.input.prompt.split(/[。！？\n]+/).map(s=>s.trim()).filter(Boolean);
      const shots:StoryDraft['shots']=Array.from({length:job.input.params.shotCount??3},(_,i)=>{
        const description=(lines[i%lines.length]??job.input.prompt).slice(0,4000);
        return {title:`模拟镜头 ${i+1}`,description,framing:['远景','中景','近景'][i%3],action:'按剧本动作手工调整',camera:'固定机位',dialogue:'',duration:5,imagePrompt:`${description}，电影构图（模拟拆解草稿）`,videoPrompt:`${description}，缓慢推进（模拟拆解草稿）`};
      }); return {status:'succeeded',draft:{mode:'mock',shots}};
    }
    return {status:'succeeded'};
  }
  normalizeError(error:unknown) { return error instanceof Error ? error.message : '模拟服务发生未知错误'; }
  async media(input:InputSnapshot, taskId:string, index:number): Promise<{name:string; mime:string; bytes:Buffer}> {
    if(input.kind==='video') return {name:`模拟视频-${taskId.slice(0,8)}.mp4`,mime:'video/mp4',bytes:await readFile(fileURLToPath(new URL('../fixtures/mock-video.mp4',import.meta.url)))};
    const [width,height]=input.params.ratio==='9:16'?[540,960]:input.params.ratio==='1:1'?[640,640]:[960,540];
    const colors=['#57437b','#315b68','#725738','#3e6153'];
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${colors[index%4]}"/><circle cx="${width*.8}" cy="${height*.3}" r="${width*.26}" fill="#fff" opacity=".12"/><path d="M0 ${height*.8} L${width*.4} ${height*.45} L${width} ${height*.8} V${height} H0" fill="#fff" opacity=".1"/><text x="40" y="80" fill="#fff" font-family="Arial" font-size="25">MOCK IMAGE / ${index+1}</text><text x="40" y="${height-65}" fill="#fff" font-family="Arial" font-size="16">LOCAL TEST - NO AI GENERATION</text><text x="40" y="${height-35}" fill="#fff" font-family="Arial" font-size="13">Task ${taskId.slice(0,8)}</text></svg>`;
    return {name:`模拟图片-${taskId.slice(0,8)}-${index+1}.png`,mime:'image/png',bytes:await sharp(Buffer.from(svg)).png().toBuffer()};
  }
}
