import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('Cannot enumerate publishable files');
const files = [...new Set(result.stdout.split('\0').filter(Boolean))];
const findings = [], brokenLinks = [];
for (const file of files) {
  if (/^(data|output|dist|node_modules|\.pnpm-store)\//.test(file) || /(^|\/)\.env($|\.)/.test(file) && file !== '.env.example' || /\.(sqlite|db|pem|key|pfx)$/i.test(file)) findings.push({ file, kind: 'private-file' });
  if (!existsSync(file) || statSync(file).size > 2_000_000 || /\.(mp4|png|jpg|webp|ico)$/i.test(file)) continue;
  const content = readFileSync(file, 'utf8');
  content.split(/\r?\n/).forEach((line, index) => {
    for (const [kind, regex] of [['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/], ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/], ['aws-key', /\bAKIA[A-Z0-9]{16}\b/], ['provider-token', /\bsk-[A-Za-z0-9_-]{25,}\b/]]) if (regex.test(line)) findings.push({ file, line: index + 1, kind });
    if (file === '.env.example' && /^STUDIO_.*API_KEY=\S/.test(line)) findings.push({ file, line: index + 1, kind: 'nonempty-example-key' });
  });
  if (file.endsWith('.md')) for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!existsSync(resolved)) brokenLinks.push({ file, target });
  }
}
const report = { checkedFiles: files.length, findings, brokenLinks, privateOutputsExcluded: !files.some(f => /^(data|output|dist|node_modules)\//.test(f)) };
mkdirSync('output/release-tools', { recursive: true });
writeFileSync('output/release-tools/publication-check.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (findings.length || brokenLinks.length) process.exitCode = 1;
