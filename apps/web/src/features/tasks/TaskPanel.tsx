import { useTasks } from './task-store.ts';
import { statusLabels } from '../../../../../packages/shared/src/generation.ts';
import { useEditor } from '../canvas/editor-store.ts';
import { request } from '../../lib/api.ts';
import { useEffect, useState } from 'react';
import type { HistoryPage } from '../../../../../packages/shared/src/task-query.ts';
import type { Task } from '../../../../../packages/shared/src/generation.ts';

export function TaskPanel({notify, focus}:{notify:(message:string)=>void; focus:(id:string)=>void}) {
  const activity=useTasks(s=>s.tasks),error=useTasks(s=>s.error),projectId=useEditor(s=>s.projectId);
  const [page,setPage]=useState<HistoryPage|null>(null),[busy,setBusy]=useState(false),[detail,setDetail]=useState<Task|null>(null),[pageError,setPageError]=useState('');
  useEffect(()=>{let live=true;void useTasks.getState().history(projectId).then(p=>{if(live)setPage(p);}).catch(e=>{if(live)setPageError(e.message);});return()=>{live=false;};},[projectId]);
  const read=async(cursor?:string)=>{setBusy(true);setPageError('');try{setPage(await useTasks.getState().history(projectId,undefined,cursor));setDetail(null);}catch(e){setPageError((e as Error).message);}finally{setBusy(false);}};
  const tasks=(page?.items??[]).map(t=>activity.find(a=>a.id===t.id)??t);
  const action=async(id:string,verb:'requery'|'cancel')=>{try{await request(`/api/tasks/${id}/${verb}`,{method:'POST'});await useTasks.getState().load(projectId);}catch(e){notify((e as Error).message);}};
  return <section className="production-library task-panel"><div className="library-heading"><div><span className="eyebrow">LOCAL TASK WORKER</span><h1>任务与历史</h1><p>每页最多 30 条，固定输入按需读取。待确认任务不会自动重新提交。</p></div><button className="secondary" disabled={busy} onClick={()=>{void useTasks.getState().load(projectId);void read();}}>刷新任务</button></div>{(error||pageError)&&<p className="media-error">{error||pageError}</p>}
    {!tasks.length&&<div className="library-empty"><h2>还没有生成任务</h2><p>在画布添加生成节点，检查输入摘要后点击生成。</p></div>}
    {tasks.map(t=><article key={t.id} className="task-row"><div><strong>{statusLabels[t.status]} · {t.mode==='real'?'真实':'模拟'}{t.kind==='image'?'图片':t.kind==='video'?'视频':'剧本拆解'}</strong><small>{new Date(t.createdAt).toLocaleString('zh-CN')} · {t.id.slice(0,8)}</small>{t.error&&<p className="media-error">{t.error}</p>}
      <button className="secondary" onClick={()=>void useTasks.getState().detail(t.id).then(setDetail).catch(e=>notify(e.message))}>查看固定输入与来源</button>
      {detail?.id===t.id&&<details open><summary>固定输入与来源</summary><pre>{JSON.stringify(detail.inputSnapshot,null,2)}</pre><small>SHA-256：{detail.inputFingerprint}{detail.retryOf&&` · 重试来源 ${detail.retryOf}`}</small></details>}
      </div><div className="task-actions"><button className="secondary" onClick={()=>focus(t.nodeId)}>查看节点</button>{t.actions.cancel&&<button className="secondary" onClick={()=>void action(t.id,'cancel')}>取消排队</button>}{t.actions.requery&&<button className="secondary" onClick={()=>void action(t.id,'requery')}>重新查询</button>}</div></article>)}
    <div className="library-toolbar"><button className="secondary" disabled={busy} onClick={()=>void read()}>返回最新历史</button><button className="secondary" disabled={busy||!page?.nextCursor} onClick={()=>void read(page!.nextCursor!)}>更早的 30 条</button><small>本页 {tasks.length} 条</small></div>
  </section>;
}
