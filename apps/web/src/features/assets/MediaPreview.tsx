import { useState } from 'react';
import { Play, ImageOff } from 'lucide-react';
import { useAssets } from './asset-store.ts';

export function MediaPreview({ id, playable = false }: { id?: string | null; playable?: boolean }) {
  const asset = useAssets(s => s.assets.find(a => a.id === id));
  const [playing, setPlaying] = useState(false);
  if (!id) return <div className="media-placeholder">尚未选择参考图片</div>;
  if (!asset || asset.status !== 'ready') return <div className="media-placeholder media-error"><ImageOff size={24} /><span>{asset?.status === 'missing' ? '素材文件缺失' : '素材不可用或无法解码'}</span><small>{asset?.name ?? id}</small></div>;
  if (asset.mediaType === 'image') return <img className="media-preview" loading="lazy" src={`/api/assets/${id}/thumbnail`} alt={asset.name} onError={() => useAssets.getState().fail(id)} />;
  if (playable && playing) return <video className="media-preview nodrag nowheel" controls autoPlay preload="metadata" src={`/api/assets/${id}/file`} onError={() => useAssets.getState().fail(id)} />;
  return <button className="video-cover nodrag" disabled={!playable} onClick={() => setPlaying(true)} aria-label={`播放 ${asset.name}`}><Play size={28} /><span>{playable ? '点击播放' : '视频素材'}</span><small>{asset.name}</small></button>;
}
