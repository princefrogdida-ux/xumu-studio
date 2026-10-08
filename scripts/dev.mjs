import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) loadEnvFile(path.join(root, '.env'));
const children = new Set();
let stopping = false, forceTimer, progressTimer;
function finish() {
  if (!stopping || children.size) return;
  clearTimeout(forceTimer); clearInterval(progressTimer);
  process.stdin.pause();
  if (process.connected) process.disconnect();
  console.log(process.exitCode ? '开发服务已停止，请检查上面的异常记录' : '全部开发服务正常停止');
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  console.log('正在停止：等待 API 打包、worker 当前步骤和 Vite 收尾…');
  for (const child of children) if (child.connected) child.send('shutdown', error => { if (error) console.error('停止信号未送达，等待进程退出或超时处理'); });
  progressTimer = setInterval(() => console.log(`仍在等待 ${children.size} 个本项目子进程收尾…`), 10000);
  forceTimer = setTimeout(() => {
    process.exitCode = 1;
    console.error('收尾超过 60 秒，强制停止本次启动的剩余子进程；可能遗留待确认任务，重启后先检查状态。');
    for (const child of children) child.kill();
  }, 60000);
  finish();
}
for (const args of [
  ['--import', 'tsx', 'apps/server/src/index.ts'],
  ['--import', 'tsx', 'apps/server/src/worker/index.ts'],
  ['scripts/vite.mjs'],
]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  children.add(child);
  child.on('error', () => { console.error('开发子进程启动失败'); children.delete(child); stop(1); finish(); });
  child.on('exit', (code) => { children.delete(child); if (!stopping) stop(code || 1); else if (code) process.exitCode = 1; finish(); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('message', value => { if (value === 'shutdown') stop(); });
process.on('disconnect', () => stop());
process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { if (value.trim() === 'stop') stop(); });
