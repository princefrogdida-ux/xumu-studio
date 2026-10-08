import { useEffect, useState } from 'react';
import { request } from '../../lib/api.ts';
import { runtimeInfo } from '../../../../../packages/shared/src/runtime.ts';

interface Health { worker: { status: string; lastSeen: string | null }; activeTasks: number; realCallsEnabled: boolean; databaseVersion: number; schemaVersion: number; invalidExportRecords: number; now: string }
export function LocalHealth() {
  const [value, setValue] = useState<Health | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => { try { const v = await request<Health>('/api/health'); if (live) { setValue(v); setError(''); } } catch { if (live) setError('API 暂时不可达'); } finally { if (live) timer = setTimeout(() => void read(), document.hidden ? 30000 : 10000); } };
    void read(); return () => { live = false; clearTimeout(timer); };
  }, []);
  return <details className="local-health"><summary>{error || (value?.worker.status === 'online' ? 'API / worker 在线' : 'API 可达 · worker 暂未收到心跳')}</summary>
    <small>应用 {runtimeInfo.applicationVersion} · 方案 {runtimeInfo.planVersion} · {runtimeInfo.stage}</small>
    {value && <><p>数据库 {value.databaseVersion} / 文档 {value.schemaVersion} · 活动任务 {value.activeTasks}</p><p>worker：{value.worker.status === 'online' ? '最近心跳正常' : value.worker.status === 'stopped' ? '已停止，请启动 worker' : '暂未收到心跳；排队任务请检查 worker'}</p><small>最近心跳：{value.worker.lastSeen ? new Date(value.worker.lastSeen).toLocaleString('zh-CN') : '尚未收到'}<br/>检查时间：{new Date(value.now).toLocaleString('zh-CN')}</small><p>真实调用：{value.realCallsEnabled ? '已开启' : '关闭'} · 无效导出记录 {value.invalidExportRecords}（保留原文件）</p></>}
  </details>;
}
