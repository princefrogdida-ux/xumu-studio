import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const root = path.dirname(fileURLToPath(import.meta.url));
const userRoot = path.resolve(process.env.XUMU_USER_DIR ?? path.join(process.env.LOCALAPPDATA ?? root, 'XumuStudio'));
mkdirSync(userRoot, { recursive: true });
const configuration = path.join(userRoot, '.env');
if (existsSync(configuration)) loadEnvFile(configuration);
process.env.STUDIO_DATA_DIR = path.join(userRoot, 'data');
process.env.PORT = process.env.XUMU_PORT ?? process.env.PORT ?? '4311';
process.env.STUDIO_REAL_CALLS_ENABLED ??= 'false';
process.chdir(root);
const children = new Set();
let stopping = false, forceTimer;
function finish() {
  if (!stopping || children.size) return;
  clearTimeout(forceTimer);
  process.stdin.pause();
  if (process.connected) process.disconnect();
  console.log(process.exitCode ? 'Xumu Studio stopped with an error. Keep your data and check configuration.' : 'Xumu Studio stopped normally. Your data is preserved.');
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  console.log('Waiting for API and worker to finish...');
  for (const child of children) if (child.connected) child.send('shutdown', () => {});
  forceTimer = setTimeout(() => { process.exitCode = 1; console.error('Shutdown timeout: forcing only this launcher\'s children. Check tasks after restarting.'); for (const child of children) child.kill(); }, 60000);
  finish();
}
// Check before starting the worker: a port conflict must not touch data or an existing app.
const { createServer } = await import('node:net');
const probe = createServer();
try {
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(Number(process.env.PORT), '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
} catch { console.error(`Port ${process.env.PORT} is unavailable. Stop the other app or configure a different PORT in ${configuration}.`); process.exit(1); }
for (const entry of ['apps/server/src/index.js', 'apps/server/src/worker/index.js']) {
  const child = spawn(process.execPath, [entry], { cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  children.add(child);
  child.on('error', () => { children.delete(child); stop(1); finish(); });
  child.on('exit', code => { children.delete(child); if (!stopping) stop(code || 1); else if (code) process.exitCode = 1; finish(); });
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
process.on('message', value => { if (value === 'shutdown') stop(); });
process.on('disconnect', () => stop());
process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { if (value.trim() === 'stop') stop(); });
const url = `http://127.0.0.1:${process.env.PORT}/`;
for (let i = 0; i < 100 && !stopping; i++) {
  try {
    const response = await fetch(url + 'api/health', { signal: AbortSignal.timeout(1000) });
    if (response.ok && (await response.json()).worker.status === 'online') {
      console.log(`Ready: ${url}\nData: ${userRoot}\nType stop and press Enter to stop safely. Closing the browser does not stop the app.`);
      if (process.env.XUMU_NO_BROWSER !== '1') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' }).on('error', () => console.log('Open the above address in your browser.'));
      break;
    }
  } catch { /* Startup is bounded below. */ }
  if (i === 99) stop(1);
  else await new Promise(resolve => setTimeout(resolve, 100));
}
