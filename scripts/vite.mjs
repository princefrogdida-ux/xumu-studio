import { createServer } from 'vite';
const server = await createServer({ configFile: 'apps/web/vite.config.ts' });
await server.listen(); server.printUrls();
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await server.close();
  console.log('Vite 已正常停止');
  if (process.connected) process.disconnect();
}
process.on('message', value => { if (value === 'shutdown') void stop(); });
process.on('disconnect', () => void stop());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
