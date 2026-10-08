import { useEffect, useRef, useState } from 'react';
import { DocumentSchema, connectionError, outputPorts, type GenerationNode } from '../../../../../packages/shared/src/index.ts';
import { applyDraft, fingerprint, resolveInput, selectGeneration, statusLabels, kindOf, type InputSnapshot, type Task } from '../../../../../packages/shared/src/generation.ts';
import { useEditor } from '../canvas/editor-store.ts';
import { useAssets } from '../assets/asset-store.ts';
import { MediaPreview } from '../assets/MediaPreview.tsx';
import { useTasks } from './task-store.ts';
import { request } from '../../lib/api.ts';
import { useProviders } from './providers-store.ts';
import type { HistoryPage, TaskSummary } from '../../../../../packages/shared/src/task-query.ts';

export function GenerationInspector({node,beforeSubmit,notify}:{node:GenerationNode;beforeSubmit:()=>Promise<void>;notify:(message:string)=>void}) {
  const doc=useEditor(s=>s.inputDoc),projectId=useEditor(s=>s.projectId),assets=useAssets(s=>s.assets),tasks=useTasks(s=>s.tasks),generations=useTasks(s=>s.generations);
  const [historyPage,setHistoryPage]=useState<HistoryPage|null>(null),[historyError,setHistoryError]=useState(''),[historyBusy,setHistoryBusy]=useState(false);
  const historySequence=useRef(0);
  const readHistory=async(cursor?:string)=>{
    const seq=++historySequence.current;setHistoryBusy(true);setHistoryError('');
    try{const p=await useTasks.getState().history(projectId,node.id,cursor);if(seq!==historySequence.current)return;
      await Promise.all(p.items.filter(t=>t.generationId).map(t=>useTasks.getState().ensureGeneration(projectId,t.generationId!)));
      if(node.data.selectedGenerationId)await useTasks.getState().ensureGeneration(projectId,node.data.selectedGenerationId);
      if(seq===historySequence.current)setHistoryPage(p);
    }catch(e){if(seq===historySequence.current)setHistoryError((e as Error).message);}finally{if(seq===historySequence.current)setHistoryBusy(false);}
  };
  const latest=tasks.find(t=>t.nodeId===node.id);
  useEffect(()=>{void readHistory();return()=>{historySequence.current++;};},[projectId,node.id,latest?.updatedAt,node.data.selectedGenerationId]);
  const [hash,setHash]=useState(''),[busy,setBusy]=useState(false),[imageSource,setImageSource]=useState('');
  const capabilities=useProviders(s=>s.capabilities),providerError=useProviders(s=>s.error),mode=node.data.mode??'mock';
  const capability=capabilities.find(c=>c.kind===kindOf(node)&&c.mode===mode),real=mode==='real';
  const gate=useRef(false),pendingKey=`drama-studio:submit:${projectId}:${node.id}`;
  const [pending,setPending]=useState<{body:unknown;url:string}|null>(()=>{try{return JSON.parse(localStorage.getItem(pendingKey)??'null');}catch{return null;}});
  let input:InputSnapshot|null=null,error='';
  try{input=resolveInput(doc,node.id,assets,capabilities);}catch(e){error=(e as Error).message;}
  const signature=input?JSON.stringify(input):'';
  useEffect(()=>{let live=true;setHash('');if(signature)void fingerprint(JSON.parse(signature)).then(value=>{if(live)setHash(value);});return()=>{live=false;};},[signature]);
  const shownIds=new Set([...(historyPage?.items.flatMap(t=>t.generationId?[t.generationId]:[])??[]),...(node.data.selectedGenerationId?[node.data.selectedGenerationId]:[])]);
  const history=generations.filter(g=>g.nodeId===node.id&&shownIds.has(g.id)),nodeTasks=(historyPage?.items??tasks.filter(t=>t.nodeId===node.id)).map(t=>tasks.find(a=>a.id===t.id)??t),active=tasks.some(t=>t.nodeId===node.id&&['queued','submitting','running','persisting'].includes(t.status));
  const edit=(patch:Parameters<ReturnType<typeof useEditor.getState>['editGeneration']>[1])=>useEditor.getState().editGeneration(node.id,patch);
  const submit=async(retry?:TaskSummary)=>{
    if(gate.current)return;gate.current=true;setBusy(true);
    try {
      let send=pending;
      if(!send){
        await beforeSubmit();
        const preview=await request<{revision:number;inputFingerprint:string}>(`/api/projects/${projectId}/inputs`,{method:'POST',body:JSON.stringify({nodeId:node.id})});
        if(preview.inputFingerprint!==hash)throw new Error('输入已变化，请检查新摘要后再次点击生成');
        send={url:retry?`/api/tasks/${retry.id}/retry`:`/api/projects/${projectId}/tasks`,body:{nodeId:node.id,requestKey:crypto.randomUUID(),revision:preview.revision,inputFingerprint:hash}};
        setPending(send);try{localStorage.setItem(pendingKey,JSON.stringify(send));}catch{notify('浏览器提交记录无法保存，请保持页面打开，提交结果不明时先查看任务列表');}
      }
      const task=await request<Task>(send.url,{method:'POST',body:JSON.stringify(send.body)});
      setPending(null);localStorage.removeItem(pendingKey);await useTasks.getState().load(projectId);notify(`${task.inputSnapshot.mode==='real'?'真实':'模拟'}任务${statusLabels[task.status]}，输入已固定`);
    }catch(e){
      // Validation rejection is definite; a network failure retains the exact request key.
      if((e as {status?:number}).status && (e as {status:number}).status<500){setPending(null);localStorage.removeItem(pendingKey);}
      notify((e as Error).message);
    }finally{gate.current=false;setBusy(false);}
  };
  const query=async(task:TaskSummary)=>{try{await request(`/api/tasks/${task.id}/requery`,{method:'POST'});await useTasks.getState().load(projectId);}catch(e){notify((e as Error).message);}};
  const link=(kind:'text'|'image',value:string)=>{
    try {
      useEditor.getState().update(d=>{
        if(kind==='text')d.edges=d.edges.filter(e=>e.target!==node.id||e.targetHandle!=='text-in');
        if(!value)return d;
        const [source,sourceHandle]=JSON.parse(value),candidate={source,target:node.id,sourceHandle,targetHandle:kind==='text'?'text-in' as const:'image-in' as const};
        const invalid=connectionError(d.nodes,d.edges,candidate);if(invalid)throw new Error(invalid);
        d.edges.push({...candidate,id:crypto.randomUUID(),inputOrder:Math.max(-1,...d.edges.filter(e=>e.target===node.id).map(e=>e.inputOrder??0))+1});return d;
      });
    }catch(e){notify((e as Error).message);}
  };
  const sources=(kind:string)=>doc.nodes.filter(n=>n.id!==node.id).flatMap(n=>outputPorts(n).filter(p=>p.kind===kind).map(p=>({value:JSON.stringify([n.id,p.id]),label:`${n.type==='text'?n.data.title:n.type==='shot'?doc.shots.find(s=>s.id===n.data.shotId)?.title:n.type==='reference'?doc.references.find(r=>r.id===n.data.referenceId)?.name:n.type==='media'?assets.find(a=>a.id===n.data.assetId)?.name:'title' in n.data?n.data.title:n.id} · ${p.label}`})));
  const textEdge=doc.edges.find(e=>e.target===node.id&&e.targetHandle==='text-in');
  const incoming=doc.edges.filter(e=>e.target===node.id&&e.targetHandle==='image-in').sort((a,b)=>(a.inputOrder??0)-(b.inputOrder??0)||a.id.localeCompare(b.id));
  return <div className="inspector-content generation-inspector"><div className="selected-type">{node.type==='script'?'剧本拆解':node.type==='imageGenerate'?'图片生成':'视频生成'} · {real?'中转站真实模式':'本地模拟'}</div>
    <label>运行模式<select aria-label="运行模式" value={mode} onChange={e=>{const mode=e.target.value as 'mock'|'real',cap=capabilities.find(c=>c.kind===kindOf(node)&&c.mode===mode);edit({mode,model:cap?.model??'',ratio:(cap?.ratios[0]??'16:9') as GenerationNode['data']['ratio'],count:Math.min(node.data.count,cap?.maxCount??1),duration:cap?.durations[0]??5,scenario:'success'});}}><option value="mock">本地模拟 · 无费用</option><option value="real">中转站 · 真实调用</option></select></label>
    <p className="library-help">{capability?.message??'服务状态未读取，请刷新服务状态。'}{real&&' 接口能力取决于中转站与模型，价格尚未核实。'}</p>
    {providerError&&<p className="media-error">{providerError}</p>}<button className="secondary full" onClick={()=>void useProviders.getState().load()}>刷新服务状态</button>
    <label>生成节点标题<input aria-label="生成节点标题" maxLength={120} value={node.data.title} onChange={e=>edit({title:e.target.value})}/></label>
    <label>引用主文字<select aria-label="引用主文字" value={textEdge?JSON.stringify([textEdge.source,textEdge.sourceHandle]):''} onChange={e=>link('text',e.target.value)}><option value="">使用本地提示词</option>{sources('text').map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
    <label>补充提示词<textarea aria-label="生成提示词" maxLength={30000} value={node.data.prompt} placeholder="已连接文字将作为基础输入，本地文字追加到后面" onFocus={()=>useEditor.getState().begin()} onBlur={()=>useEditor.getState().end()} onChange={e=>edit({prompt:e.target.value})}/></label>
    {node.type!=='script'&&<><label>{node.type==='videoGenerate'?'首帧图片':'参考图片输入'}<select aria-label="选择图片输入" value={imageSource} onChange={e=>setImageSource(e.target.value)}><option value="">选择上游图片节点</option>{sources('image').map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label><button className="secondary full" disabled={!imageSource} onClick={()=>{link('image',imageSource);setImageSource('');}}>添加图片引用</button>{incoming.map((edge,i)=><div className="incoming-row" key={edge.id}><small>图片输入 {i+1} · {edge.source.slice(0,8)}</small><button className="secondary" disabled={i===0} onClick={()=>useEditor.getState().update(d=>{const ordered=[...incoming];[ordered[i],ordered[i-1]]=[ordered[i-1],ordered[i]];d.edges=d.edges.map(e=>{const order=ordered.findIndex(o=>o.id===e.id);return order<0?e:{...e,inputOrder:order};});return d;})}>上移</button><button className="secondary" onClick={()=>useEditor.getState().update(d=>({...d,edges:d.edges.filter(e=>e.id!==edge.id)}))}>移除输入</button></div>)}</>}
    <label>模型<input aria-label="生成模型" readOnly value={node.data.model||'服务端尚未配置模型'}/></label>{real&&<p className="library-help">协议：{capability?.protocol??'待配置'} · 参考图上限 {capability?.maxReferences??0}。地址与密钥在服务端配置，刷新或切换模式不会生成。</p>}{real&&capability?.configured&&capability.model!==node.data.model&&<button className="secondary full" onClick={()=>edit({model:capability.model})}>使用服务端当前模型：{capability.model}</button>}
    {node.type==='script'?<label>草稿镜头数<select aria-label="草稿镜头数" value={node.data.shotCount} onChange={e=>edit({shotCount:Number(e.target.value)})}>{[3,4,5].map(x=><option key={x}>{x}</option>)}</select></label>:<><label>请求比例<select aria-label="生成比例" value={node.data.ratio} onChange={e=>edit({ratio:e.target.value as GenerationNode['data']['ratio']})}>{[...new Set([node.data.ratio,...(capability?.ratios??[])])].map(x=><option key={x}>{x}{capability&&!capability.ratios.includes(x)?'（不支持）':''}{capability?.sizes?.[x]?` · ${capability.sizes[x]}`:''}</option>)}</select></label>{node.type==='imageGenerate'?<label>候选图片数<select aria-label="候选图片数" value={node.data.count} onChange={e=>edit({count:Number(e.target.value)})}>{[...new Set([node.data.count,...Array.from({length:capability?.maxCount??1},(_,i)=>i+1)])].map(x=><option key={x}>{x}</option>)}</select></label>:<label>请求时长（秒）<select aria-label="视频请求时长" value={node.data.duration} onChange={e=>edit({duration:Number(e.target.value)})}>{[...new Set([node.data.duration,...(capability?.durations??[])])].map(x=><option key={x}>{x}</option>)}</select></label>}
      <label>关联分镜<select aria-label="关联分镜" value={node.data.shotId??''} onChange={e=>edit({shotId:e.target.value||null})}><option value="">未关联</option>{doc.shots.map(s=><option key={s.id} value={s.id}>{s.number} · {s.title}</option>)}</select></label></>}
    {!real&&<details><summary>模拟异常验证</summary><label>模拟行为<select aria-label="模拟行为" value={node.data.scenario} onChange={e=>edit({scenario:e.target.value as GenerationNode['data']['scenario']})}><option value="success">正常完成</option><option value="failure">明确失败</option><option value="submit-timeout">提交响应丢失</option><option value="query-timeout">查询超时</option>{node.type==='script'&&<option value="invalid-draft">无效分镜响应</option>}</select></label></details>}
    <div className="input-preview"><span>本次输入摘要 · 生成前检查</span>{error?<p className="media-error">{error}</p>:<><p>{input?.prompt}</p><small>{input?.imageAssetIds.length} 张图片 · {JSON.stringify(input?.params)}</small>{input?.imageAssetIds.map((id,i)=><div key={`${id}:${i}`}><small>输入 {i+1} · {assets.find(a=>a.id===id)?.name}</small><MediaPreview id={id}/></div>)}</>}</div>
    <button className="primary full" disabled={busy||!pending&&(!!error||!hash||active||!capability?.enabled)} onClick={()=>void submit()}>{busy?'正在提交…':pending?'重新确认上次提交':active?'任务正在执行':real?capability?.enabled?'开始真实生成 · 费用未知':'真实调用未开启':'开始模拟生成'}</button>
    <div className="generation-history"><h3>生成历史与版本</h3>{historyError&&<p className="media-error">{historyError}</p>}<div className="library-toolbar"><button className="secondary" disabled={historyBusy} onClick={()=>void readHistory()}>最新历史</button><button className="secondary" disabled={historyBusy||!historyPage?.nextCursor} onClick={()=>void readHistory(historyPage!.nextCursor!)}>更早版本</button></div>{nodeTasks.slice(0,5).map(t=><div key={t.id} className="task-status"><strong>{statusLabels[t.status]} · {t.mode==='real'?'真实':'模拟'} · {t.id.slice(0,8)}</strong>{t.error&&<p className="media-error">{t.error}</p>}{t.status==='unknown'&&<button className="secondary" onClick={()=>void query(t)}>重新查询（不重新生成）</button>}{['failed','unknown','cancelled'].includes(t.status)&&<button className="secondary" disabled={busy||active||!!error||!hash||!!pending||!capability?.enabled} onClick={()=>{if((t.status==='unknown'||real)&&!window.confirm(real?'明确重试会创建新任务，可能产生额外费用；待确认任务仍可能完成。确定继续吗？':'原任务仍可能完成。明确重试会创建一个新任务；本地模拟无费用。确定重试吗？'))return;void submit(t);}}>明确重试 · 新任务</button>}</div>)}
      {history.map(g=><article className="generation-result" key={g.id}><strong>版本 {g.id.slice(0,8)} · {(g.draft?.mode==='real'||g.outputAssetIds.some(id=>assets.find(a=>a.id===id)?.source==='generated'))?'真实接口输出':'模拟输出'}</strong><small>{new Date(g.createdAt).toLocaleString('zh-CN')}</small>{(!hash||hash!==g.inputFingerprint)&&<p className="stale-warning">输入已变化或当前输入不可用，保留旧结果</p>}
        {g.draft?<details open><summary>预览结构化分镜草稿（未应用）</summary>{g.draft.shots.map((s,i)=><div key={i} className="draft-shot"><strong>{i+1} · {s.title}</strong><p>{s.description}</p><small>{s.framing} · {s.duration}s · {s.camera}</small><details><summary>全部字段</summary><pre>{JSON.stringify(s,null,2)}</pre></details></div>)}<button className="secondary full" onClick={()=>{try{useEditor.getState().update(d=>DocumentSchema.parse(applyDraft(d,g.draft!,'append',()=>crypto.randomUUID())));notify('草稿已追加，可撤销');}catch(e){notify((e as Error).message);}}}>追加草稿到分镜</button><button className="secondary full" onClick={()=>{if(window.confirm('替换当前全部分镜及分镜卡片引用？原内容可通过撤销恢复，任务与素材会保留。')){try{useEditor.getState().update(d=>DocumentSchema.parse(applyDraft(d,g.draft!,'replace',()=>crypto.randomUUID())));notify('分镜已替换，可撤销恢复原版本');}catch(e){notify((e as Error).message);}}}}>替换分镜（可撤销）</button></details>:g.outputAssetIds.map((id,i)=><div className="candidate" key={id}><MediaPreview key={id} id={id} playable/><small>候选 {i+1}{node.data.selectedAssetId===id?' · 当前选中':''}</small><button className="secondary full" disabled={assets.find(a=>a.id===id)?.status!=='ready'} onClick={()=>useEditor.getState().update(d=>selectGeneration(d,g,id))}>选择此版本供下游使用</button>{node.data.shotId&&<button className="secondary full" disabled={assets.find(a=>a.id===id)?.status!=='ready'} onClick={()=>{useEditor.getState().update(d=>selectGeneration(d,g,id,true));notify('节点版本与镜头选用素材已同步');}}>设为镜头选用</button>}<a className="secondary download-link" href={`/api/assets/${id}/file?download=1`} download>下载素材</a></div>)}
      </article>)}{!history.length&&<p className="library-help">结果保存在后端。完成后需人工选择；连线与版本选择不会自动生成。</p>}</div>
  </div>;
}
