import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.resolve(process.env.STUDIO_DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.PORT ?? 4311);
async function present(name) { try { await access(path.join(root, name)); return true; } catch { return false; } }
async function writable(dir) { try { await access(dir, constants.W_OK); return '权限检查通过'; } catch { try { await access(path.dirname(dir), constants.W_OK); return '目录尚不存在，父目录权限检查通过'; } catch { return '权限检查未通过'; } } }
async function listening(port) { return new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.setTimeout(1000); socket.once('connect', () => { socket.destroy(); resolve(true); }); for (const event of ['error', 'timeout']) socket.once(event, () => { socket.destroy(); resolve(false); }); }); }
async function size(dir) {
  let bytes = 0, files = 0;
  try { for (const entry of await readdir(dir, { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; const file = path.join(dir, entry.name); if (entry.isDirectory()) { const nested = await size(file); bytes += nested.bytes; files += nested.files; } else if (entry.isFile()) { bytes += (await stat(file)).size; files++; } } } catch { /* No files are modified. */ }
  return { bytes, files };
}
let health = null;
try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) health = await r.json(); } catch { /* Offline check. */ }
const fallback = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd');
const manager = process.platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/c', 'pnpm.cmd --version'], { encoding: 'utf8', windowsHide: true }) : spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
let pnpm = manager.status === 0 ? manager.stdout.trim() : null;
if (!pnpm && process.platform === 'win32') { const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${fallback}" --version"`], { encoding: 'utf8', windowsHide: true }); if (r.status === 0) pnpm = r.stdout.trim(); }
const files = {};
for (const file of ['package.json', 'pnpm-lock.yaml', 'apps/web/index.html', 'config/video-profile.example.json']) files[file] = await present(file);
console.log(JSON.stringify({ node: process.version, nodeSupported: /^v24\./.test(process.version) && Number(process.versions.node.split('.')[1]) >= 14, pnpm, requiredPnpm: '11.19.0', pnpmMatches: pnpm === '11.19.0', files,
  dataWritable: await writable(data), ports: { [4310]: await listening(4310), [port]: await listening(port) }, api: health,
  space: { media: await size(path.join(data, 'media')), exports: await size(path.join(data, 'exports')), optimizationBackup: await size(path.join(root, 'output/optimization/stopped-data')) },
  note: '仅检查文件、权限、端口和健康状态；未读取 .env、写入配置、启动进程、调用生成或删除文件。' }, null, 2));
