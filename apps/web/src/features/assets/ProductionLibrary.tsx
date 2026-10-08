import { useEffect, useRef, useState } from 'react';
import { Upload, Plus, ArrowUp, ArrowDown, ArrowUpRight, Film, UserRound, MapPin, RefreshCw } from 'lucide-react';
import { useEditor } from '../canvas/editor-store.ts';
import { useAssets } from './asset-store.ts';
import { MediaPreview } from './MediaPreview.tsx';
import { api } from '../../lib/api.ts';
import type { Asset } from '../../../../../packages/shared/src/index.ts';
import { prepareShot } from '../../../../../packages/shared/src/production.ts';
import { useTasks } from '../tasks/task-store.ts';
import { AssetRepair } from './AssetRepair.tsx';
import { isGenerationNode } from '../../../../../packages/shared/src/index.ts';
import { fingerprint, resolveInput } from '../../../../../packages/shared/src/generation.ts';
import { useProviders } from '../tasks/providers-store.ts';
import { nodeInputView } from '../canvas/input-view.ts';

function InputChangeNotice({ nodeId }: { nodeId: string }) {
  const doc = useEditor(s => nodeInputView(s.inputDoc, nodeId)), assets = useAssets(s => s.assets);
  const node = doc.nodes.find(n => n.id === nodeId);
  const generation = useTasks(s => s.generations.find(g => g.id === (node && isGenerationNode(node) ? node.data.selectedGenerationId : null)));
  const capabilities = useProviders(s => s.capabilities), [hash, setHash] = useState('');
  let signature = '';
  try { signature = JSON.stringify(resolveInput(doc, nodeId, assets, capabilities)); } catch { /* An unavailable input also needs review. */ }
  useEffect(() => { let live = true; setHash(''); if (signature) void fingerprint(JSON.parse(signature)).then(value => { if (live) setHash(value); }); return () => { live = false; }; }, [signature]);
  return generation && (!signature || hash && generation.inputFingerprint !== hash)
    ? <small className="stale-warning">{node?.type === 'imageGenerate' ? '图片' : '视频'}输入已变化或不可用 · 保留已选旧输出</small> : null;
}

export type LibraryView = 'canvas' | 'assets' | 'characters' | 'scenes' | 'shots';
export function ProductionLibrary({ view, focus, focusNode, add, notify }: {
  view: Exclude<LibraryView, 'canvas'>; focus: (type: 'reference' | 'shot', id: string) => void;
  add: (type: 'character' | 'scene' | 'shot' | 'media', asset?: Asset) => void; notify: (text: string) => void;
  focusNode: (id: string) => void;
}) {
  const doc = useEditor(s => s.inputDoc), projectId = useEditor(s => s.projectId),tasks=useTasks(s=>s.tasks);
  const assets = useAssets(s => s.assets), error = useAssets(s => s.error);
  const [uploading, setUploading] = useState(false), [search, setSearch] = useState('');
  const [choices,setChoices]=useState<Record<string,string>>({});
  const preparation=(shotId:string)=><div className="shot-preparation">{(['image','video'] as const).map(kind=>{
    const nodes=doc.nodes.filter(n=>n.type===(kind==='image'?'imageGenerate':'videoGenerate')&&n.data.shotId===shotId),key=`${shotId}:${kind}`;
    return <div key={kind}>{nodes.length>1&&<select aria-label={`选择${kind==='image'?'图片':'视频'}节点 ${shotId}`} value={choices[key]??''} onChange={e=>setChoices(s=>({...s,[key]:e.target.value}))}><option value="">选择已有节点</option>{nodes.map(n=><option key={n.id} value={n.id}>{'title' in n.data?n.data.title:n.id}</option>)}</select>}<button className="secondary" disabled={nodes.length>1&&!choices[key]} onClick={()=>{
      try{const result=prepareShot(useEditor.getState().doc,shotId,kind,assets,choices[key]);if(result.created)useEditor.getState().update(()=>result.document);focusNode(result.nodeId);notify(result.created?'节点与引用已准备，可撤销；检查输入后手动生成。':'已定位已有生成节点。');}catch(e){notify((e as Error).message);}
    }}>{nodes.length?'打开':'准备'}{kind==='image'?'图片':'视频'}节点</button></div>;
  })}</div>;
  const readiness=(shotId:string)=>{
    const shot=doc.shots.find(s=>s.id===shotId)!;
    const image=assets.find(a=>a.id===shot.selectedImageAssetId),video=assets.find(a=>a.id===shot.selectedVideoAssetId);
    const nodeIds=new Set(doc.nodes.filter(n=>(n.type==='imageGenerate'||n.type==='videoGenerate')&&n.data.shotId===shotId).map(n=>n.id));
    const active=tasks.filter(t=>nodeIds.has(t.nodeId)&&['queued','submitting','running','persisting','unknown'].includes(t.status));
    return `${image?.status==='ready'?'图片已选且文件可用':'图片需要处理'} · ${video?.status==='ready'?'视频已选且文件可用':'视频需要处理'}${active.length?` · ${active.length} 个活动/待确认任务`:image?.status==='ready'&&video?.status==='ready'?' · 可进入交付检查':''}`;
  };
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: File[]) => {
    setUploading(true); let completed = 0;
    try {
      for (const file of files) {
        if (file.size > (file.type.startsWith('image/') ? 20 : 100) * 1024 * 1024) { notify(`${file.name} 超出大小限制`); continue; }
        try { const asset = await api.upload(projectId, file); useAssets.getState().add(projectId, asset); completed++; }
        catch (e) { notify(`${file.name}：${(e as Error).message}`); }
      }
      if (completed) notify(`已上传 ${completed} 个素材，原文件保存在本机`);
    } finally { setUploading(false); if (input.current) input.current.value = ''; }
  };
  const title = { assets: '素材库', characters: '角色', scenes: '场景', shots: '分镜清单' }[view];
  const refs = doc.references.filter(r => r.kind === (view === 'characters' ? 'character' : 'scene'));
  return <section className="production-library">
    <div className="library-heading"><div><span className="eyebrow">STORY PRODUCTION</span><h1>{title}</h1><p>{view === 'assets' ? '集中管理图片与视频，跨镜头复用。上传不会调用模型。' : view === 'shots' ? '按剧情组织镜头。调整顺序不会改变画布上的位置。' : '一个设定，多处引用。修改会同步到使用它的分镜。'}</p></div>
      {view === 'assets' ? <button className="primary" disabled={uploading} onClick={() => input.current?.click()}><Upload size={15} />{uploading ? '正在上传…' : '上传素材'}</button> : <button className="primary" onClick={() => add(view === 'shots' ? 'shot' : view === 'characters' ? 'character' : 'scene')}><Plus size={15} />{view === 'shots' ? '新建分镜' : `新建${title}`}</button>}
    </div>
    <input ref={input} type="file" aria-label="上传图片或视频" hidden multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" onChange={e => void upload(Array.from(e.target.files ?? []))} />
    {view === 'assets' && <><div className="library-toolbar"><input aria-label="搜索素材" placeholder="搜索素材名称…" value={search} onChange={e => setSearch(e.target.value)} /><button className="secondary" onClick={() => void useAssets.getState().load(projectId)}><RefreshCw size={14} />刷新状态</button></div><p className="library-help">PNG / JPEG / WebP ≤ 20 MB · MP4 / WebM ≤ 100 MB。视频仅点击播放时加载。</p>{error && <p className="media-error">{error}</p>}
      <AssetRepair notify={notify}/><div className="asset-grid">{assets.filter(a => a.name.includes(search)).map(a => <article className="asset-tile" key={a.id}><MediaPreview id={a.id} playable /><div className="asset-info"><strong title={a.name}>{a.name}</strong><small>{a.mediaType === 'image' ? '图片' : '视频'} · {a.source === 'mock' ? '模拟测试素材' : a.source === 'generated' ? '真实接口素材' : '上传素材'} · {(a.size / 1024 / 1024).toFixed(2)} MB{a.width ? ` · ${a.width} × ${a.height}` : ''}</small><button className="secondary full" onClick={() => add('media', a)}><Plus size={13} />放入画布</button></div></article>)}</div>{!assets.length && <div className="library-empty"><Upload size={34} /><h2>让故事有画面</h2><p>上传角色参考、场景图片或已有镜头视频。</p></div>}</>}
    {(view === 'characters' || view === 'scenes') && <><div className="asset-grid">{refs.map(r => <article className="asset-tile" key={r.id}><MediaPreview key={r.selectedAssetId} id={r.selectedAssetId} /><div className="asset-info"><strong>{r.name || '未命名'}</strong><small>{r.assetIds.length} 张参考图 · {doc.shots.filter(s => s.sceneId === r.id || s.characterIds.includes(r.id)).length} 个镜头引用</small><p>{r.description || '还没有描述'}</p><button className="secondary full" onClick={() => focus('reference', r.id)}>编辑{title}<ArrowUpRight size={13} /></button></div></article>)}</div>{!refs.length && <div className="library-empty">{view === 'characters' ? <UserRound size={34} /> : <MapPin size={34} />}<h2>建立故事中的{title}</h2><p>添加设定，再从素材库选择参考图片。</p></div>}</>}
    {view === 'shots' && <><div className="shot-list">{[...doc.shots].sort((a,b) => a.order-b.order).map((s,i) => <article className="shot-row" key={s.id}><div className="shot-order">{String(i+1).padStart(2,'0')}</div><button className="shot-summary" onClick={() => focus('shot', s.id)}><strong>{s.number} · {s.title || '未命名分镜'}</strong><p>{s.description || '点击填写镜头画面'}</p><small>{s.framing} · {s.duration}s · {doc.references.find(r => r.id === s.sceneId)?.name ?? '未设场景'} · {s.characterIds.length} 个角色 · {s.selectedImageAssetId ? '已选图片' : '未选图片'} · {s.selectedVideoAssetId ? '已选视频' : '未选视频'}</small><small className="shot-readiness">{readiness(s.id)}</small>{doc.nodes.filter(n => (n.type === "imageGenerate" || n.type === "videoGenerate") && n.data.shotId === s.id).map(n => <InputChangeNotice key={n.id} nodeId={n.id} />)}</button>{preparation(s.id)}<div className="shot-row-actions"><button aria-label={`上移分镜 ${s.number}`} className="icon-button" disabled={i === 0} onClick={() => useEditor.getState().moveShot(s.id,-1)}><ArrowUp size={16} /></button><button aria-label={`下移分镜 ${s.number}`} className="icon-button" disabled={i === doc.shots.length-1} onClick={() => useEditor.getState().moveShot(s.id,1)}><ArrowDown size={16} /></button></div></article>)}</div>{!doc.shots.length && <div className="library-empty"><Film size={34} /><h2>把故事拆成镜头</h2><p>手工创建分镜，明确画面、人物、对白与运镜。</p></div>}<p className="library-help">序号是剧情顺序；镜头编号可独立编辑。删除画布卡片会保留分镜记录。</p></>}
  </section>;
}
