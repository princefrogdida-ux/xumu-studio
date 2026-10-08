import { create } from 'zustand';
import { duplicateSelection, emptyDocument, newShot, isGenerationNode, type GenerationNode, type GenerationData, type Asset, type Reference, type Shot, type TextData, type CanvasDocument, type CanvasNode, type Category, type Project } from '../../../../../packages/shared/src/index.ts';
import { mockCapabilities, kindOf } from '../../../../../packages/shared/src/generation.ts';

type EditSnapshot = Pick<CanvasDocument, 'nodes' | 'edges' | 'references' | 'shots'> & { name: string };
interface EditorState {
  projectId: string; name: string; doc: CanvasDocument; inputDoc: CanvasDocument; version: number;
  selected: string[]; selectedEdges: string[]; past: EditSnapshot[]; future: EditSnapshot[];
  gesture?: EditSnapshot; clipboard?: CanvasDocument;
  load: (project: Project) => void;
  update: (fn: (doc: CanvasDocument) => CanvasDocument, record?: boolean) => void;
  geometry: (changes: { id: string; position?: { x: number; y: number }; width?: number; height?: number }[]) => void;
  viewport: (viewport: CanvasDocument['viewport']) => void;
  rename: (name: string) => void;
  begin: () => void; end: () => void; undo: () => void; redo: () => void;
  select: (nodes: string[], edges?: string[]) => void;
  add: (category: Category, point: { x: number; y: number }) => void;
  editNode: (id: string, data: Partial<TextData>) => void;
  addGeneration: (type: GenerationNode['type'], point: {x:number;y:number}) => void;
  editGeneration: (id: string, data: Partial<GenerationData>) => void;
  addReference: (kind: Reference['kind'], point: { x: number; y: number }) => void;
  addShot: (point: { x: number; y: number }) => void;
  addMedia: (asset: Asset, point: { x: number; y: number }) => void;
  placeRecord: (type: 'reference' | 'shot', id: string, point: { x: number; y: number }) => void;
  editReference: (id: string, data: Partial<Reference>) => void;
  editShot: (id: string, data: Partial<Shot>) => void;
  moveShot: (id: string, delta: number) => void;
  deleteRecord: (type: 'reference' | 'shot', id: string) => void;
  remove: () => void; copy: () => void; paste: () => void; demo: () => void;
}
const snapshot = (s: Pick<EditorState, 'doc' | 'name'>): EditSnapshot => structuredClone({ nodes: s.doc.nodes, edges: s.doc.edges, references: s.doc.references, shots: s.doc.shots, name: s.name });
const labels: Record<Category, string> = { script: '剧本构思', character: '角色设定', scene: '场景设定', note: '文本卡片' };
function reuseRecords<T extends { id: string }>(next: T[], previous: T[]) {
  const old = new Map(previous.map(item => [item.id, item]));
  return next.map(item => { const before = old.get(item.id); return before && JSON.stringify(before) === JSON.stringify(item) ? before : item; });
}

export const useEditor = create<EditorState>((set, get) => ({
  projectId: '', name: '', doc: emptyDocument(), inputDoc: emptyDocument(), version: 0,
  selected: [], selectedEdges: [], past: [], future: [],
  load: project => { const doc = structuredClone(project.document); set({ projectId: project.id, name: project.name, doc, inputDoc: doc, version: 0,
    selected: [], selectedEdges: [], past: [], future: [], gesture: undefined, clipboard: undefined }); },
  update: (fn, record = true) => {
    const state = get(), next = fn(structuredClone(state.doc));
    if (JSON.stringify(next) === JSON.stringify(state.doc)) return;
    // Reuse unchanged records after a business edit; geometry uses the cheaper dedicated path below.
    next.nodes = reuseRecords(next.nodes, state.doc.nodes); next.edges = reuseRecords(next.edges, state.doc.edges);
    next.references = reuseRecords(next.references, state.doc.references); next.shots = reuseRecords(next.shots, state.doc.shots);
    set({ doc: next, inputDoc: next, version: state.version + 1,
      ...(record && !state.gesture ? { past: [...state.past.slice(-79), snapshot(state)], future: [] } : {}) });
  },
  geometry: changes => {
    const s = get(), byId = new Map<string, (typeof changes)[number]>();
    for (const c of changes) byId.set(c.id, { ...byId.get(c.id), ...c });
    let changed = false;
    const nodes = s.doc.nodes.map(n => {
      const c = byId.get(n.id); if (!c) return n;
      const position = c.position ?? n.position, width = c.width ?? n.width, height = c.height ?? n.height;
      if (position.x === n.position.x && position.y === n.position.y && width === n.width && height === n.height) return n;
      changed = true; return { ...n, position, width, height };
    });
    if (changed) set({ doc: { ...s.doc, nodes }, version: s.version + 1,
      ...(!s.gesture ? { past: [...s.past.slice(-79), snapshot(s)], future: [] } : {}) });
  },
  viewport: viewport => {
    const s = get(), old = s.doc.viewport;
    if (old.x !== viewport.x || old.y !== viewport.y || old.zoom !== viewport.zoom) set({ doc: { ...s.doc, viewport }, version: s.version + 1 });
  },
  rename: name => {
    const state = get();
    if (name === state.name) return;
    set({ name, version: state.version + 1,
      ...(!state.gesture ? { past: [...state.past.slice(-79), snapshot(state)], future: [] } : {}) });
  },
  begin: () => { if (!get().gesture) set({ gesture: snapshot(get()) }); },
  end: () => {
    const state = get();
    if (!state.gesture) return;
    const changed = JSON.stringify(state.gesture) !== JSON.stringify(snapshot(state));
    set({ gesture: undefined, ...(changed ? { past: [...state.past.slice(-79), state.gesture], future: [] } : {}) });
  },
  undo: () => {
    get().end(); const s = get(), last = s.past.at(-1);
    if (!last) return;
    const doc = { ...s.doc, nodes: last.nodes, edges: last.edges, references: last.references, shots: last.shots };
    set({ doc, inputDoc: doc, name: last.name,
      past: s.past.slice(0, -1), future: [snapshot(s), ...s.future], selected: [], selectedEdges: [], version: s.version + 1 });
  },
  redo: () => {
    const s = get(), first = s.future[0]; if (!first) return;
    const doc = { ...s.doc, nodes: first.nodes, edges: first.edges, references: first.references, shots: first.shots };
    set({ doc, inputDoc: doc, name: first.name,
      past: [...s.past, snapshot(s)], future: s.future.slice(1), selected: [], selectedEdges: [], version: s.version + 1 });
  },
  select: (selected, selectedEdges = []) => set({ selected, selectedEdges }),
  add: (category, position) => {
    const id = crypto.randomUUID();
    get().update(doc => ({ ...doc, nodes: [...doc.nodes, { id, type: 'text', position, width: 300, height: 230,
      data: { title: labels[category], content: '', category } }] }));
    set({ selected: [id], selectedEdges: [] });
  },
  editNode: (id, data) => get().update(doc => ({ ...doc, nodes: doc.nodes.map(n => n.id === id && n.type === 'text' ? { ...n, data: { ...n.data, ...data } } : n) })),
  addGeneration: (type,position) => {
    const id=crypto.randomUUID();
    const node:GenerationNode={id,type,position,width:320,height:300,data:{mode:'mock',title:type==='script'?'模拟剧本拆解':type==='imageGenerate'?'模拟图片生成':'模拟视频生成',prompt:'',model:'',ratio:'16:9',duration:5,count:2,shotCount:3,scenario:'success',shotId:null,selectedGenerationId:null,selectedAssetId:null}};
    node.data.model=mockCapabilities.models[kindOf(node)];
    get().update(doc=>({...doc,nodes:[...doc.nodes,node]}));get().select([id]);
  },
  editGeneration: (id,data) => get().update(doc=>({...doc,nodes:doc.nodes.map(n=>n.id===id&&isGenerationNode(n)?{...n,data:{...n.data,...data}}:n)})),
  addReference: (kind, point) => {
    get().begin();
    const id = crypto.randomUUID();
    get().update(doc => ({ ...doc, references: [...doc.references, { id, kind, name: kind === 'character' ? '新角色' : '新场景', description: '', assetIds: [], selectedAssetId: null }] }));
    get().placeRecord('reference', id, point); get().end();
  },
  addShot: point => {
    get().begin(); const id = crypto.randomUUID();
    get().update(doc => ({ ...doc, shots: [...doc.shots, newShot(id, doc.shots.length)] }));
    get().placeRecord('shot', id, point); get().end();
  },
  addMedia: (asset, position) => {
    const id = crypto.randomUUID();
    get().update(doc => ({ ...doc, nodes: [...doc.nodes, { id, type: 'media', position, width: 300, height: 280, data: { assetId: asset.id, mediaType: asset.mediaType } }] }));
    get().select([id]);
  },
  placeRecord: (type, recordId, position) => {
    const id = crypto.randomUUID();
    const node: CanvasNode = type === 'reference' ? { id, type, position, width: 300, height: 280, data: { referenceId: recordId } } : { id, type, position, width: 320, height: 300, data: { shotId: recordId } };
    get().update(doc => ({ ...doc, nodes: [...doc.nodes, node] })); get().select([id]);
  },
  editReference: (id, data) => get().update(doc => ({ ...doc, references: doc.references.map(r => r.id === id ? { ...r, ...data, id: r.id, kind: r.kind } : r) })),
  editShot: (id, data) => get().update(doc => ({ ...doc, shots: doc.shots.map(s => s.id === id ? { ...s, ...data, id: s.id, order: s.order } : s) })),
  moveShot: (id, delta) => get().update(doc => {
    const shots = [...doc.shots].sort((a, b) => a.order - b.order), from = shots.findIndex(s => s.id === id), to = from + delta;
    if (from < 0 || to < 0 || to >= shots.length) return doc;
    [shots[from], shots[to]] = [shots[to], shots[from]];
    return { ...doc, shots: shots.map((s, order) => ({ ...s, order })) };
  }),
  deleteRecord: (type, id) => get().update(doc => {
    const nodes = doc.nodes.filter(n => !(type === 'shot' && n.type === 'shot' && n.data.shotId === id || type === 'reference' && n.type === 'reference' && n.data.referenceId === id));
    const ids = new Set(nodes.map(n => n.id));
    if (type === 'shot') nodes.forEach(n=>{if(isGenerationNode(n)&&n.data.shotId===id)n.data.shotId=null;});
    return { ...doc, nodes, edges: doc.edges.filter(e => ids.has(e.source) && ids.has(e.target)),
      references: type === 'reference' ? doc.references.filter(r => r.id !== id) : doc.references,
      shots: (type === 'shot' ? doc.shots.filter(s => s.id !== id) : doc.shots.map(s => ({ ...s, sceneId: s.sceneId === id ? null : s.sceneId, characterIds: s.characterIds.filter(c => c !== id) }))).sort((a,b) => a.order-b.order).map((s, order) => ({ ...s, order })) };
  }),
  remove: () => {
    const s = get();
    get().update(doc => ({ ...doc, nodes: doc.nodes.filter(n => !s.selected.includes(n.id)),
      edges: doc.edges.filter(e => !s.selectedEdges.includes(e.id) && !s.selected.includes(e.source) && !s.selected.includes(e.target)) }));
    set({ selected: [], selectedEdges: [] });
  },
  copy: () => {
    const s = get();
    if (!s.selected.length) return;
    set({ clipboard: { ...structuredClone(s.doc), nodes: structuredClone(s.doc.nodes.filter(n => s.selected.includes(n.id))),
      edges: structuredClone(s.doc.edges.filter(e => s.selected.includes(e.source) && s.selected.includes(e.target))) } });
  },
  paste: () => {
    const s = get(); if (!s.clipboard?.nodes.length) return;
    const validNodes = s.clipboard.nodes.filter(n => n.type !== 'shot' && n.type !== 'reference' || n.type === 'shot' && s.doc.shots.some(r => r.id === n.data.shotId) || n.type === 'reference' && s.doc.references.some(r => r.id === n.data.referenceId));
    const copied = duplicateSelection(s.clipboard, validNodes.map(n => n.id), () => crypto.randomUUID());
    const nodes = copied.nodes.slice(s.clipboard.nodes.length), edges = copied.edges.slice(s.clipboard.edges.length);
    get().update(doc => ({ ...doc, nodes: [...doc.nodes, ...nodes], edges: [...doc.edges, ...edges] }));
    set({ selected: nodes.map(n => n.id), selectedEdges: [], clipboard: { ...emptyDocument(), nodes, edges } });
  },
  demo: () => {
    const nodes: CanvasNode[] = Array.from({ length: 20 }, (_, index) => ({
      id: crypto.randomUUID(), type: 'text', position: { x: index % 5 * 380, y: Math.floor(index / 5) * 290 + 800 },
      width: 300, height: 200, data: { title: `交互测试 ${String(index + 1).padStart(2, '0')}`, content: '20 节点交互样例\n\n试试框选、移动、复制与撤销。连线只建立文字引用，不执行生成。', category: 'note' },
    }));
    const edges = nodes.slice(1).map((n, i) => ({ id: crypto.randomUUID(), source: nodes[i].id, target: n.id,
      sourceHandle: 'text-out' as const, targetHandle: 'text-in' as const }));
    get().update(doc => ({ ...doc, nodes: [...doc.nodes, ...nodes], edges: [...doc.edges, ...edges] }));
    set({ selected: nodes.map(n => n.id), selectedEdges: [] });
  },
}));
