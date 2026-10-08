import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type ComponentProps } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { ArrowUpRight, Check, ChevronDown, ChevronLeft, Clapperboard, Copy, FileText, FolderOpen, Image, Info, Layers3, LoaderCircle, LockKeyhole, MapPin, Plus, Search, ShieldCheck, Sparkles, StickyNote, UserRound, Video, X, Download, AlertCircle, FlaskConical, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { DocumentSchema, freePosition, nodeText, isGenerationNode, type Asset, type CanvasDocument, type Category, type Project, type ProjectSummary } from '../../../packages/shared/src/index.ts';
import { api, downloadJson } from './lib/api.ts';
import { SaveQueue, type SaveStatus } from './lib/save-queue.ts';
import { useEditor } from './features/canvas/editor-store.ts';
import { Canvas } from './features/canvas/Canvas.tsx';
import { DomainInspector } from './features/canvas/DomainInspector.tsx';
import type { LibraryView } from './features/assets/ProductionLibrary.tsx';
import { useAssets } from './features/assets/asset-store.ts';
import { taskPollDelay, useTasks } from './features/tasks/task-store.ts';
import { GenerationInspector } from './features/tasks/GenerationInspector.tsx';
import { useProviders } from './features/tasks/providers-store.ts';
import { LocalHealth } from './features/tasks/LocalHealth.tsx';
import { PanelBoundary } from './lib/PanelBoundary.tsx';
import { runtimeInfo } from '../../../packages/shared/src/runtime.ts';
let ProductionLibrary: ComponentType<ComponentProps<typeof import('./features/assets/ProductionLibrary.tsx').ProductionLibrary>> = lazy(() => import('./features/assets/ProductionLibrary.tsx').then(m => ({ default: m.ProductionLibrary })));
let TaskPanel: ComponentType<ComponentProps<typeof import('./features/tasks/TaskPanel.tsx').TaskPanel>> = lazy(() => import('./features/tasks/TaskPanel.tsx').then(m => ({ default: m.TaskPanel })));
let TransferPanel: ComponentType<ComponentProps<typeof import('./features/projects/TransferPanel.tsx').TransferPanel>> = lazy(() => import('./features/projects/TransferPanel.tsx').then(m => ({ default: m.TransferPanel })));

const categoryInfo = {
  script: { label: '剧本构思', icon: FileText, subtitle: '故事从一句话开始' },
  character: { label: '角色设定', icon: UserRound, subtitle: '塑造故事中的人物' },
  scene: { label: '场景设定', icon: MapPin, subtitle: '建立世界与氛围' },
  note: { label: '文本卡片', icon: StickyNote, subtitle: '记录每一个灵感' },
};
const saveLabels: Record<SaveStatus, string> = { saved: '已保存到本地', pending: '有未同步更改', saving: '正在保存', error: '保存失败 · 草稿已保留', conflict: '版本冲突 · 草稿已保留' };
const draftKey = (id: string) => `drama-studio:draft:${id}`;
type Draft = { document: CanvasDocument; name: string; baseRevision: number };

function Workspace() {
  const realEnabled=useProviders(s=>s.capabilities.some(c=>c.mode==='real'&&c.enabled));
  const name = useEditor(s => s.name), doc = useEditor(s => s.inputDoc), selected = useEditor(s => s.selected), id = useEditor(s => s.projectId);
  const [panelVersion,setPanelVersion]=useState(0);
  const retryPanels=()=>{
    ProductionLibrary=lazy(()=>import('./features/assets/ProductionLibrary.tsx').then(m=>({default:m.ProductionLibrary})));
    TaskPanel=lazy(()=>import('./features/tasks/TaskPanel.tsx').then(m=>({default:m.TaskPanel})));
    TransferPanel=lazy(()=>import('./features/projects/TransferPanel.tsx').then(m=>({default:m.TransferPanel})));
    setPanelVersion(v=>v+1);
  };
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
  const [view, setView] = useState<LibraryView | 'tasks'>('canvas');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved'), [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState(''), [modal, setModal] = useState<'projects' | 'create' | 'about' | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]), [search, setSearch] = useState('');
  const [newName, setNewName] = useState(''), [template, setTemplate] = useState<'empty' | 'story'>('empty');
  const [busy, setBusy] = useState(false), [draft, setDraft] = useState<Draft | null>(null), [inspector, setInspector] = useState(true);
  const [transferProject, setTransferProject] = useState<string | null>(null);
  const [openingPanel, setOpeningPanel] = useState(false), panelRequest = useRef(0);
  const queue = useRef<SaveQueue | null>(null), activeId = useRef(''), toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingGeometry = useRef(false);
  const flushCurrent=useCallback(async()=>{
    if(pendingGeometry.current){const s=useEditor.getState();queue.current?.queue(s.doc,s.name.trim()||'未命名项目');pendingGeometry.current=false;}
    await queue.current?.flush();
  },[]);
  const flow = useReactFlow();
  const notify = useCallback((message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4500); }, []);

  // Resolve the module before changing views: keep the mounted editor responsive and avoid a fresh Suspense reveal delay.
  const openPanel = async (next: LibraryView | 'tasks' | 'transfer') => {
    const sequence = ++panelRequest.current, projectId = useEditor.getState().projectId;
    setOpeningPanel(next !== 'canvas');
    try {
      if (next === 'transfer') TransferPanel = (await import('./features/projects/TransferPanel.tsx')).TransferPanel;
      else if (next === 'tasks') TaskPanel = (await import('./features/tasks/TaskPanel.tsx')).TaskPanel;
      else if (next !== 'canvas') ProductionLibrary = (await import('./features/assets/ProductionLibrary.tsx')).ProductionLibrary;
      if (sequence !== panelRequest.current || projectId !== useEditor.getState().projectId) return;
      if (next === 'transfer') setTransferProject(projectId); else setView(next);
    } catch { if (sequence === panelRequest.current) notify('面板加载失败，请再次点击入口重试；编辑内容和保存会话仍保留。'); }
    finally { if (sequence === panelRequest.current) setOpeningPanel(false); }
  };

  const showCanvas = useCallback(() => {
    panelRequest.current++; setOpeningPanel(false); setView('canvas');
  }, []);

  const adopt = useCallback((project: Project) => {
    panelRequest.current++; setOpeningPanel(false);
    queue.current?.stop(); activeId.current = project.id; pendingGeometry.current=false;
    queue.current = new SaveQueue(project,
      (revision, snapshot) => api.save(project.id, revision, snapshot.document, snapshot.name),
      (status, error) => { setSaveStatus(status); setSaveError(error); },
      (snapshot, revision) => {
        try {
          if (snapshot) localStorage.setItem(draftKey(project.id), JSON.stringify({ ...snapshot, baseRevision: revision }));
          else localStorage.removeItem(draftKey(project.id));
        } catch { notify('浏览器草稿存储不可用，请保持页面打开并确认服务端保存成功。'); }
      });
    useEditor.getState().load(project); setSaveStatus('saved'); setSaveError(''); setDraft(null); showCanvas();
    void useAssets.getState().load(project.id);
    void useTasks.getState().load(project.id);
    try {
      localStorage.setItem('drama-studio:last-project', project.id);
      const raw = localStorage.getItem(draftKey(project.id));
      if (raw) {
        const cached = JSON.parse(raw) as Draft;
        cached.document = DocumentSchema.parse(cached.document);
        if (typeof cached.name !== 'string' || !cached.name.trim() || cached.name.length > 120) throw new Error('无效草稿名称');
        if (JSON.stringify(cached.document) !== JSON.stringify(project.document) || cached.name !== project.name) setDraft(cached);
        else localStorage.removeItem(draftKey(project.id));
      }
    } catch { notify('本地草稿无法读取；服务器中的项目仍可正常使用。'); }
  }, [notify]);

  const initialize = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const list = await api.list(); setProjects(list);
      let last = ''; try { last = localStorage.getItem('drama-studio:last-project') ?? ''; } catch { /* Server storage still works. */ }
      const project = list.length ? await api.get(list.some(p => p.id === last) ? last : list[0].id) : await api.create('无尽夏日', 'story');
      adopt(project);
    } catch (error) { setLoadError(error instanceof Error ? error.message : '无法连接本地服务'); }
    finally { setLoading(false); }
  }, [adopt]);

  useEffect(() => { void initialize(); void useProviders.getState().load(); return () => { queue.current?.stop(); clearTimeout(toastTimer.current); }; }, [initialize]);
  useEffect(()=>{
    if(!id)return;let stopped=false,refreshing=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{if(stopped||refreshing)return;refreshing=true;clearTimeout(timer);await useTasks.getState().load(id);refreshing=false;if(!stopped)timer=setTimeout(()=>void poll(),taskPollDelay(useTasks.getState().activeCount,document.hidden));};
    const focus=()=>{if(!document.hidden)void poll();};void poll();window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{stopped=true;clearTimeout(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[id]);
  useEffect(() => useEditor.subscribe((state, previous) => {
    if(state.projectId!==activeId.current||state.version===0)return;
    if(state.version!==previous.version&&state.gesture&&state.inputDoc===previous.inputDoc&&state.doc!==previous.doc){
      pendingGeometry.current=true;setSaveStatus('pending');return;
    }
    if(state.version!==previous.version||previous.gesture&&!state.gesture&&pendingGeometry.current){
      pendingGeometry.current=false;queue.current?.queue(state.doc,state.name.trim()||'未命名项目');
    }
  }), []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (queue.current?.dirty||pendingGeometry.current) { event.preventDefault(); event.returnValue = ''; } };
    const keydown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flushCurrent().catch(e => notify(e.message)); } };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keydown); };
  }, [notify]);

  const safely = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true);
      try { await flushCurrent(); await action(); }
    catch (error) { notify(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const openProjects = async () => {
    setModal('projects'); setSearch('');
    try { setProjects(await api.list()); } catch (error) { notify((error as Error).message); }
  };
  const add = (category: Category) => {
    const element = document.querySelector('.canvas-shell');
    const rect = element?.getBoundingClientRect();
    const point = flow.screenToFlowPosition({ x: (rect?.left ?? 300) + (rect?.width ?? 800) / 2 - 120, y: (rect?.top ?? 80) + (rect?.height ?? 600) / 2 - 100 });
    useEditor.getState().add(category, point); setInspector(true);
  };
  const addProduction = (type: 'character' | 'scene' | 'shot' | 'media', asset?: Asset) => {
    const current=useEditor.getState().doc;
    const point = freePosition(current, { x: -current.viewport.x / current.viewport.zoom + 120, y: -current.viewport.y / current.viewport.zoom + 100 });
    const s = useEditor.getState();
    if (type === 'shot') s.addShot(point);
    else if (type === 'media' && asset) s.addMedia(asset, point);
    else if (type === 'character' || type === 'scene') s.addReference(type, point);
    setInspector(true); if (type === 'media') showCanvas();
  };
  const focusNode = (nodeId:string) => {
    if(!useEditor.getState().doc.nodes.some(n=>n.id===nodeId)){notify('画布卡片已删除，任务与历史仍保留。');return;}
    showCanvas();setInspector(true);useEditor.getState().select([nodeId]);
    requestAnimationFrame(()=>requestAnimationFrame(()=>void flow.fitView({nodes:[{id:nodeId}],padding:0.35,maxZoom:1,duration:250})));
  };
  const focusRecord = (type: 'reference' | 'shot', recordId: string) => {
    const s = useEditor.getState();
    const found = s.doc.nodes.find(n => type === 'reference' ? n.type === 'reference' && n.data.referenceId === recordId : n.type === 'shot' && n.data.shotId === recordId);
    if(found)focusNode(found.id);
    else if(window.confirm('业务记录仍在，但尚未放入画布。现在放入一张引用卡片并定位吗？')){s.placeRecord(type,recordId,freePosition(s.doc,{x:100,y:100}));focusNode(useEditor.getState().selected[0]);}
  };
  const node = doc.nodes.find(n => selected.includes(n.id));
  const upstreamEdge = node && doc.edges.find(e => e.target === node.id);
  const upstream = doc.nodes.find(n => n.id === upstreamEdge?.source);

  if (loading || loadError) return <div className="startup"><div className="brand-mark"><Clapperboard size={24} /></div><h1>叙幕 Studio</h1>
    {loading ? <><LoaderCircle className="spin" size={23} /><p>正在打开本地创作空间…</p></> : <><p>{loadError}</p><span>请确认项目 API 正在运行，然后重试。</span><button className="primary" onClick={() => void initialize()}>重新连接</button></>}
  </div>;

  return <div className="app">
    <header className="topbar">
      <button className="brand" aria-label="项目列表" onClick={() => void openProjects()}><span className="brand-mark"><Clapperboard size={21} /></span><strong>叙幕<span>Studio</span></strong></button>
      <span className="top-divider" />
      <button className="project-back" aria-label="打开项目列表" onClick={() => void openProjects()}><ChevronLeft size={17} /></button>
      <div className="project-name"><input aria-label="项目名称" value={name} maxLength={120} onFocus={() => useEditor.getState().begin()}
        onChange={e => useEditor.getState().rename(e.target.value)} onBlur={() => { useEditor.getState().rename(name.trim() || '未命名项目'); useEditor.getState().end(); }} /><ChevronDown size={13} /></div>
      <div className={`save-state ${saveStatus}`} title={saveError || 'SQLite 本地持久化'}>{saveStatus === 'saving' ? <LoaderCircle size={13} className="spin" /> : saveStatus === 'saved' ? <Check size={13} /> : <AlertCircle size={13} />}{saveLabels[saveStatus]}</div>
      <div className="top-actions"><span className="mode-badge"><FlaskConical size={12} />{realEnabled?'真实调用已开启':'默认模拟 · 真实调用关闭'}</span><button className="icon-button" aria-label="关于当前版本" onClick={() => setModal('about')}><Info size={17} /></button>
        <button className="export-button" onClick={() => void openPanel("transfer")}><Download size={14} />导入 / 导出</button>
        <div className="avatar">创</div></div>
    </header>
    <div className="workspace">
      <aside className="sidebar">
        <div className="workspace-label">创作空间<span>{runtimeInfo.stage}</span></div>
        <button className="sidebar-nav" onClick={() => void openProjects()}><FolderOpen size={16} />我的项目<ArrowUpRight size={13} /></button>
        <nav className="production-nav" aria-label="制作空间" aria-busy={openingPanel}>{([{ key: 'canvas', label: '无限画布', Icon: Layers3 }, { key: 'assets', label: '素材库', Icon: Image }, { key: 'characters', label: '角色', Icon: UserRound }, { key: 'scenes', label: '场景', Icon: MapPin }, { key: 'shots', label: '分镜清单', Icon: Clapperboard },{key:'tasks',label:'任务与历史',Icon:LoaderCircle}] as const).map(({ key, label, Icon }) => <button key={key} aria-pressed={view === key} onClick={() => void openPanel(key)}><Icon size={15} /><span>{label}</span>{key === 'shots' && <small>{doc.shots.length}</small>}</button>)}</nav>
        <div className="sidebar-separator" />
        <div className="section-label">添加到画布<span>＋</span></div>
        <div className="node-palette">{(Object.keys(categoryInfo) as Category[]).map(category => {
          const item = categoryInfo[category], Icon = item.icon;
          return <button key={category} className={`palette-item ${category}`} onClick={() => { showCanvas(); if (category === 'character' || category === 'scene') addProduction(category); else add(category); }}><span className="palette-icon"><Icon size={17} /></span><span><strong>{item.label}</strong><small>{item.subtitle}</small></span><Plus size={14} /></button>;
        })}</div>
        <button className="palette-item" onClick={() => { showCanvas(); addProduction('shot'); }}><span className="palette-icon"><Clapperboard size={17} /></span><span><strong>分镜卡片</strong><small>画面、对白与运镜</small></span><Plus size={14} /></button>
        <div className="node-palette">{([{type:'script',label:'剧本拆解',Icon:FileText},{type:'imageGenerate',label:'图片生成',Icon:Image},{type:'videoGenerate',label:'视频生成',Icon:Video}] as const).map(({type,label,Icon})=><button key={type} className="palette-item" onClick={()=>{const point=freePosition(useEditor.getState().doc,{x:120,y:100});useEditor.getState().addGeneration(type,point);showCanvas();setInspector(true);}}><span className="palette-icon"><Icon size={17}/></span><span><strong>{label}</strong><small>默认模拟 · 可选择中转站</small></span><Plus size={14}/></button>)}</div>
        <div className="sidebar-bottom"><div className="tip-card"><Sparkles size={16} /><strong>先构思，再制作</strong><p>把剧本、人物和场景铺在画布上，让故事的关系清晰可见。</p></div>
          <button className="sample-button" onClick={() => { useEditor.getState().demo(); setTimeout(() => void flow.fitView({ padding: 0.15, duration: 250 }), 80); notify('已添加 20 张测试卡片，可用撤销一次移除'); }}><Plus size={13} />添加 20 节点交互样例</button>
          <div className="local-indicator"><ShieldCheck size={13} />数据保存在这台电脑</div><LocalHealth/></div>
      </aside>
      <main className="main-stage">
        <div className="stage-tabs"><span className="active-tab"><Layers3 size={14} />{{ canvas: '无限画布', assets: '素材库', characters: '角色', scenes: '场景', shots: '分镜清单',tasks:'任务与历史' }[view]}</span><span className="stage-description">故事，在这里连接</span>
          <button className="icon-button" aria-label={inspector ? '收起属性面板' : '展开属性面板'} onClick={() => setInspector(!inspector)}>{inspector ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button></div>
        {(saveStatus === 'error' || saveStatus === 'conflict') && <div className="error-banner"><AlertCircle size={16} /><span>{saveError}</span>
          <button onClick={() => downloadJson({ name, document: useEditor.getState().doc }, `${name}-未同步草稿.json`)}>导出草稿</button>
          {saveStatus === 'error' ? <button onClick={() => void queue.current?.flush().catch(e => notify(e.message))}>重试保存</button> : <button onClick={() => {
            if (window.confirm('读取最新版本会放弃当前未同步更改。建议先导出草稿，确定继续吗？')) void api.get(id).then(adopt).catch(e => notify(e.message));
          }}>读取最新版本</button>}</div>}
        <div className="canvas-view" style={{ display: view === 'canvas' ? 'flex' : 'none' }}><Canvas key={id} notify={notify} active={view === 'canvas'} /></div>
        {view!=='canvas'&&<PanelBoundary key={`${id}:${view}:${panelVersion}`} retry={retryPanels}><Suspense fallback={<p className="library-help">正在打开面板…</p>}>{view === 'tasks'?<TaskPanel notify={notify} focus={focusNode}/>:<ProductionLibrary key={`${id}:${view}`} view={view} focus={focusRecord} focusNode={focusNode} add={addProduction} notify={notify} />}</Suspense></PanelBoundary>}
      </main>
      {inspector && <aside className="inspector"><div className="inspector-header"><span>{node ? '卡片属性' : '创作指南'}</span><span>{node ? node.type.toUpperCase() : 'START'}</span></div>
        {node && isGenerationNode(node)?<GenerationInspector key={`${id}:${node.id}`} node={node} beforeSubmit={async()=>{if(draft)throw new Error('请先处理未同步草稿');await flushCurrent();}} notify={notify}/>:node && node.type !== 'text' ? <DomainInspector key={node.id} node={node} /> : node?.type==='text' ? <div className="inspector-content"><div className={`selected-type ${node.data.category}`}>{(() => { const Icon = categoryInfo[node.data.category].icon; return <Icon size={18} />; })()}{categoryInfo[node.data.category].label}</div>
          <label>卡片标题<input aria-label="卡片标题" value={node.data.title} maxLength={120} onFocus={() => useEditor.getState().begin()} onBlur={() => useEditor.getState().end()} onChange={e => useEditor.getState().editNode(node.id, { title: e.target.value })} /></label>
          <label>内容<textarea aria-label="卡片内容" value={node.data.content} maxLength={30000} placeholder="写下故事、人物或画面…" onFocus={() => useEditor.getState().begin()} onBlur={() => useEditor.getState().end()} onChange={e => useEditor.getState().editNode(node.id, { content: e.target.value })} /></label>
          <div className="field-count">{node.data.content.length.toLocaleString()} / 30,000</div>
          <label>卡片分类<select aria-label="卡片分类" value={node.data.category} onChange={e => useEditor.getState().editNode(node.id, { category: e.target.value as Category })}>{(Object.keys(categoryInfo) as Category[]).map(k => <option key={k} value={k}>{categoryInfo[k].label}</option>)}</select></label>
          <div className="input-preview"><span>上游文字引用</span>{upstream ? <><strong>{upstream.type === 'text' ? upstream.data.title : '分镜提示词'}</strong><p>{nodeText(doc, upstream, upstreamEdge?.sourceHandle) || '上游暂无内容'}</p></> : <p>从另一张卡片的右侧端口连入，建立文字引用。</p>}</div>
          {selected.length > 1 && <div className="multi-note">已选中 {selected.length} 张卡片，正在编辑第一张。</div>}
          <button className="secondary full" onClick={() => { useEditor.getState().copy(); useEditor.getState().paste(); }}><Copy size={14} />复制所选卡片</button>
        </div> : <div className="guide"><div className="guide-visual"><Clapperboard size={28} /><span /><span /></div><h2>每个好故事，<br />都从一个想法开始。</h2><p>这里是你的短剧构思空间。先铺开想法，再把它们连接起来。</p>
          <ol><li><span>01</span><div><strong>写下故事</strong><p>添加剧本卡片，描述剧情与情绪。</p></div></li><li><span>02</span><div><strong>建立人物与场景</strong><p>用卡片整理角色设定和视觉氛围。</p></div></li><li><span>03</span><div><strong>模拟制作流程</strong><p>检查输入后生成，人工选图，再制作模拟视频。</p></div></li></ol><div className="guide-note"><Info size={15} /><span>当前为 V1 优化开发版。支持结构导入和素材包导出；真实服务闭环仍待验收。</span></div></div>}
      </aside>}
    </div>
    {toast && <div role="status" className="toast"><Check size={15} />{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={13} /></button></div>}
    {draft && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="恢复未同步草稿"><span className="eyebrow">本地恢复</span><h2>发现未同步的创作草稿</h2><p>浏览器中保留了上次尚未保存到服务端的内容。{draft.baseRevision !== queue.current?.revision ? '服务端版本已变化，恢复将以草稿替换当前画布，请谨慎选择。' : '你可以恢复它，也可以使用服务端已保存的版本。'}</p><div className="modal-actions"><button className="secondary" onClick={() => { localStorage.removeItem(draftKey(id)); setDraft(null); }}>使用服务端版本</button><button className="primary" onClick={() => {
      useEditor.getState().begin(); useEditor.getState().update(() => draft.document); useEditor.getState().rename(draft.name); useEditor.getState().end(); setDraft(null); notify('草稿已恢复，正在保存');
    }}>恢复草稿</button></div></section></div>}
    {modal && <div className="modal-backdrop" onClick={() => !busy && setModal(null)}><section className={`modal ${modal === 'projects' ? 'projects-modal' : ''}`} role="dialog" aria-modal="true" aria-label={modal === 'projects' ? '我的项目' : modal === 'create' ? '新建项目' : '关于当前版本'} onClick={e => e.stopPropagation()}>
      <button className="modal-close icon-button" aria-label="关闭窗口" disabled={busy} onClick={() => setModal(null)}><X size={19} /></button>
      {modal === 'projects' && <><span className="eyebrow">YOUR WORKSPACE</span><h2>我的创作项目</h2><div className="project-list-toolbar"><div className="search"><Search size={15} /><input aria-label="搜索项目" placeholder="搜索项目名称" value={search} onChange={e => setSearch(e.target.value)} /></div><button className="primary" onClick={() => { setNewName(''); setTemplate('empty'); setModal('create'); }}><Plus size={15} />新建项目</button></div>
        <div className="project-list">{projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).map(p => <div className="project-row" key={p.id}><span className="project-icon"><Clapperboard size={20} /></span><button disabled={busy} onClick={() => void safely(async () => { adopt(await api.get(p.id)); setModal(null); })}><strong>{p.name}</strong><small>{p.nodeCount} 张卡片 · {new Date(p.updatedAt).toLocaleString('zh-CN')}</small></button><button className="icon-button" aria-label={`复制项目 ${p.name}`} title="复制项目" disabled={busy} onClick={() => void safely(async () => { adopt(await api.duplicate(p.id)); setModal(null); notify('已打开项目副本'); })}><Copy size={16} /></button>{p.id === id && <span className="current-tag">当前</span>}</div>)}{!projects.filter(p => p.name.includes(search)).length && <p className="no-results">没有找到匹配的项目。</p>}</div></>}
      {modal === 'create' && <form onSubmit={e => { e.preventDefault(); void safely(async () => { adopt(await api.create(newName.trim() || '未命名项目', template)); setModal(null); }); }}><span className="eyebrow">NEW STORY</span><h2>开启一个新故事</h2><p>每个项目拥有独立的画布与保存记录。</p><label>项目名称<input autoFocus aria-label="新项目名称" maxLength={120} value={newName} placeholder="例如：雨夜来信" onChange={e => setNewName(e.target.value)} /></label><div className="template-options"><button type="button" className={template === 'empty' ? 'chosen' : ''} onClick={() => setTemplate('empty')}><Plus size={21} /><strong>空白画布</strong><small>从零开始构思</small></button><button type="button" className={template === 'story' ? 'chosen' : ''} onClick={() => setTemplate('story')}><Clapperboard size={21} /><strong>故事构思样例</strong><small>四张文本卡片</small></button></div><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setModal('projects')}>返回</button><button className="primary" disabled={busy}>{busy ? '正在创建…' : '创建项目'}<ArrowUpRight size={15} /></button></div></form>}
      {modal === 'about' && <><span className="eyebrow">DEVELOPMENT PREVIEW</span><h2>叙幕 Studio · V1 优化</h2><p>当前已实现画布、素材、分镜、模拟生成、任务恢复、历史版本、JSON 导入与镜头素材包。</p><div className="about-block"><FlaskConical size={18} /><div><strong>模拟模式 · 无模型调用</strong><p>图片是本地占位图，视频是固定 CC0 测试片段，分镜为规则生成草稿。已加入中转站适配，默认关闭真实调用，实际服务尚未验证。</p></div></div><p>数据保存在本机项目目录的 data 文件夹。结构快照和交付素材包不能替代包含任务及私有回执的完整备份。</p><button className="primary full" onClick={() => setModal(null)}>继续创作</button></>}
    </section></div>}
    {openingPanel && <p className="toast" role="status">正在打开面板…</p>}
    {transferProject && <PanelBoundary key={`transfer:${panelVersion}`} retry={retryPanels}><Suspense fallback={<p className="toast">正在打开导入导出…</p>}>
      <TransferPanel projectId={transferProject} beforeAction={async () => { if (draft) throw new Error('请先处理未同步草稿'); await flushCurrent(); }} adopt={adopt} close={() => setTransferProject(null)} navigate={issue => {
        setTransferProject(null);
        if (issue.shotId) focusRecord('shot', issue.shotId);
        else if (issue.taskId) void useTasks.getState().detail(issue.taskId).then(t => focusNode(t.nodeId)).catch(e => notify(e.message));
        else { void openPanel('assets'); notify('在素材库的恢复当前引用面板选择替代素材。'); }
      }} />
    </Suspense></PanelBoundary>}
  </div>;
}

export function App() { return <ReactFlowProvider><Workspace /></ReactFlowProvider>; }


