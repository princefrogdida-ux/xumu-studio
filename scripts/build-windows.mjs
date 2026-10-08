import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64 with Node 24.14.x.');
if (process.version !== 'v24.14.0') throw new Error('This release requires exactly Node.js 24.14.0.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = path.join(root, 'output/releases', 'build-' + Date.now());
const payload = path.join(runRoot, 'XumuStudio');
mkdirSync(payload, { recursive: true });
const require = createRequire(path.join(root, 'package.json'));
const { transform } = require('./node_modules/.pnpm/node_modules/esbuild');
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
for (const folder of ['apps/server/src', 'packages/shared/src']) {
  for (const file of files(path.join(root, folder))) {
    const relative = path.relative(root, file);
    const dest = path.join(payload, relative.replace(/\.ts$/, '.js'));
    mkdirSync(path.dirname(dest), { recursive: true });
    if (file.endsWith('.ts')) {
      const result = await transform(readFileSync(file, 'utf8'), { loader: 'ts', format: 'esm', target: 'node24' });
      writeFileSync(dest, result.code.replace(/(from\s+["'][^"']+|import\s*\(["'][^"']+)\.ts(["'])/g, '$1.js$2'));
    } else cpSync(file, dest);
  }
}
cpSync(path.join(root, 'dist/web'), path.join(payload, 'dist/web'), { recursive: true });
cpSync(path.join(root, 'scripts/release/launcher.mjs'), path.join(payload, 'launcher.mjs'));
cpSync(path.join(root, 'scripts/release/Start-Xumu-Studio.cmd'), path.join(payload, 'Start-Xumu-Studio.cmd'));
mkdirSync(path.join(payload, 'runtime')); cpSync(process.execPath, path.join(payload, 'runtime/node.exe'));
cpSync(path.join(root, 'output/release-tools/node-LICENSE.txt'), path.join(payload, 'runtime/LICENSE.txt'));
cpSync(path.join(root, 'config/video-profile.example.json'), path.join(payload, 'video-profile.example.json'));
cpSync(path.join(root, '.env.example'), path.join(payload, 'configuration.example.env'));
cpSync(path.join(root, 'THIRD_PARTY.md'), path.join(payload, 'THIRD_PARTY.md'));
const nativeLicenseRoot = path.join(root, 'output/release-tools/libvips-dev');
const nativeLicenseFiles = files(nativeLicenseRoot).filter(file => /[\\/]vips-dev-8\.18[\\/](LICENSE|README\.md|versions\.json|THIRD-PARTY-NOTICES\.md|GPL-3\.0\.txt|LGPL-3\.0\.txt)$/.test(file));
if (nativeLicenseFiles.length !== 6) throw new Error('Prepare official libvips notices and complete GPL/LGPL texts before building.');
for (const file of nativeLicenseFiles) {
  const relative = path.basename(file);
  const dest = path.join(payload, 'licenses/libvips', relative);
  mkdirSync(path.dirname(dest), { recursive: true }); cpSync(file, dest);
}
writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: 'xumu-studio-runtime', version: '0.1.0', type: 'module', private: true }, null, 2));

// Copy only the backend's resolved production dependency closure, as real directories.
// No pnpm symlinks, development tooling, browser packages or local configuration are shipped.
const copied = new Set();
const topVersions = new Map();
const licenses = [];
function resolvePackage(name, parent) {
  const resolver = createRequire(path.join(parent, 'package.json'));
  let entry;
  for (const suffix of ['/package.json', '/package', '']) { try { entry = resolver.resolve(name + suffix); break; } catch {} }
  if (!entry) throw new Error('Cannot resolve dependency: ' + name);
  let dir = path.dirname(realpathSync(entry));
  while (dir !== path.dirname(dir)) {
    const meta = path.join(dir, 'package.json');
    if (existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).name === name) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Missing dependency metadata: ' + name);
}
function copyPackage(name, parent, consumer = payload) {
  const source = resolvePackage(name, parent);
  const metadata = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  const topVersion = topVersions.get(name);
  const target = path.join(topVersion && topVersion !== metadata.version ? consumer : payload, 'node_modules', name);
  if (copied.has(target)) return;
  copied.add(target);
  if (!topVersion) topVersions.set(name, metadata.version);
  cpSync(source, target, { recursive: true, dereference: true, filter: file => path.basename(file) !== 'node_modules' });
  licenses.push({ name, version: metadata.version, license: metadata.license ?? 'SEE PACKAGE LICENSE', repository: metadata.repository ?? null });
  for (const dependency of Object.keys(metadata.dependencies ?? {})) copyPackage(dependency, source, target);
  for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
    try { resolvePackage(dependency, source); } catch { continue; }
    copyPackage(dependency, source, target);
  }
}
for (const dependency of ['fastify', 'sharp', 'yazl', 'zod']) copyPackage(dependency, root);
writeFileSync(path.join(payload, 'THIRD_PARTY_NOTICES.json'), JSON.stringify({ runtime: 'Node.js 24.14.0; complete license in runtime/LICENSE.txt', packages: licenses, installer: { name: 'Inno Setup', version: '6.7.3', url: 'https://jrsoftware.org', license: 'Inno Setup License' }, mockVideo: { source: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', license: 'CC0', note: 'Local simulation fixture; no AI generation' } }, null, 2));
writeFileSync(path.join(payload, 'INSTALLATION.txt'), 'Xumu Studio 0.1.0 - Windows x64\r\n\r\nDouble-click Start-Xumu-Studio.cmd after installation. Node and production dependencies are included.\r\nThe application opens in your browser; the console runs API and worker. Type stop and press Enter to stop safely.\r\nData and private configuration are stored in %LOCALAPPDATA%\\XumuStudio. Uninstall and upgrades preserve this directory.\r\nThe package contains no developer projects, credentials or task history. Real generation is disabled by default.\r\nTo configure services, copy configuration.example.env to %LOCALAPPDATA%\\XumuStudio\\.env and edit it locally. Never publish your keys.\r\nThe first release is unsigned. Check SHA256SUMS.txt from the release page before running it.\r\nSource: https://github.com/princefrogdida-ux/xumu-studio\r\nInstaller built with Inno Setup (https://jrsoftware.org). Runtime/dependency license files are included.\r\n');
const manifest = files(payload).map(file => ({ path: path.relative(payload, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }));
writeFileSync(path.join(payload, 'package-manifest.json'), JSON.stringify({ version: '0.1.0', platform: 'win32-x64', files: manifest }, null, 2));
const compiler = process.env.XUMU_ISCC ?? path.join(root, 'output/release-tools/inno/ISCC.exe');
const result = spawnSync(compiler, ['/Qp', '/DPayloadDir=' + payload, '/DReleaseDir=' + runRoot, path.join(root, 'scripts/release/setup.iss')], { cwd: root, windowsHide: true, encoding: 'utf8' });
writeFileSync(path.join(runRoot, 'build.log'), (result.stdout ?? '') + (result.stderr ?? ''));
if (result.status !== 0) throw new Error('Installer compilation failed: see ' + path.join(runRoot, 'build.log'));
const setup = path.join(runRoot, 'Xumu-Studio-0.1.0-Windows-x64-Setup.exe');
const sha = createHash('sha256').update(readFileSync(setup)).digest('hex');
writeFileSync(path.join(runRoot, 'SHA256SUMS.txt'), `${sha}  ${path.basename(setup)}\n`);
writeFileSync(path.join(runRoot, 'build-result.json'), JSON.stringify({ at: new Date().toISOString(), version: '0.1.0', node: process.version, payload, setup, sha256: sha, runtimeDependencies: licenses.length, payloadFiles: manifest.length, copiedUserData: false, copiedSecrets: false, signed: false }, null, 2));
console.log(JSON.stringify({ runRoot, setup, sha256: sha }));
