import { useState } from 'react';
import { useEditor } from '../canvas/editor-store.ts';
import { useAssets } from './asset-store.ts';
import { affectedReferences, replaceMissingAsset } from '../../../../../packages/shared/src/production.ts';
import { request } from '../../lib/api.ts';
import type { Asset } from '../../../../../packages/shared/src/index.ts';

export function AssetRepair({ notify }: { notify: (message: string) => void }) {
  const doc = useEditor(s => s.inputDoc), projectId = useEditor(s => s.projectId), assets = useAssets(s => s.assets);
  const [choices, setChoices] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false);
  const missing = assets.filter(a => a.status !== 'ready' && affectedReferences(doc, a.id).length);
  if (!missing.length) return null;
  return <details className="export-check" open><summary>恢复当前引用：{missing.length} 个缺失或损坏素材</summary><p>先上传替代文件，再选择映射。应用只改当前项目的引用，可撤销；旧任务和历史来源保留。</p>{missing.map(old => {
    const affected = affectedReferences(doc, old.id), replacement = assets.find(a => a.id === choices[old.id]);
    return <article className="repair-row" key={old.id}><strong>{old.name} · {old.mediaType === 'image' ? '图片' : '视频'}</strong><small>原 SHA-256：{old.checksum}</small><ul>{affected.map((item, i) => <li key={i}>{item}</li>)}</ul>
      <label>替代素材<select aria-label={`替代素材 ${old.name}`} value={choices[old.id] ?? ''} disabled={busy} onChange={e => setChoices(s => ({ ...s, [old.id]: e.target.value }))}><option value="">选择已上传的同类型素材</option>{assets.filter(a => a.status === 'ready' && a.mediaType === old.mediaType).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {replacement && <p>{replacement.checksum === old.checksum ? '内容校验值相同，将重连当前引用。' : '校验值不同，这是替代素材；将清除受影响节点的历史选择 ID，按替代文件实际来源展示。'}</p>}
      <button className="secondary" disabled={busy || !replacement} onClick={() => void (async () => {
        setBusy(true); try {
          const verified = await request<Asset>(`/api/projects/${projectId}/assets/${replacement!.id}?verify=1`);
          if (verified.status !== 'ready') throw new Error('替代素材完整性校验失败，请重新上传');
          if (useEditor.getState().projectId !== projectId) return;
          useEditor.getState().update(d => replaceMissingAsset(d, old, verified));
          notify(`已映射 ${affected.length} 处当前引用，可撤销；等待保存完成。`);
        } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
      })()}>应用映射（可撤销）</button></article>;
  })}</details>;
}
