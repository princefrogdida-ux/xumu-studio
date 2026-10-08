import { memo, useEffect, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { Clapperboard, Image, UserRound, MapPin } from 'lucide-react';
import { inputPorts, outputPorts, isGenerationNode } from '../../../../../packages/shared/src/index.ts';
import { resolveInput, fingerprint, statusLabels } from '../../../../../packages/shared/src/generation.ts';
import { useTasks } from '../tasks/task-store.ts';
import { useEditor } from './editor-store.ts';
import { useAssets } from '../assets/asset-store.ts';
import { MediaPreview } from '../assets/MediaPreview.tsx';
import { useProviders } from '../tasks/providers-store.ts';
import { nodeInputView } from './input-view.ts';

export const DomainNode = memo(function DomainNode({ id, selected }: NodeProps) {
  const doc = useEditor(s => nodeInputView(s.inputDoc, id)), assets = useAssets(s => s.assets);
  const node = doc.nodes.find(n => n.id === id);
  const task=useTasks(s=>s.tasks.find(t=>t.nodeId===id)),generation=useTasks(s=>s.generations.find(g=>g.id===(node&&isGenerationNode(node)?node.data.selectedGenerationId:null)));
  const capabilities=useProviders(s=>s.capabilities);
  const [hash,setHash]=useState('');
  let signature='';try{if(node&&isGenerationNode(node))signature=JSON.stringify(resolveInput(doc,id,assets,capabilities));}catch{/* Invalid input is displayed by the inspector. */}
  useEffect(()=>{let live=true;setHash('');if(signature)void fingerprint(JSON.parse(signature)).then(h=>{if(live)setHash(h);});return()=>{live=false;};},[signature]);
  if (!node || node.type === 'text') return null;
  const generated=isGenerationNode(node)?node:undefined;
  const shot = node.type === 'shot' ? doc.shots.find(s => s.id === node.data.shotId) : undefined;
  const ref = node.type === 'reference' ? doc.references.find(r => r.id === node.data.referenceId) : undefined;
  const asset = node.type === 'media' ? assets.find(a => a.id === node.data.assetId) : undefined;
  const selectedAsset=generated?assets.find(a=>a.id===generated.data.selectedAssetId):undefined;
  const Icon = shot ? Clapperboard : ref?.kind === 'character' ? UserRound : ref ? MapPin : Image;
  const kind = shot ? 'shot' : ref?.kind ?? 'media';
  return <article className={`studio-node ${kind} ${selected ? 'is-selected' : ''}`}>
    <NodeResizer isVisible={!!selected} minWidth={220} minHeight={170} maxWidth={1200} maxHeight={1200} onResizeStart={() => useEditor.getState().begin()} onResizeEnd={() => useEditor.getState().end()} />
    <div className="node-handle-bar"><span className="node-type"><Icon size={14} />{generated?`${generated.data.mode==='real'?'真实':'模拟'}${generated.type==='script'?'剧本拆解':generated.type==='imageGenerate'?'图片生成':'视频生成'}`:shot ? `分镜 ${shot.number}` : ref ? ref.kind === 'character' ? '角色参考' : '场景参考' : '媒体素材'}</span>{shot && <small>{shot.duration}s</small>}</div>
    <div className="node-content"><h3>{generated?.data.title ?? shot?.title ?? ref?.name ?? asset?.name ?? '素材'}</h3>
      {generated?<><small>{task?`${statusLabels[task.status]} · 上次${task.mode==='real'?'真实':'模拟'}任务`:'尚未生成'}</small><small>{generated.data.mode==='real'?'当前中转站模式 · 费用未知':'当前本地模拟 · 无费用'}</small>{generation&&(!hash||generation.inputFingerprint!==hash)&&<p className="stale-warning">输入已变化 · 保留旧输出</p>}{generated.data.selectedAssetId?<MediaPreview id={generated.data.selectedAssetId}/>:<p>{generated.data.prompt||'在右侧检查输入，点击生成。完成后人工选择输出。'}</p>}</>:shot ? <><div className="shot-tags">{shot.framing} · {doc.references.find(r => r.id === shot.sceneId)?.name ?? '未设场景'}</div><p>{shot.description || '在右侧编辑镜头画面…'}</p><div className="shot-cast">{shot.characterIds.map(id => doc.references.find(r => r.id === id)?.name).join(' / ') || '未引用角色'}</div></> : <MediaPreview key={ref?.selectedAssetId ?? asset?.id} id={ref?.selectedAssetId ?? asset?.id} />}
    </div>
    <div className="node-footer"><span className="node-dot" />{generated?selectedAsset?.source==='mock'?'已选模拟素材':selectedAsset?.source==='generated'?'已选真实接口素材':'输出待人工选择':shot ? `剧情顺序 ${shot.order + 1}` : ref ? '共享参考 · 非生成结果' : asset?.source==='mock'?'模拟测试素材':asset?.source==='generated'?'真实接口素材':'已上传素材'}<span className="node-output">{shot ? '图片 / 视频提示词' : '稳定素材引用'}</span></div>
    {inputPorts(node).map((p, i, list) => <Handle key={p.id} type="target" id={p.id} position={Position.Left} style={{ top: `${(i+1)/(list.length+1)*100}%` }} title={p.label} aria-label={p.label} />)}
    {outputPorts(node).map((p, i, list) => <Handle key={p.id} type="source" id={p.id} position={Position.Right} style={{ top: `${(i+1)/(list.length+1)*100}%` }} title={p.label} aria-label={p.label} />)}
  </article>;
});
