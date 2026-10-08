import path from 'node:path';
import { ProjectStore } from '../db/store.ts';
import { TaskStore } from '../tasks/store.ts';
import { MediaStore } from '../storage/media.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { TaskWorker } from './runner.ts';
import { heartbeat } from '../health.ts';
import { runtimeInfo } from '../../../../packages/shared/src/runtime.ts';

const dir=path.resolve(process.env.STUDIO_DATA_DIR??'data'),store=new ProjectStore(path.join(dir,'studio.sqlite'));
const media=new MediaStore(path.join(dir,'media'),store);
const worker=new TaskWorker(new TaskStore(store),new ProviderRegistry(store,media),media);
let stopping=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{stopping=true;});
process.on('message', message => { if (message === 'shutdown') stopping = true; });
process.on('disconnect', () => { stopping = true; });
heartbeat(store);
const pulse = setInterval(() => { try { heartbeat(store); } catch { /* API reports a stale pulse. */ } }, 5000);
console.log(`${runtimeInfo.stage} 独立 worker · 持久化租约 · 并发 1 · 真实调用由服务端配置控制`);
while(!stopping) {
  try {await worker.tick();} catch {console.error('worker 暂时无法处理任务，请检查本地数据库与配置。');}
  await new Promise(resolve=>setTimeout(resolve,250));
}
clearInterval(pulse); heartbeat(store, true); store.close();
console.log('worker 已正常停止');
if (process.connected) process.disconnect();
