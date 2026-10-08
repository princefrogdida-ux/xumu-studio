import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root = process.cwd(), target = path.join(root, `output/optimization/clean-install-${Date.now()}`);
await mkdir(target); // A repeated run must use a new directory; never overwrite an earlier report.
async function copy(relative) {
  const source = path.join(root, relative), destination = path.join(target, relative);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', 'dist'].includes(entry.name) || /\.local\.json$/.test(entry.name)) continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) await copy(next); else if (entry.isFile()) await copyFile(path.join(root, next), path.join(target, next));
  }
}
for (const directory of ['apps', 'packages', 'scripts', 'tests', 'config']) await copy(directory);
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.env.example', '.gitignore', 'README.md']) await copyFile(path.join(root, file), path.join(target, file));
const log = [], started = Date.now();
const cli = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs');
const args = [cli, '--config.store-dir='+path.join(target,'.bootstrap-store'), '--config.cache-dir='+path.join(target,'.bootstrap-cache'), 'dlx', 'pnpm@11.19.0', 'install', '--frozen-lockfile', '--store-dir', '.clean-store'];
const cmd = 'isolated pnpm dlx pnpm@11.19.0 install --frozen-lockfile --store-dir .clean-store';
const child = spawn(process.execPath, args, { cwd: target, windowsHide: true, env: { ...process.env, pnpm_config_pm_on_fail: 'error' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const output of [child.stdout, child.stderr]) output.on('data', bytes => { const text = bytes.toString(); log.push(text); process.stdout.write(text); });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; console.error('干净安装超过 60 秒；停止本次创建的安装进程树，保留日志。'); spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }, 60000);
const code = await new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(-1)); });
clearTimeout(timer);
await writeFile(path.join(target, 'install.log'), log.join(''));
await writeFile(path.join(target, 'result.json'), JSON.stringify({ node: process.version, requiredPnpm: '11.19.0', command: cmd, exitCode: code, timedOut, elapsedMs: Date.now() - started, copiedDependencies: false, copiedData: false, copiedEnv: false }, null, 2));
console.log(JSON.stringify({ directory: target, exitCode: code, timedOut, elapsedMs: Date.now() - started }));
process.exitCode = code === 0 && !timedOut ? 0 : 1;
