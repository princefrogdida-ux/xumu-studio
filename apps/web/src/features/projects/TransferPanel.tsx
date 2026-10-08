import { useEffect, useState } from 'react';
import { Download, FileJson, Package, Upload, X, LoaderCircle } from 'lucide-react';
import type { Project } from '../../../../../packages/shared/src/index.ts';
import { MAX_IMPORT_BYTES, ProjectTransferSchema, type ExportPreview, type ExportJob, type ExportIssue } from '../../../../../packages/shared/src/transfer.ts';
import { api, request, downloadJson } from '../../lib/api.ts';

export function TransferPanel({ projectId, beforeAction, adopt, close, navigate }: {
  projectId: string; beforeAction: () => Promise<void>; adopt: (project: Project) => void; close: () => void;
  navigate: (issue: ExportIssue) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [text, setText] = useState('');
  const [preview, setPreview] = useState<ExportPreview | null>(null), [partial, setPartial] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null), [warnings, setWarnings] = useState<string[] | null>(null);
  const [history,setHistory]=useState<ExportJob[]>([]),[cursor,setCursor]=useState<string|null>(null),[uncertain,setUncertain]=useState(false);
  const readHistory=async(next?:string)=>{
    const p=await request<{items:ExportJob[];nextCursor:string|null}>(`/api/projects/${projectId}/exports${next?`?cursor=${next}`:''}`);
    setHistory(p.items);setCursor(p.nextCursor);return p.items;
  };
  const key = `drama-studio:export:${projectId}`;
  const run = async (action: () => Promise<void>) => {
    if (busy || job?.status === 'building') return;
    setBusy(true); setError('');
    try { await beforeAction(); await action(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let active = true;
    void request<{items:ExportJob[];nextCursor:string|null}>(`/api/projects/${projectId}/exports`).then(p=>{if(active){setHistory(p.items);setCursor(p.nextCursor);setJob(p.items.find(j=>j.status==='building')??p.items[0]??null);}}).catch(e=>{if(active)setError(e.message);});
    return () => { active = false; };
  }, [key]);
  useEffect(() => {
    if (job?.status !== 'building') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const current = await api.exportJob(job.id); if (!stopped) { setJob(current); setHistory(items => items.map(item => item.id === current.id ? current : item)); setError(''); if (current.status === 'building') timer = setTimeout(() => void poll(), 800); } }
      catch (e) { if (!stopped) { setError((e as Error).message); timer = setTimeout(() => void poll(), 2500); } }
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, job?.status]);
  const pending = busy || job?.status === 'building';
  return <div className="modal-backdrop" onClick={() => !busy && close()}><section className="modal transfer-modal" role="dialog" aria-modal="true" aria-label="导入与导出" onClick={e => e.stopPropagation()}>
    <button className="modal-close icon-button" aria-label="关闭导入导出" disabled={busy} onClick={close}><X size={19} /></button>
    <span className="eyebrow">PROJECT DELIVERY</span><h2>导入与导出</h2>
    <p>素材包按分镜清单顺序交付。JSON 只保留结构与素材引用，不包含媒体原文件或任务历史。</p>
    {error && <div role="alert" className="transfer-error">{error}</div>}
    <div className="transfer-section"><h3><Package size={17} />镜头素材包</h3>
      <p>包含镜头选用图片、视频、角色/场景参考图、分镜 CSV 和来源清单。只导出人工选用的版本。</p>
      <button className="secondary" disabled={pending || !!warnings} onClick={() => void run(async () => {
        if (uncertain) {
          const jobs = await readHistory();
          const building = jobs.find(item => item.status === 'building');
          if (building) { setJob(building); setUncertain(false); return; }
        }
        setPreview(await api.exportPreview(projectId)); setPartial(false); setJob(null); setUncertain(false);
      })}>检查素材包</button>
      {preview && <div className="export-check"><strong>{preview.shotCount} 个镜头 · {preview.fileCount} 个媒体文件 · {(preview.totalBytes / 1024 / 1024).toFixed(2)} MiB</strong>
        {preview.issues.length ? <><ul>{preview.issues.map((i, n) => <li key={n}>{i.message} <button className="secondary" disabled={pending} onClick={()=>navigate(i)}>定位处理</button></li>)}</ul><label className="partial-option"><input type="checkbox" checked={partial} disabled={pending} onChange={e => setPartial(e.target.checked)} />仅导出已有素材，并在清单中保留全部缺失项</label></> : <p>选用素材完整，文件校验通过。</p>}
        <button className="primary" disabled={pending || uncertain || !!warnings || !!preview.issues.length && !partial} onClick={() => void run(async () => {
          const started=Date.now();
          try{const created = await api.exportCreate(preview, partial); setJob(created);setUncertain(false);
            try { localStorage.setItem(key, created.id); } catch { /* Server history is authoritative. */ }
            await readHistory();
          }catch(e){if(!(e as {status?:number}).status||(e as {status:number}).status>=500){setUncertain(true);const jobs=await readHistory().catch(()=>[]);const found=jobs.find(j=>j.revision===preview.revision&&Date.parse(j.createdAt)>=started);if(found){setJob(found);setUncertain(false);}else throw new Error('提交结果尚未确认，请刷新服务端导出记录并检查；不会自动重新打包。');}else throw e;}
        })}><Download size={14} />{preview.issues.length ? '打包已有素材' : '打包完整素材'}</button>
      </div>}
      {job && <div className="export-result" role="status">{job.status === 'building' ? <><LoaderCircle size={15} className="spin" />正在打包，可关闭窗口或刷新后继续查看。</> : job.status === 'failed' ? <span>{job.error}</span> : <><span>{job.allowPartial && job.issues.length ? '部分素材包已完成 · 缺失项已写入清单' : '素材包已完成'} · {((job.size ?? 0) / 1024 / 1024).toFixed(2)} MiB</span><a className="primary" href={`/api/exports/${job.id}/file`} download>下载 ZIP</a></>}</div>}
    </div>
    <div className="transfer-section"><h3>服务端交付记录</h3><button className="secondary" onClick={()=>void readHistory().catch(e=>setError(e.message))}>刷新导出记录</button>{uncertain&&<p className="media-error">提交结果不明，请先检查这些记录。确认没有新记录后，可重新检查素材包再明确打包。</p>}
      {history.map(j=><article className="export-check" key={j.id}><strong>{new Date(j.createdAt).toLocaleString('zh-CN')} · revision {j.revision}</strong><small>{j.allowPartial&&j.issues.length?'部分包':'完整包'} · {j.status==='building'?'正在打包':j.status==='failed'?'失败':'完成'} · {j.sources?.map(s=>s==='mock'?'模拟':s==='generated'?'真实接口':'上传').join(' / ')??'旧记录来源见包内清单'}</small>{j.issues.map((i,n)=><p key={n}>{i.message}</p>)}{j.error&&<p className="media-error">{j.error}</p>}{j.status==='succeeded'?<a className="secondary download-link" href={`/api/exports/${j.id}/file`} download>重新下载（校验原 ZIP）</a>:j.status==='building'&&<button className="secondary" onClick={()=>setJob(j)}>查看打包状态</button>}</article>)}
      <button className="secondary" disabled={!cursor} onClick={()=>void readHistory(cursor!).catch(e=>setError(e.message))}>更早的导出记录</button>
    </div>
    <div className="transfer-section"><h3><FileJson size={17} />JSON 结构快照</h3>
      <button className="secondary" disabled={pending || !!warnings} onClick={() => void run(async () => { const value = await api.structure(projectId); downloadJson(value, `${value.name}-结构快照.json`); })}><Download size={14} />导出 JSON 结构</button>
    </div>
    <div className="transfer-section"><h3><Upload size={17} />导入为新项目</h3><p>支持本应用的 JSON 结构快照。外部素材会提示缺失；不会执行任务或获取远端文件。</p>
      <label>选择 JSON 文件<input aria-label="选择 JSON 文件" type="file" accept=".json,application/json" disabled={pending || !!warnings} onChange={e => {
        const file = e.target.files?.[0]; if (!file) return;
        if (file.size > MAX_IMPORT_BYTES) { setError('JSON 文件不得超过 2 MiB'); return; }
        void file.text().then(setText).catch(() => setError('无法读取文件'));
      }} /></label>
      <label>或粘贴 JSON<textarea aria-label="导入 JSON 内容" value={text} disabled={pending || !!warnings} onChange={e => setText(e.target.value)} placeholder="粘贴结构快照…" /></label>
      <button className="primary" disabled={pending || !text.trim() || !!warnings} onClick={() => void run(async () => {
        if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('JSON 内容不得超过 2 MiB');
        const raw: unknown = JSON.parse(text); ProjectTransferSchema.parse(raw);
        const result = await api.import(raw); setWarnings(result.warnings); adopt(result.project);
      })}>导入并打开新项目</button>
      {warnings && <div className="export-check" role="status"><strong>新项目已创建并打开</strong><ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul><button className="secondary" onClick={close}>开始编辑</button></div>}
    </div>
  </section></div>;
}
