import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, MiniMap, SelectionMode, useReactFlow, type NodeChange, type EdgeChange, type Connection, type Edge } from '@xyflow/react';
import { Plus, Minus, Scan, Undo2, Redo2, Copy, Trash2, MousePointer2 } from 'lucide-react';
import { connectionError, type CanvasEdge, type CanvasNode } from '../../../../../packages/shared/src/index.ts';
import { TextNode } from './TextNode.tsx';
import { DomainNode } from './DomainNode.tsx';
import type { Node } from '@xyflow/react';
import { useEditor } from './editor-store.ts';

type FlowNode = Node<CanvasNode['data']>;
const nodeTypes = { text: TextNode, reference: DomainNode, shot: DomainNode, media: DomainNode, script: DomainNode, imageGenerate: DomainNode, videoGenerate: DomainNode };
const defaultEdgeOptions = { style: { stroke: '#72658e', strokeWidth: 1.5 } };
export function Canvas({ notify, active = true }: { notify: (message: string) => void; active?: boolean }) {
  const doc = useEditor(s => s.doc), selected = useEditor(s => s.selected), selectedEdges = useEditor(s => s.selectedEdges);
  const past = useEditor(s => s.past), future = useEditor(s => s.future);
  const flow = useReactFlow<FlowNode>();
  const [boxSelect, setBoxSelect] = useState(false);
  const nodeCache = useRef(new Map<string, { source: CanvasNode; flow: FlowNode }>());
  const nodes = useMemo(() => {
    const next = new Map<string, { source: CanvasNode; flow: FlowNode }>(), selectedIds = new Set(selected);
    const result = doc.nodes.map(n => {
      const old = nodeCache.current.get(n.id), chosen = selectedIds.has(n.id);
      const item = old?.source === n && old.flow.selected === chosen ? old : { source: n, flow: { ...n, selected: chosen, style: { width: n.width, height: n.height }, dragHandle: '.node-handle-bar' } };
      next.set(n.id, item); return item.flow;
    }); nodeCache.current = next; return result;
  }, [doc.nodes, selected]);
  const edges: Edge[] = useMemo(() => doc.edges.map(e => ({ ...e, selected: selectedEdges.includes(e.id), type: 'smoothstep' })), [doc.edges, selectedEdges]);
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const s = useEditor.getState();
    const selections = changes.filter(c => c.type === 'select');
    if (selections.length) {
      const ids = new Set(s.selected);
      for (const c of selections) { if (c.selected) ids.add(c.id); else ids.delete(c.id); }
      s.select([...ids], s.selectedEdges);
    }
    const mutations = changes.filter(c => c.type === 'position' || c.type === 'dimensions' && c.resizing !== undefined || c.type === 'remove');
    const removed = mutations.filter(c => c.type === 'remove');
    if (removed.length) s.update(d => ({ ...d, nodes: d.nodes.filter(n => !removed.some(c => c.id === n.id)), edges: d.edges.filter(e => !removed.some(c => c.id === e.source || c.id === e.target)) }));
    const geometry: Parameters<typeof s.geometry>[0] = [];
    for (const c of mutations) {
      if (c.type === 'position' && c.position) geometry.push({ id: c.id, position: c.position });
      if (c.type === 'dimensions' && c.dimensions) geometry.push({ id: c.id, width: c.dimensions.width, height: c.dimensions.height });
    }
    s.geometry(geometry);
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const s = useEditor.getState(), ids = new Set(s.selectedEdges);
    for (const c of changes) if (c.type === 'select') { if (c.selected) ids.add(c.id); else ids.delete(c.id); }
    s.select(s.selected, [...ids]);
    const removed = changes.filter(c => c.type === 'remove').map(c => c.id);
    if (removed.length) s.update(d => ({ ...d, edges: d.edges.filter(e => !removed.includes(e.id)) }));
  }, []);
  const connect = useCallback((connection: Connection) => {
    const s = useEditor.getState(), error = connectionError(s.doc.nodes, s.doc.edges, connection);
    if (error) return notify(error);
    s.update(d => ({ ...d, edges: [...d.edges, { ...connection, id: crypto.randomUUID(), sourceHandle: connection.sourceHandle as CanvasEdge['sourceHandle'], targetHandle: connection.targetHandle as CanvasEdge['targetHandle'], inputOrder: Math.max(-1, ...d.edges.filter(e => e.target === connection.target).map(e => e.inputOrder ?? 0)) + 1 }] }));
  }, [notify]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.target instanceof HTMLElement && (event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
      const s = useEditor.getState(), mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? s.redo() : s.undo(); }
      else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); s.redo(); }
      else if (!active) return;
      else if (mod && event.key.toLowerCase() === 'c' && s.selected.length) { event.preventDefault(); s.copy(); notify('卡片已复制，按 Ctrl+V 粘贴'); }
      else if (mod && event.key.toLowerCase() === 'v') { event.preventDefault(); s.paste(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { if (s.selected.length || s.selectedEdges.length) { event.preventDefault(); s.remove(); } }
      else if (event.key.toLowerCase() === 'f') { event.preventDefault(); void flow.fitView({ padding: 0.2, duration: 250 }); }
      else if (event.key === 'Escape') s.select([]);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [flow, notify, active]);
  return <div className="canvas-shell">
    <ReactFlow<FlowNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onConnect={connect} defaultViewport={doc.viewport} minZoom={0.1} maxZoom={2} colorMode="dark"
      onNodeDragStart={() => useEditor.getState().begin()} onNodeDragStop={() => useEditor.getState().end()}
      onSelectionDragStart={() => useEditor.getState().begin()} onSelectionDragStop={() => useEditor.getState().end()}
      onMoveEnd={(_event, viewport) => { if (active) useEditor.getState().viewport(viewport); }}
      onConnectEnd={(_event, state) => { if (!state.isValid && state.toHandle && state.fromHandle) {
        const s = useEditor.getState(); const error = connectionError(s.doc.nodes, s.doc.edges, { source: state.fromNode!.id, target: state.toNode!.id, sourceHandle: state.fromHandle.id, targetHandle: state.toHandle.id });
        if (error) notify(error);
      } }}
      isValidConnection={c => !connectionError(useEditor.getState().doc.nodes, useEditor.getState().doc.edges, c)}
      deleteKeyCode={null} selectionKeyCode="Shift" multiSelectionKeyCode="Control" selectionMode={SelectionMode.Partial}
      panOnDrag={boxSelect ? [1] : [0, 1]} selectionOnDrag={boxSelect} onPaneClick={() => useEditor.getState().select([])}
      defaultEdgeOptions={defaultEdgeOptions}>
      <Background variant={BackgroundVariant.Dots} color="#35343e" gap={24} size={1} />
      <MiniMap position="bottom-right" nodeColor="#76658f" maskColor="#101014b8" pannable zoomable />
    </ReactFlow>
    {!doc.nodes.length && <div className="empty-canvas"><div className="empty-symbol"><MousePointer2 size={30} /></div><h2>让故事从这里开始</h2><p>添加一张卡片，写下剧本、角色或镜头构想。</p><button className="primary" onClick={() => useEditor.getState().add('script', { x: 160, y: 120 })}><Plus size={15} />添加剧本卡片</button></div>}
    <div className="canvas-caption"><span className="live-dot" />创作画布 <span>/</span> {doc.nodes.length} 张卡片 · {doc.edges.length} 条引用</div>
    <div className="canvas-tools">
      <button aria-label={boxSelect ? '返回平移模式' : '开启框选模式'} aria-pressed={boxSelect} title="框选工具（也可按住 Shift 拖动）" onClick={() => setBoxSelect(!boxSelect)}><MousePointer2 size={17} /></button><i />
      <button aria-label="撤销" title="撤销 Ctrl+Z" disabled={!past.length} onClick={() => useEditor.getState().undo()}><Undo2 size={17} /></button>
      <button aria-label="重做" title="重做 Ctrl+Shift+Z" disabled={!future.length} onClick={() => useEditor.getState().redo()}><Redo2 size={17} /></button><i />
      <button aria-label="复制所选卡片" disabled={!selected.length} onClick={() => { useEditor.getState().copy(); useEditor.getState().paste(); }}><Copy size={16} /></button>
      <button aria-label="删除所选内容" disabled={!selected.length && !selectedEdges.length} onClick={() => useEditor.getState().remove()}><Trash2 size={16} /></button><i />
      <button aria-label="缩小" onClick={() => void flow.zoomOut()}><Minus size={17} /></button>
      <span>{Math.round(doc.viewport.zoom * 100)}%</span>
      <button aria-label="放大" onClick={() => void flow.zoomIn()}><Plus size={17} /></button>
      <button aria-label="适配所有卡片" title="适配内容 F" onClick={() => void flow.fitView({ padding: 0.2, duration: 250 })}><Scan size={17} /></button>
    </div>
    <div className="canvas-hint">拖动画布平移 <b>·</b> 滚轮缩放 <b>·</b> Shift + 拖动框选</div>
  </div>;
}
