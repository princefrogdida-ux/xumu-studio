import { memo } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { FileText, UserRound, MapPin, StickyNote, MoreHorizontal } from 'lucide-react';
import type { TextData } from '../../../../../packages/shared/src/index.ts';
import { useEditor } from './editor-store.ts';

export type FlowNode = Node<TextData, 'text'>;
const icons = { script: FileText, character: UserRound, scene: MapPin, note: StickyNote };
const names = { script: '剧本构思', character: '角色设定', scene: '场景设定', note: '文本卡片' };

export const TextNode = memo(function TextNode({ id, data, selected }: NodeProps<FlowNode>) {
  const Icon = icons[data.category];
  return <article className={`studio-node ${data.category} ${selected ? 'is-selected' : ''}`}>
    <NodeResizer isVisible={!!selected} minWidth={220} minHeight={170} maxWidth={1200} maxHeight={1200}
      onResizeStart={() => useEditor.getState().begin()} onResizeEnd={() => useEditor.getState().end()} />
    <div className="node-handle-bar"><span className="node-type"><Icon size={14} />{names[data.category]}</span><MoreHorizontal size={17} /></div>
    <div className="node-content"><h3>{data.title || '未命名卡片'}</h3>
      <p>{data.content || '选中卡片，在右侧写下你的想法…'}</p></div>
    <div className="node-footer"><span className="node-dot" />文本构思<span className="node-output">文字引用</span></div>
    <Handle type="target" id="text-in" position={Position.Left} aria-label="文字输入" />
    <Handle type="source" id="text-out" position={Position.Right} aria-label="文字输出" />
  </article>;
});
