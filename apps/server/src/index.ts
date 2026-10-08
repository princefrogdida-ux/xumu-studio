import path from 'node:path';
import { ProjectStore } from './db/store.ts';
import { createApp } from './api/app.ts';
import { runtimeInfo } from '../../../packages/shared/src/runtime.ts';

const dataDir = path.resolve(process.env.STUDIO_DATA_DIR ?? 'data');
const store = new ProjectStore(path.join(dataDir, 'studio.sqlite'));
const app = createApp(store, path.resolve('dist/web'), path.join(dataDir, 'media'));
try {
  const address = await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4311) });
  console.log(`短剧画布 API: ${address} · 本地 SQLite · ${runtimeInfo.stage} / 默认模拟`);
} catch { console.error(`API 无法启动，请检查端口 ${process.env.PORT ?? 4311} 是否被占用及数据目录权限。`); store.close(); process.exit(1); }
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await app.close(); store.close(); console.log('API 打包与数据库已正常收尾'); if (process.connected) process.disconnect(); }
  catch { console.error('API 收尾失败，请保留数据并检查'); process.exitCode = 1; if (process.connected) process.disconnect(); }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
process.on('message', message => { if (message === 'shutdown') void shutdown(); });
process.on('disconnect', () => void shutdown());
