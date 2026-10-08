import { useEditor } from './editor-store.ts';
import { useAssets } from '../assets/asset-store.ts';
import { MediaPreview } from '../assets/MediaPreview.tsx';
import { nodeText, type CanvasNode, type Reference, type Shot } from '../../../../../packages/shared/src/index.ts';
import { Download, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';

const begin = () => useEditor.getState().begin(), end = () => useEditor.getState().end();
function Field({ label, value, change, long = false, max = 10000 }: { label: string; value: string; change: (value: string) => void; long?: boolean; max?: number }) {
  return <label>{label}{long ? <textarea aria-label={label} value={value} maxLength={max} onFocus={begin} onBlur={end} onChange={e => change(e.target.value)} /> : <input aria-label={label} value={value} maxLength={max} onFocus={begin} onBlur={end} onChange={e => change(e.target.value)} />}</label>;
}

export function DomainInspector({ node }: { node: CanvasNode }) {
  const doc = useEditor(s => s.doc), assets = useAssets(s => s.assets);
  const ref = node.type === 'reference' ? doc.references.find(r => r.id === node.data.referenceId) : undefined;
  const shot = node.type === 'shot' ? doc.shots.find(s => s.id === node.data.shotId) : undefined;
  const asset = node.type === 'media' ? assets.find(a => a.id === node.data.assetId) : undefined;
  const updateRef = (data: Partial<Reference>) => ref && useEditor.getState().editReference(ref.id, data);
  const updateShot = (data: Partial<Shot>) => shot && useEditor.getState().editShot(shot.id, data);
  const incoming = doc.edges.filter(e => e.target === node.id).sort((a,b) => (a.inputOrder ?? 0) - (b.inputOrder ?? 0));
  return <div className="inspector-content domain-inspector">
    {ref && <><div className={`selected-type ${ref.kind}`}>{ref.kind === 'character' ? '角色设定' : '场景设定'} · 共享记录</div><MediaPreview key={ref.selectedAssetId} id={ref.selectedAssetId} />
      <Field label="设定名称" value={ref.name} max={120} change={name => updateRef({ name })} /><Field label="设定描述" value={ref.description} long change={description => updateRef({ description })} />
      <label>参考图片（最多 20 张）</label><div className="reference-picker">{assets.filter(a => a.mediaType === 'image').map(a => <div className="reference-option" key={a.id}><label className="check-row"><input type="checkbox" aria-label={`引用图片 ${a.name}`} checked={ref.assetIds.includes(a.id)} disabled={!ref.assetIds.includes(a.id) && (ref.assetIds.length >= 20 || a.status !== 'ready')} onChange={e => {
        const ids = e.target.checked ? [...ref.assetIds, a.id] : ref.assetIds.filter(id => id !== a.id);
        updateRef({ assetIds: ids, selectedAssetId: ids.includes(ref.selectedAssetId ?? '') ? ref.selectedAssetId : ids[0] ?? null });
      }} /><span>{a.name}{a.status !== 'ready' ? '（不可用）' : ''}</span></label>{ref.assetIds.includes(a.id) && <button className={`reference-default ${a.id === ref.selectedAssetId ? 'chosen' : ''}`} onClick={() => updateRef({ selectedAssetId: a.id })}>{a.id === ref.selectedAssetId ? '当前参考' : '设为默认'}</button>}</div>)}{!assets.some(a => a.mediaType === 'image') && <p>先到素材库上传图片。</p>}</div>
      <p className="library-help">更换默认图会同步到所有引用卡片。原图片保留在素材库中。</p><button className="secondary full" onClick={() => useEditor.getState().deleteRecord('reference',ref.id)}><Trash2 size={14} />移除设定及引用（可撤销）</button></>}
    {shot && <><div className="selected-type">分镜 · 剧情顺序 {shot.order + 1}</div><div className="compact-fields"><Field label="镜头编号" max={40} value={shot.number} change={number => updateShot({ number })} /><label>预计时长（秒）<input aria-label="预计时长（秒）" type="number" min={0.1} max={600} step={0.1} value={shot.duration} onFocus={begin} onBlur={end} onChange={e => { const duration = Number(e.target.value); if (duration >= .1 && duration <= 600) updateShot({ duration }); }} /></label></div>
      <Field label="分镜标题" max={120} value={shot.title} change={title => updateShot({ title })} /><Field label="画面描述" value={shot.description} long change={description => updateShot({ description })} />
      <label>场景引用<select aria-label="场景引用" value={shot.sceneId ?? ''} onChange={e => updateShot({ sceneId: e.target.value || null })}><option value="">未设置</option>{doc.references.filter(r => r.kind === 'scene').map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label>角色引用（最多 50 个）</label><div className="reference-picker">{doc.references.filter(r => r.kind === 'character').map(r => <label className="check-row" key={r.id}><input type="checkbox" aria-label={`引用角色 ${r.name}`} checked={shot.characterIds.includes(r.id)} disabled={!shot.characterIds.includes(r.id) && shot.characterIds.length >= 50} onChange={e => updateShot({ characterIds: e.target.checked ? [...shot.characterIds, r.id] : shot.characterIds.filter(id => id !== r.id) })} />{r.name}</label>)}{!doc.references.some(r => r.kind === 'character') && <p>请先建立角色设定。</p>}</div>
      <Field label="景别" max={120} value={shot.framing} change={framing => updateShot({ framing })} /><Field label="动作" max={4000} value={shot.action} change={action => updateShot({ action })} /><Field label="运镜" max={1000} value={shot.camera} change={camera => updateShot({ camera })} /><Field label="对白" value={shot.dialogue} long change={dialogue => updateShot({ dialogue })} />
      <details open><summary>图片与视频提示词</summary><Field label="图片提示词" value={shot.imagePrompt} long change={imagePrompt => updateShot({ imagePrompt })} /><Field label="视频提示词" value={shot.videoPrompt} long change={videoPrompt => updateShot({ videoPrompt })} /></details>
      <details open><summary>最终镜头选用素材</summary><p className="library-help">在生成历史中点击“设为镜头选用”同步版本。模拟素材不会标为真实模型结果。</p><label>选用图片</label><MediaPreview key={shot.selectedImageAssetId} id={shot.selectedImageAssetId}/><label>选用视频</label>{shot.selectedVideoAssetId?<MediaPreview key={shot.selectedVideoAssetId} id={shot.selectedVideoAssetId} playable/>:<p className="library-help">尚未选择镜头视频</p>}</details>
      <button className="secondary full" onClick={() => useEditor.getState().deleteRecord('shot',shot.id)}><Trash2 size={14} />移除分镜（可撤销）</button></>}
    {node.type === 'media' && <><div className="selected-type">{node.data.mediaType === 'image' ? '图片' : '视频'}素材</div><MediaPreview key={node.data.assetId} id={node.data.assetId} playable /><h3>{asset?.name ?? '素材记录不可用'}</h3><p className="library-help">来源：{asset?.source==='mock'?'模拟测试素材':asset?.source==='generated'?'真实接口生成':'手工上传'}。删除画布卡片不会删除原文件。</p>{asset && <a className="secondary download-link" href={`/api/assets/${asset.id}/file?download=1`} download><Download size={14} />下载原文件</a>}
      <label>替换素材引用<select aria-label="替换素材引用" value={node.data.assetId} onChange={e => useEditor.getState().update(d => ({ ...d, nodes: d.nodes.map(n => n.id === node.id && n.type === 'media' ? { ...n, data: { ...n.data, assetId: e.target.value } } : n) }))}>{assets.filter(a => a.mediaType === node.data.mediaType).map(a => <option key={a.id} value={a.id}>{a.name}{a.status !== 'ready' ? '（不可用）' : ''}</option>)}</select></label></>}
    {!!incoming.length && <div className="input-preview"><span>连线引用 · 不触发生成</span>{incoming.map((edge, index) => {
      const source = doc.nodes.find(n => n.id === edge.source)!;
      const assetId = source.type === 'media' ? source.data.assetId : source.type === 'reference' ? doc.references.find(r => r.id === source.data.referenceId)?.selectedAssetId : null;
      const move = (delta: number) => useEditor.getState().update(d => { const ordered = [...incoming]; [ordered[index], ordered[index+delta]] = [ordered[index+delta], ordered[index]]; return { ...d, edges: d.edges.map(e => { const order = ordered.findIndex(o => o.id === e.id); return order < 0 ? e : { ...e, inputOrder: order }; }) }; });
      return <div key={edge.id} className="incoming-row"><small>输入 {index+1} · {edge.targetHandle === 'text-in' ? '文字' : '图片'}</small>{edge.targetHandle === 'text-in' ? <p>{nodeText(doc,source,edge.sourceHandle) || '上游文字为空'}</p> : <MediaPreview key={assetId} id={assetId} />}<button className="icon-button" aria-label={`上移输入 ${index+1}`} disabled={index === 0} onClick={() => move(-1)}><ArrowUp size={13} /></button><button className="icon-button" aria-label={`下移输入 ${index+1}`} disabled={index === incoming.length-1} onClick={() => move(1)}><ArrowDown size={13} /></button></div>;
    })}</div>}
  </div>;
}
